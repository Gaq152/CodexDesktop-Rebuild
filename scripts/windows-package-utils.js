function parseWindowsPackageName(name) {
  const match = String(name || "").match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_(x64|arm64)__.*\.msix$/i);
  if (!match) return null;
  return {
    version: match[1],
    arch: match[2].toLowerCase(),
  };
}

function compareVersions(a, b) {
  const left = String(a || "").split(".").map(Number);
  const right = String(b || "").split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function selectWindowsMsixPackage(packages, arch = "x64") {
  const normalizedArch = String(arch || "x64").toLowerCase();
  const candidates = packages
    .map((pkg) => ({ ...pkg, parsed: parseWindowsPackageName(pkg.name) }))
    .filter((pkg) => pkg.parsed?.arch === normalizedArch)
    .sort((a, b) => compareVersions(b.parsed.version, a.parsed.version));

  if (candidates.length === 0) {
    const names = packages.map((pkg) => pkg.name).filter(Boolean).join(", ");
    throw new Error(`No Windows ${normalizedArch} MSIX package found${names ? ` in: ${names}` : ""}`);
  }

  return candidates[0];
}

module.exports = {
  compareVersions,
  parseWindowsPackageName,
  selectWindowsMsixPackage,
};
