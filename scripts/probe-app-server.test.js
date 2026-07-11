#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const test = require("node:test");

const { probeAppServer } = require("./probe-app-server");

const READ_RESULTS = {
  "account/read": { account: null, requiresOpenaiAuth: true },
  "config/read": { config: { model: "gpt-5.6-sol" }, layers: null, origins: {} },
  "model/list": {
    data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6" }],
    nextCursor: null,
  },
  "thread/list": { data: [], nextCursor: null, backwardsCursor: null },
};

class FakeChild extends EventEmitter {
  constructor(onMessage = () => {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.kills = [];
    let buffered = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        buffered += chunk.toString();
        while (buffered.includes("\n")) {
          const newline = buffered.indexOf("\n");
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line) {
            const message = JSON.parse(line);
            this.messages.push(message);
            queueMicrotask(() => onMessage(message, this));
          }
        }
        callback();
      },
    });
  }

  send(value) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal) {
    this.kills.push(signal);
    return true;
  }
}

function successfulChild() {
  const pendingReads = [];
  return new FakeChild((message, child) => {
    if (message.method === "initialize") {
      child.send({ method: "server/ready", params: { ignored: true } });
      child.send({
        id: message.id,
        result: {
          userAgent: "codex_cli_rs/0.144.1",
          codexHome: "C:\\fake",
          platformFamily: "windows",
          platformOs: "windows",
        },
      });
      return;
    }
    if (!Object.hasOwn(message, "id")) return;
    pendingReads.push(message);
    if (pendingReads.length === 4) {
      child.send({ method: "account/updated", params: { ignored: true } });
      for (const request of pendingReads.reverse()) {
        child.send({ id: request.id, result: READ_RESULTS[request.method] });
      }
    }
  });
}

test("matches interleaved JSONL responses by id and performs no model turn by default", async () => {
  const child = successfulChild();
  const result = await probeAppServer("C:\\codex.exe", {
    spawn: () => child,
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, {
    version: "0.144.1",
    models: ["gpt-5.6-sol"],
    account: READ_RESULTS["account/read"],
    config: READ_RESULTS["config/read"],
    threads: READ_RESULTS["thread/list"],
  });
  assert.deepEqual(
    child.messages.map(({ method }) => method),
    ["initialize", "initialized", "account/read", "config/read", "model/list", "thread/list"],
  );
  assert.equal(child.messages.some(({ method }) => method === "turn/start"), false);
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, [undefined]);
});

test("rejects invalid JSON from app-server", async () => {
  const child = new FakeChild((_message, current) => current.stdout.write("not-json\n"));
  await assert.rejects(
    probeAppServer("codex.exe", { spawn: () => child, timeoutMs: 1_000 }),
    /invalid JSON.*not-json/i,
  );
  assert.equal(child.kills.length, 1);
});

test("rejects when app-server exits before all responses", async () => {
  const child = new FakeChild((_message, current) => current.emit("exit", 9, null));
  await assert.rejects(
    probeAppServer("codex.exe", { spawn: () => child, timeoutMs: 1_000 }),
    /exited.*code 9/i,
  );
});

test("rejects when app-server does not respond before timeout", async () => {
  const child = new FakeChild();
  await assert.rejects(
    probeAppServer("codex.exe", { spawn: () => child, timeoutMs: 10 }),
    /timed out.*10 ms/i,
  );
  assert.equal(child.kills.length, 1);
});

for (const streamName of ["stdin", "stdout", "stderr"]) {
  test(`rejects a ${streamName} stream error and cleans up its child`, async () => {
    const child = new FakeChild((_message, current) => {
      const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      current[streamName].emit("error", error);
    });
    await assert.rejects(
      probeAppServer("codex.exe", { spawn: () => child, timeoutMs: 1_000 }),
      new RegExp(`${streamName}.*EPIPE.*broken pipe`, "i"),
    );
    assert.equal(child.kills.length, 1);
  });
}

test("rejects a protocol error response", async () => {
  const child = new FakeChild((message, current) => {
    current.send({ id: message.id, error: { code: -32602, message: "bad params" } });
  });
  await assert.rejects(
    probeAppServer("codex.exe", { spawn: () => child, timeoutMs: 1_000 }),
    /initialize.*-32602.*bad params/i,
  );
});

test("rejects model lists that omit gpt-5.6-sol", async () => {
  const child = successfulChild();
  READ_RESULTS["model/list"].data[0].model = "gpt-5.5";
  try {
    await assert.rejects(
      probeAppServer("codex.exe", { spawn: () => child, timeoutMs: 1_000 }),
      /gpt-5\.6-sol.*not returned/i,
    );
  } finally {
    READ_RESULTS["model/list"].data[0].model = "gpt-5.6-sol";
  }
});

test("CLI explicitly rejects prompt and unknown flags without spawning app-server", () => {
  const script = require.resolve("./probe-app-server");
  for (const [args, expected] of [
    [["codex.exe", "--prompt", "hello"], /--prompt.*not supported.*non-billing/i],
    [["codex.exe", "--unknown"], /unsupported argument.*--unknown/i],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});
