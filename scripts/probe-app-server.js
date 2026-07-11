#!/usr/bin/env node
const { spawn: spawnChild } = require("node:child_process");

const REQUIRED_MODEL = "gpt-5.6-sol";
const DEFAULT_TIMEOUT_MS = 15_000;

function extractVersion(userAgent) {
  if (typeof userAgent !== "string") return null;
  const match = userAgent.match(/(?:^|\/)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match ? match[1] : null;
}

function formatProtocolError(method, error) {
  const code = error && Object.hasOwn(error, "code") ? ` ${error.code}` : "";
  const message = error && error.message ? `: ${error.message}` : "";
  return new Error(`app-server ${method} failed${code}${message}`);
}

async function probeAppServer(executable, options = {}) {
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("A Codex executable path is required");
  }

  const spawn = options.spawn || spawnChild;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }

  const child = spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child || !child.stdin || !child.stdout || !child.stderr) {
    throw new Error("app-server child process did not expose stdio pipes");
  }

  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let finished = false;
  let fatalReject;
  const pending = new Map();
  const fatal = new Promise((_resolve, reject) => {
    fatalReject = reject;
  });

  const fail = (error) => {
    if (!finished) fatalReject(error);
  };
  const failStream = (name, error) => {
    const code = error && error.code ? ` ${error.code}` : "";
    const message = error && error.message ? `: ${error.message}` : "";
    fail(new Error(`app-server ${name} stream error${code}${message}`));
  };

  const handleMessage = (message) => {
    if (!message || typeof message !== "object" || !Object.hasOwn(message, "id")) {
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      fail(new Error(`app-server returned an unexpected response id: ${JSON.stringify(message.id)}`));
      return;
    }
    pending.delete(message.id);
    if (Object.hasOwn(message, "error")) {
      request.reject(formatProtocolError(request.method, message.error));
    } else if (!Object.hasOwn(message, "result")) {
      request.reject(new Error(`app-server ${request.method} response omitted result`));
    } else {
      request.resolve(message.result);
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        fail(new Error(`app-server returned invalid JSON (${error.message}): ${line.slice(0, 200)}`));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBuffer = (stderrBuffer + chunk.toString("utf8")).slice(-4_000);
  });
  child.stdin.on("error", (error) => failStream("stdin", error));
  child.stdout.on("error", (error) => failStream("stdout", error));
  child.stderr.on("error", (error) => failStream("stderr", error));
  child.on("error", (error) => fail(new Error(`failed to start app-server: ${error.message}`)));
  child.on("exit", (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    const stderr = stderrBuffer.trim() ? `; stderr: ${stderrBuffer.trim()}` : "";
    fail(new Error(`app-server exited before the probe completed (${detail})${stderr}`));
  });

  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const notify = (method) => send({ method });
  const request = (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
    });
    send({ method, id, params });
    return response;
  };

  const run = async () => {
    const initialized = await request("initialize", {
      clientInfo: { name: "codex-desktop-rebuild-probe", title: "Codex Desktop Rebuild Probe", version: "1.0.0" },
      capabilities: null,
    });
    notify("initialized");

    const [account, config, modelResponse, threads] = await Promise.all([
      request("account/read", { refreshToken: false }),
      request("config/read", { includeLayers: true }),
      request("model/list", { includeHidden: true }),
      request("thread/list", { limit: 1, useStateDbOnly: true }),
    ]);

    const version = extractVersion(initialized && initialized.userAgent);
    if (!version) {
      throw new Error(`initialize returned an invalid userAgent: ${JSON.stringify(initialized && initialized.userAgent)}`);
    }
    if (!modelResponse || !Array.isArray(modelResponse.data)) {
      throw new Error("model/list response omitted its data array");
    }
    const models = modelResponse.data.map((model) => model && model.model);
    if (models.some((model) => typeof model !== "string")) {
      throw new Error("model/list returned an invalid model entry");
    }
    if (!models.includes(REQUIRED_MODEL)) {
      throw new Error(`${REQUIRED_MODEL} was not returned by model/list (received: ${models.join(", ")})`);
    }

    return { version, models, account, config, threads };
  };

  const timer = setTimeout(
    () => fail(new Error(`app-server probe timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    return await Promise.race([run(), fatal]);
  } finally {
    finished = true;
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

function usage() {
  return "Usage: node scripts/probe-app-server.js <path-to-codex-executable>";
}

async function main(argv) {
  if (argv.includes("--prompt")) {
    throw new Error("--prompt is not supported by this non-billing probe; model turns are reserved for Task 7");
  }
  const unsupported = argv.find((argument) => argument.startsWith("--"));
  if (unsupported) {
    throw new Error(`unsupported argument: ${unsupported}`);
  }
  if (argv.length !== 1) {
    throw new Error(usage());
  }
  const summary = await probeAppServer(argv[0]);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[probe-app-server] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { probeAppServer };
