import { mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const directory = resolve("dist", manifest.id);
mkdirSync(directory, { recursive: true });
for (const name of [
  "main.js",
  "claude-sdk.cjs",
  "THIRD_PARTY_NOTICES.md",
  "manifest.json",
  "styles.css",
  "README.md",
  "README.ko.md",
  "VERIFICATION.md",
  "LICENSE",
])
  copyFileSync(name, join(directory, name));
const archive = resolve("dist", `${manifest.id}-${manifest.version}.zip`);
rmSync(archive, { force: true });
execFileSync("zip", ["-q", "-r", archive, manifest.id], {
  cwd: resolve("dist"),
});
console.log(`Release bundle: ${archive}`);
