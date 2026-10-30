import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  setTimeout as nodeTimeout,
  clearTimeout as nodeClear,
} from "node:timers";
import { Window } from "happy-dom";
// Load the actual production CJS sidecar under the same conflicting browser globals as Electron.
test("packaged Claude SDK works with renderer DOM AbortSignal/timers and carries real permission control responses", async () => {
  const window = new Window();
  const keys = [
    "AbortController",
    "AbortSignal",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
  ] as const;
  const originals = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let query: any;
  let timer: ReturnType<typeof nodeTimeout> | undefined;
  try {
    for (const key of keys)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value:
          key.includes("Timeout") || key.includes("Interval")
            ? (window as any)[key].bind(window)
            : (window as any)[key],
      });
    const require = createRequire(resolve("package.json"));
    const sdk = require(resolve("claude-sdk.cjs"));
    let used = false;
    let callback = 0;
    const prompt = {
      async *[Symbol.asyncIterator]() {
        if (!used) {
          used = true;
          yield {
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: { role: "user", content: "Fixture prompt" },
          };
        }
        await new Promise(() => {});
      },
    };
    query = sdk.query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: process.execPath,
        persistSession: false,
        canUseTool: async (name: string, input: any) => {
          callback++;
          assert.equal(name, "Write");
          assert.equal(input.file_path, "/fixture/A.md");
          return { behavior: "deny", message: "Test denied" };
        },
        spawnClaudeCodeProcess: (options: any) =>
          spawn(process.execPath, [resolve("tests/fake-claude.cjs")], {
            cwd: process.cwd(),
            env: options.env,
            stdio: "pipe",
            signal: options.signal,
          }),
      },
    });
    const models = await query.supportedModels();
    assert.equal(models[0].value, "fixture");
    assert.equal(globalThis.AbortController, window.AbortController);
    const received: any[] = [];
    const completed = (async () => {
      for await (const message of query) {
        received.push(message);
        if (message.type === "result") break;
      }
    })();
    await Promise.race([
      completed,
      new Promise((_, reject) => {
        timer = nodeTimeout(
          () => reject(new Error("Fixture SDK timeout")),
          5000,
        );
      }),
    ]);
    assert.equal(callback, 1);
    assert.equal(
      received.find((m) => m.type === "assistant").message.content[0].text,
      "Decision deny",
    );
  } finally {
    nodeClear(timer);
    query?.close();
    for (const key of keys) {
      const original = originals.get(key);
      if (original) Object.defineProperty(globalThis, key, original);
      else delete (globalThis as any)[key];
    }
    await window.happyDOM.close();
  }
});

test("actual packaged SDK initializes and disconnects through real JS launcher, including stderr and paths with shell characters", async (t) => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { claudeExecutableOptions } = await import("../src/claude");
  const dir = mkdtempSync(join(tmpdir(), "claude JS & space "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "fixture.cjs");
  writeFileSync(
    entry,
    'process.stderr.write("JS-LAUNCHER-DIAGNOSTIC\\n");\n' +
      readFileSync(resolve("tests/fake-claude.cjs"), "utf8"),
  );
  const require = createRequire(resolve("package.json"));
  const sdk = require(resolve("claude-sdk.cjs"));
  let child: ReturnType<typeof spawn> | undefined;
  let stderr = "";
  let closed!: Promise<void>;
  const recordSpawn = ((command: string, args: string[], options: any) => {
    assert.equal(args[0], entry);
    assert.equal(options.shell, false);
    child = spawn(command, args, options);
    closed = new Promise<void>((resolve, reject) => {
      child!.once("close", () => resolve());
      child!.once("error", reject);
    });
    return child;
  }) as typeof spawn;
  const query = sdk.query({
    prompt: {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
    },
    options: {
      ...claudeExecutableOptions(entry, {}, recordSpawn, (data) => {
        stderr += data;
      }),
      persistSession: false,
    },
  });
  let timer: ReturnType<typeof nodeTimeout> | undefined;
  try {
    assert.equal((await query.supportedModels())[0].value, "fixture");
    query.close();
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = nodeTimeout(
          () => reject(new Error("JS launcher did not close its process")),
          5000,
        );
      }),
    ]);
    assert.match(stderr, /JS-LAUNCHER-DIAGNOSTIC/);
    assert.equal(child!.exitCode, 0);
  } finally {
    nodeClear(timer);
    query.close();
    if (child?.exitCode === null) child.kill("SIGKILL");
  }
});
