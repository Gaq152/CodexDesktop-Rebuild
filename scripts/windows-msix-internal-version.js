const fs = require("node:fs");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const yauzl = require("yauzl");

const APP_ASAR_ENTRY = "app/resources/app.asar";
const MAX_ASAR_PREFIX_BYTES = 64 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

function validateWindowsInternalAppVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) {
    throw new Error(`Windows internal app version must be numeric X.Y.Z: ${version || "missing"}`);
  }
  return String(version);
}

function packageJsonEntryFromAsarHeader(header) {
  const entry = header?.files?.["package.json"];
  if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size)) {
    throw new Error("Windows app.asar does not contain a packed package.json");
  }
  const offset = Number(entry.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || entry.size < 1) {
    throw new Error("Windows app.asar package.json has invalid offset or size");
  }
  return { offset, size: entry.size };
}

function parseAsarHeader(prefix) {
  if (prefix.length < 8) return null;
  const headerSize = prefix.readUInt32LE(4);
  if (!Number.isSafeInteger(headerSize) || headerSize < 8 || headerSize > MAX_ASAR_PREFIX_BYTES) {
    throw new Error(`Windows app.asar header size is invalid: ${headerSize}`);
  }
  if (prefix.length < 8 + headerSize) return { headerSize };

  const headerPickle = prefix.subarray(8, 8 + headerSize);
  if (headerPickle.length < 8) throw new Error("Windows app.asar header pickle is truncated");
  const jsonSize = headerPickle.readUInt32LE(4);
  if (jsonSize < 2 || 8 + jsonSize > headerPickle.length) {
    throw new Error("Windows app.asar JSON header is truncated");
  }
  const header = JSON.parse(headerPickle.subarray(8, 8 + jsonSize).toString("utf8"));
  const packageEntry = packageJsonEntryFromAsarHeader(header);
  return {
    headerSize,
    packageStart: 8 + headerSize + packageEntry.offset,
    packageSize: packageEntry.size,
  };
}

async function readInternalAppVersionFromAsarStream(stream) {
  const chunks = [];
  let total = 0;
  let layout = null;
  let headerSize = null;

  for await (const chunkValue of stream) {
    const chunk = Buffer.from(chunkValue);
    chunks.push(chunk);
    total += chunk.length;
    if (total > MAX_ASAR_PREFIX_BYTES) {
      throw new Error("Windows app.asar package.json is too deep in the archive");
    }

    if (headerSize == null && total >= 8) {
      headerSize = Buffer.concat(chunks, total).readUInt32LE(4);
      if (!Number.isSafeInteger(headerSize) || headerSize < 8 || headerSize > MAX_ASAR_PREFIX_BYTES) {
        throw new Error(`Windows app.asar header size is invalid: ${headerSize}`);
      }
    }
    if (!layout?.packageStart && headerSize != null && total >= 8 + headerSize) {
      layout = parseAsarHeader(Buffer.concat(chunks, total));
    }
    if (!layout?.packageStart) continue;

    const packageEnd = layout.packageStart + layout.packageSize;
    if (packageEnd > MAX_ASAR_PREFIX_BYTES) {
      throw new Error("Windows app.asar package.json exceeds the inspection limit");
    }
    if (total < packageEnd) continue;

    const prefix = Buffer.concat(chunks, total);
    const packageJson = JSON.parse(
      prefix.subarray(layout.packageStart, packageEnd).toString("utf8"),
    );
    return validateWindowsInternalAppVersion(packageJson.version);
  }

  throw new Error("Windows app.asar ended before package.json could be read");
}

function openMsix(msixPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(msixPath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function findZipEntry(zip, expectedName) {
  return new Promise((resolve, reject) => {
    const normalizedExpected = expectedName.toLowerCase();
    zip.on("entry", (entry) => {
      const normalized = entry.fileName.replaceAll("\\", "/").toLowerCase();
      if (normalized === normalizedExpected) resolve(entry);
      else zip.readEntry();
    });
    zip.on("end", () => reject(new Error(`${expectedName} was not found in the Windows MSIX`)));
    zip.on("error", reject);
    zip.readEntry();
  });
}

function openZipEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function readWindowsInternalAppVersionFromMsix(msixPath) {
  if (!fs.existsSync(msixPath)) throw new Error(`Windows MSIX was not found: ${msixPath}`);
  const zip = await openMsix(msixPath);
  const entry = await findZipEntry(zip, APP_ASAR_ENTRY);
  const stream = await openZipEntry(zip, entry);
  return readInternalAppVersionFromAsarStream(stream);
}

async function fetchRange(url, start, endExclusive, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${start}-${endExclusive - 1}` },
    redirect: "follow",
  });
  if (response.status !== 206) {
    response.body?.cancel?.().catch?.(() => {});
    throw new Error(`Windows MSIX range request failed: HTTP ${response.status}`);
  }
  return response;
}

async function fetchRangeBuffer(url, start, endExclusive, fetchImpl) {
  const response = await fetchRange(url, start, endExclusive, fetchImpl);
  return Buffer.from(await response.arrayBuffer());
}

function findEndOfCentralDirectory(tail) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (
      tail.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
    ) return offset;
  }
  throw new Error("Windows MSIX ZIP end-of-central-directory record was not found");
}

function zip64ExtraValues(extra, fields) {
  for (let offset = 0; offset + 4 <= extra.length;) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const data = extra.subarray(offset + 4, offset + 4 + size);
    if (data.length !== size) break;
    if (id === 0x0001) {
      let cursor = 0;
      const result = {};
      for (const field of fields) {
        if (!field.required) continue;
        if (cursor + 8 > data.length) throw new Error("Windows MSIX ZIP64 extra field is truncated");
        result[field.name] = Number(data.readBigUInt64LE(cursor));
        cursor += 8;
      }
      return result;
    }
    offset += 4 + size;
  }
  return {};
}

function parseCentralDirectoryEntry(directory, offset) {
  if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) {
    return null;
  }
  const fileNameLength = directory.readUInt16LE(offset + 28);
  const extraLength = directory.readUInt16LE(offset + 30);
  const commentLength = directory.readUInt16LE(offset + 32);
  const end = offset + 46 + fileNameLength + extraLength + commentLength;
  if (end > directory.length) throw new Error("Windows MSIX central directory entry is truncated");

  const fileName = directory.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
  let compressedSize = directory.readUInt32LE(offset + 20);
  let uncompressedSize = directory.readUInt32LE(offset + 24);
  let localHeaderOffset = directory.readUInt32LE(offset + 42);
  const extra = directory.subarray(offset + 46 + fileNameLength, offset + 46 + fileNameLength + extraLength);
  const zip64 = zip64ExtraValues(extra, [
    { name: "uncompressedSize", required: uncompressedSize === 0xffffffff },
    { name: "compressedSize", required: compressedSize === 0xffffffff },
    { name: "localHeaderOffset", required: localHeaderOffset === 0xffffffff },
  ]);
  if (uncompressedSize === 0xffffffff) uncompressedSize = zip64.uncompressedSize;
  if (compressedSize === 0xffffffff) compressedSize = zip64.compressedSize;
  if (localHeaderOffset === 0xffffffff) localHeaderOffset = zip64.localHeaderOffset;

  for (const [name, value] of Object.entries({ compressedSize, uncompressedSize, localHeaderOffset })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Windows MSIX ${name} is invalid`);
    }
  }
  return {
    nextOffset: end,
    fileName,
    compressionMethod: directory.readUInt16LE(offset + 10),
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
  };
}

