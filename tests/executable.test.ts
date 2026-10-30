import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  cliEnvironment,
  executableCandidates,
  findExecutable,
  resolveCliLaunch,
  type ExecutableContext,
} from "../src/executable";
import { claudeExecutableOptions } from "../src/claude";
const mac: ExecutableContext = {
  platform: "darwin",
  home: "/Users/test",
  env: { PATH: "/bin" },
};
const linux: ExecutableContext = {
  platform: "linux",
  home: "/home/test",
  env: { PATH: "/usr/bin" },
};
const windows: ExecutableContext = {
  platform: "win32",
  home: "C:\\Users\\Test",
  execPath: "C:\\Obsidian\\Obsidian.exe",
  env: {
    Path: '"C:\\Tools With Spaces";C:\\Tools With Spaces;relative;;C:\\Windows',
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
    APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
    ProgramFiles: "C:\\Program Files",
    KEEP: "yes",
  },
};
function candidates(
  context: ExecutableContext,
  configured = "",
  program = "codex",
) {
  return executableCandidates(configured, context.env, program, context);
}
function files(context: ExecutableContext, paths: string[]): ExecutableContext {
  return { ...context, isFile: (path) => paths.includes(path) };
}
test("discovery uses platform path semantics and OS-specific installation directories", () => {
  assert.ok(candidates(mac).includes("/opt/homebrew/bin/codex"));
  assert.ok(
    candidates(mac).includes(
      "/Applications/Codex.app/Contents/Resources/codex",
    ),
  );
  assert.ok(candidates(linux).includes("/home/test/.local/bin/codex"));
  assert.ok(
    !candidates(linux).some((p) => /homebrew|Applications|AppData/.test(p)),
  );
  const win = candidates(windows);
  assert.equal(win[0], "C:\\Tools With Spaces\\codex.exe");
  assert.equal(win[1], "C:\\Tools With Spaces\\codex.cmd");
  assert.ok(
    win.includes(
      "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    ),
  );
  assert.ok(win.includes("C:\\Users\\Test\\.local\\bin\\codex.exe"));
  assert.ok(win.includes("C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd"));
  assert.ok(!win.some((p) => /homebrew|Applications|relative/.test(p)));
});
test("child PATH is shared, preserves environment, deduplicates Windows casing and excludes cwd", () => {
  const env = cliEnvironment(windows);
  assert.equal(env.KEEP, "yes");
  assert.equal(env.Path, undefined);
  assert.equal(
    Object.keys(env).filter((p) => p.toLowerCase() === "path").length,
    1,
  );
  assert.equal(
    env.PATH!.split(";").filter((p) => p === "C:\\Tools With Spaces").length,
    1,
  );
  assert.ok(!env.PATH!.includes(":/"));
  assert.equal(
    windows.env!.Path!.startsWith('"'),
    true,
    "does not mutate inherited environment",
  );
  assert.ok(cliEnvironment(mac).PATH!.includes("/opt/homebrew/bin"));
  assert.ok(!cliEnvironment(linux).PATH!.includes("/opt/homebrew"));
});
test("bare configured names search PATH, explicit paths expand home and never fall back", () => {
  const context = files(mac, ["/bin/codex", "/Users/test/.local/bin/claude"]);
  assert.equal(findExecutable("codex", "codex", context), "/bin/codex");
  assert.equal(
    findExecutable("~/.local/bin/claude", "claude", context),
    "/Users/test/.local/bin/claude",
  );
  assert.throws(
    () => findExecutable("/missing/codex", "codex", context),
    /not an accessible regular file.*Correct its local path/,
  );
  assert.deepEqual(candidates(windows, "~\\.local\\bin\\claude.exe"), [
    "C:\\Users\\Test\\.local\\bin\\claude.exe",
  ]);
});
test("foreign configured paths fail clearly before touching filesystem", () => {
  for (const [context, value] of [
    [mac, "C:\\Users\\Test\\codex.exe"],
    [linux, "\\\\server\\codex.exe"],
    [windows, "/usr/bin/codex"],
    [linux, "/opt/homebrew/bin/codex"],
    [mac, "/home/test/bin/codex"],
  ] as const) {
    assert.throws(
      () =>
        findExecutable(value, "codex", {
          ...context,
          isFile: () => {
            throw new Error("must not inspect foreign path");
          },
        }),
      /another operating system.*Clear the executable setting/,
    );
  }
});
test("native discovery accepts only regular executable files, with readable JS entry support", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-executable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const directory = join(dir, "directory");
  mkdirSync(directory);
  const file = join(dir, "codex");
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o644);
  assert.throws(() => findExecutable(directory), /regular file/);
  if (process.platform !== "win32")
    assert.throws(() => findExecutable(file), /regular file/);
  chmodSync(file, 0o755);
  assert.equal(findExecutable(file), file);
  const script = join(dir, "cli.js");
  writeFileSync(script, "");
  chmodSync(script, 0o644);
  assert.equal(findExecutable(script), script);
});
test("known Windows npm shims resolve package JS and real Node without shell commands", () => {
  for (const [program, suffix] of [
    ["codex", "@openai\\codex\\bin\\codex.js"],
    ["claude", "@anthropic-ai\\claude-code\\cli.js"],
  ]) {
    const shim = `C:\\Tools With Spaces\\${program}.cmd`;
    const entry = `C:\\Tools With Spaces\\node_modules\\${suffix}`;
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const launch = resolveCliLaunch(
      shim,
      program,
      files(windows, [shim, entry, node]),
    );
    assert.equal(launch.command, node);
    assert.deepEqual(launch.args, [entry]);
    assert.equal(launch.entry, entry);
  }
});
test("unrecognized/missing shims and JavaScript entries without Node give actionable errors", () => {
  assert.throws(
    () => resolveCliLaunch("C:\\Tools\\custom.cmd", "codex", windows),
    /Unsupported CLI shim/,
  );
  assert.throws(
    () => resolveCliLaunch("C:\\Tools\\codex.cmd", "codex", files(windows, [])),
    /Cannot resolve npm shim.*Reinstall/,
  );
  assert.throws(
    () =>
      resolveCliLaunch(
        "C:\\Tools\\codex.js",
        "codex",
        files(windows, ["C:\\Obsidian\\Obsidian.exe"]),
      ),
    /Node.js was not found.*Obsidian\/Electron cannot/,
  );
  const native = resolveCliLaunch(
    "C:\\Tools & Space\\codex.exe",
    "codex",
    windows,
  );
  assert.equal(native.command, "C:\\Tools & Space\\codex.exe");
  assert.deepEqual(native.args, []);
});
test("Claude SDK JS launcher keeps paths literal, entry once, abort signal and drained lifecycle", () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const calls: any[] = [];
  const spawnProcess = ((...args: any[]) => {
    calls.push(args);
    return child;
  }) as unknown as typeof spawn;
  for (const ext of ["js", "cjs", "mjs"]) {
    const entry = `C:\\Tools & Space\\claude.${ext}`;
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const options = claudeExecutableOptions(
      entry,
      files(windows, [node]),
      spawnProcess,
    );
    assert.equal(options.pathToClaudeCodeExecutable, entry);
    const controller = new AbortController();
    const p = options.spawnClaudeCodeProcess!({
      command: ext === "cjs" ? entry : "node",
      args: [
        ...(ext === "cjs" ? [] : [entry]),
        "--output-format",
        "stream-json",
      ],
      cwd: "C:\\Vault & Notes",
      env: options.env!,
      signal: controller.signal,
    });
    const [command, args, launchOptions] = calls.at(-1);
    assert.equal(command, node);
    assert.deepEqual(args, [entry, "--output-format", "stream-json"]);
    assert.equal(launchOptions.shell, false);
    assert.equal(launchOptions.signal, controller.signal);
    assert.equal(launchOptions.cwd, "C:\\Vault & Notes");
    let exited = false;
    p.once("exit", () => {
      exited = true;
    });
    child.emit("exit", 0, null);
    assert.equal(exited, false);
    child.emit("close", 0, null);
    assert.equal(exited, true);
  }
  const native = claudeExecutableOptions("C:\\Tools\\claude.exe", windows);
  assert.equal(
    native.spawnClaudeCodeProcess,
    undefined,
    "native CLI retains SDK native lifecycle",
  );
});

test("relative path overrides fail without searching a different PATH binary", () => {
  for (const [context, value] of [
    [mac, "./codex"],
    [linux, "bin/codex"],
    [windows, ".\\codex.exe"],
  ] as const)
    assert.throws(
      () => findExecutable(value, "codex", context),
      /Relative CLI paths.*absolute local executable path/,
    );
});
