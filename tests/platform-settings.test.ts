import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadPlatformPaths,
  rememberPlatformPaths,
} from "../src/platform-settings";

test("Windows legacy paths synced to macOS are preserved for Windows and not applied locally", () => {
  const legacy = {
    executable:
      "C:\\Users\\heung\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    claudeExecutable: "C:\\Users\\heung\\.local\\bin\\claude.exe",
    cwd: "C:\\Users\\heung\\Documents\\Vault",
  };
  const mac = loadPlatformPaths(legacy, "darwin");
  assert.equal(mac.executable, "");
  assert.equal(mac.claudeExecutable, "");
  assert.equal(mac.cwd, "");
  assert.deepEqual(mac.platformPaths.win32, legacy);
  const saved = rememberPlatformPaths(
    {
      executable: "/opt/homebrew/bin/codex",
      claudeExecutable: "",
      cwd: "/Users/m/Vault",
    },
    mac.platformPaths,
    "darwin",
  );
  assert.deepEqual(loadPlatformPaths({ platformPaths: saved }, "win32"), {
    ...legacy,
    platformPaths: saved,
  });
  assert.equal(
    loadPlatformPaths({ platformPaths: saved }, "darwin").executable,
    "/opt/homebrew/bin/codex",
  );
});

test("each legacy field migrates independently, including UNC paths", () => {
  const migrated = loadPlatformPaths(
    {
      executable: "/opt/homebrew/bin/codex",
      claudeExecutable: "\\\\server\\tools\\claude.exe",
      cwd: "/home/alex/vault",
    },
    "darwin",
  );
  assert.equal(migrated.executable, "/opt/homebrew/bin/codex");
  assert.equal(migrated.claudeExecutable, "");
  assert.equal(migrated.cwd, "");
  assert.equal(
    migrated.platformPaths.win32.claudeExecutable,
    "\\\\server\\tools\\claude.exe",
  );
  assert.equal(migrated.platformPaths.linux.cwd, "/home/alex/vault");
});

test("saved per-platform settings are authoritative, including blank auto-discovery", () => {
  const stored = {
    executable: "C:\\stale\\codex.exe",
    claudeExecutable: "C:\\stale\\claude.exe",
    cwd: "C:\\stale\\vault",
    platformPaths: {
      win32: {
        executable: "C:\\correct\\codex.exe",
        claudeExecutable: "",
        cwd: "",
      },
      darwin: { executable: "", claudeExecutable: "", cwd: "" },
    },
  };
  assert.equal(loadPlatformPaths(stored, "darwin").executable, "");
  assert.equal(loadPlatformPaths(stored, "linux").cwd, "");
  assert.equal(
    loadPlatformPaths(stored, "win32").executable,
    "C:\\correct\\codex.exe",
  );
  assert.deepEqual(stored.platformPaths.darwin, {
    executable: "",
    claudeExecutable: "",
    cwd: "",
  });
});

test("macOS/Linux legacy paths do not cross into Windows and same-platform missing overrides remain explicit", () => {
  const windows = loadPlatformPaths(
    { executable: "/Users/alex/bin/codex", cwd: "/home/alex/vault" },
    "win32",
  );
  assert.equal(windows.executable, "");
  assert.equal(windows.cwd, "");
  assert.equal(
    windows.platformPaths.darwin.executable,
    "/Users/alex/bin/codex",
  );
  const fromMac = loadPlatformPaths(
    { executable: "/opt/homebrew/bin/codex", cwd: "/Users/alex/vault" },
    "linux",
  );
  assert.equal(fromMac.executable, "");
  assert.equal(fromMac.cwd, "");
  assert.equal(
    fromMac.platformPaths.darwin.executable,
    "/opt/homebrew/bin/codex",
  );
  const linux = loadPlatformPaths(
    { executable: "/custom/missing/codex" },
    "linux",
  );
  assert.equal(linux.executable, "/custom/missing/codex");
});