async function readCentralDirectoryLocation(url, size, fetchImpl) {
  const tailSize = Math.min(size, 65_557);
  const tailStart = size - tailSize;
  const tail = await fetchRangeBuffer(url, tailStart, size, fetchImpl);
  const eocdOffset = findEndOfCentralDirectory(tail);
  let directorySize = tail.readUInt32LE(eocdOffset + 12);
  let directoryOffset = tail.readUInt32LE(eocdOffset + 16);

  if (directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    if (eocdOffset < 20 || tail.readUInt32LE(eocdOffset - 20) !== 0x07064b50) {
      throw new Error("Windows MSIX ZIP64 locator was not found");
    }
    const zip64Offset = Number(tail.readBigUInt64LE(eocdOffset - 12));
    const zip64 = await fetchRangeBuffer(url, zip64Offset, zip64Offset + 56, fetchImpl);
    if (zip64.readUInt32LE(0) !== 0x06064b50) {
      throw new Error("Windows MSIX ZIP64 end-of-central-directory record was not found");
    }
    directorySize = Number(zip64.readBigUInt64LE(40));
    directoryOffset = Number(zip64.readBigUInt64LE(48));
  }

  if (
    !Number.isSafeInteger(directorySize) ||
    !Number.isSafeInteger(directoryOffset) ||
    directorySize < 1 ||
    directorySize > MAX_CENTRAL_DIRECTORY_BYTES ||
    directoryOffset < 0 ||
    directoryOffset + directorySize > size
  ) {
    throw new Error("Windows MSIX central directory location is invalid");
  }
  return { directoryOffset, directorySize };
}

async function findRemoteZipEntry(url, size, expectedName, fetchImpl) {
  const { directoryOffset, directorySize } = await readCentralDirectoryLocation(
    url,
    size,
    fetchImpl,
  );
  const directory = await fetchRangeBuffer(
    url,
    directoryOffset,
    directoryOffset + directorySize,
    fetchImpl,
  );
  const normalizedExpected = expectedName.toLowerCase();
  for (let offset = 0; offset < directory.length;) {
    const entry = parseCentralDirectoryEntry(directory, offset);
    if (!entry) break;
    if (entry.fileName.replaceAll("\\", "/").toLowerCase() === normalizedExpected) return entry;
    offset = entry.nextOffset;
  }
  throw new Error(`${expectedName} was not found in the Windows MSIX`);
}

async function readWindowsInternalAppVersionFromRemoteMsix({
  url,
  size,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required to inspect the Windows MSIX");
  if (!url || !Number.isSafeInteger(size) || size < 1) {
    throw new Error("Windows MSIX URL and byte size are required");
  }
  const entry = await findRemoteZipEntry(url, size, APP_ASAR_ENTRY, fetchImpl);
  const localHeader = await fetchRangeBuffer(
    url,
    entry.localHeaderOffset,
    entry.localHeaderOffset + 30,
    fetchImpl,
  );
  if (localHeader.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Windows MSIX app.asar local ZIP header was not found");
  }
  const fileNameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const response = await fetchRange(url, dataStart, dataStart + entry.compressedSize, fetchImpl);
  let stream = Readable.fromWeb(response.body);
  if (entry.compressionMethod === 8) stream = stream.pipe(zlib.createInflateRaw());
  else if (entry.compressionMethod !== 0) {
    stream.destroy();
    throw new Error(`Unsupported Windows MSIX app.asar compression method: ${entry.compressionMethod}`);
  }
  return readInternalAppVersionFromAsarStream(stream);
}

module.exports = {
  APP_ASAR_ENTRY,
  parseAsarHeader,
  parseCentralDirectoryEntry,
  readInternalAppVersionFromAsarStream,
  readWindowsInternalAppVersionFromMsix,
  readWindowsInternalAppVersionFromRemoteMsix,
  validateWindowsInternalAppVersion,
};
