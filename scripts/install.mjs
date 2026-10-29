import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
const vault = process.argv[2];
if (!vault) {
  console.error('Usage: node scripts/install.mjs "/absolute/path/to/vault"');
  process.exit(1);
}
const root = resolve(vault);
if (!existsSync(join(root, ".obsidian"))) {
  console.error(
    "No .obsidian folder found. Open this folder as a vault in Obsidian first.",
  );
  process.exit(1);
}
for (const file of [
  "main.js",
  "claude-sdk.cjs",
  "manifest.json",
  "styles.css",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
])
  if (!existsSync(file)) {
    console.error("Build first with npm run build.");
    process.exit(1);
  }
const destination = join(root, ".obsidian", "plugins", "obsidian-codex");
if (existsSync(destination)) {
  const backup = join(
    root,
    ".obsidian",
    "obsidian-codex-backups",
    String(Date.now()),
  );
  mkdirSync(backup, { recursive: true });
  for (const file of [
    "main.js",
    "claude-sdk.cjs",
    "manifest.json",
    "styles.css",
    "THIRD_PARTY_NOTICES.md",
    "LICENSE",
  ])
    if (existsSync(join(destination, file)))
      copyFileSync(join(destination, file), join(backup, file));
  console.log(`Previous plugin files backed up: ${backup}`);
}
mkdirSync(destination, { recursive: true });
for (const file of [
  "main.js",
  "claude-sdk.cjs",
  "manifest.json",
  "styles.css",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
])
  copyFileSync(file, join(destination, file));
console.log(
  `Installed: ${destination}\nIn Obsidian: Settings → Community plugins → enable Codex (reload Obsidian if needed). Settings and other plugins were not changed.`,
);
