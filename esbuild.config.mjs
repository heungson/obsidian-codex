import esbuild from "esbuild";
const production = process.argv.includes("production");
const main = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "node:*"],
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: false,
  banner: { js: "/* Obsidian Codex + Claude Code | plugin source MIT */" },
};
const runtime = {
  entryPoints: ["src/claude-sdk-runtime.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: "claude-sdk.cjs",
  minify: false,
  legalComments: "eof",
  define: { "import.meta.url": "__CLAUDE_SDK_MODULE_URL__" },
  banner: {
    js: '/* Anthropic Agent SDK runtime; see THIRD_PARTY_NOTICES.md */\nvar {setTimeout,clearTimeout,setInterval,clearInterval}=require("node:timers");\nvar AbortController=require("node:util").transferableAbortController().constructor; var AbortSignal=(new AbortController()).signal.constructor;\nvar __CLAUDE_SDK_MODULE_URL__=require("node:url").pathToFileURL(__filename).href;',
  },
};
// Embed the SDK in the community-installable main.js while preserving its own
// Node timer and AbortSignal scope. Obsidian only installs the standard files.
const runtimeBuild = await esbuild.build({ ...runtime, write: false });
const runtimeText = runtimeBuild.outputFiles[0].text;
const embedded = {
  name: "embedded-claude-runtime",
  setup(build) {
    build.onLoad({ filter: /embedded-claude\.ts$/ }, () => ({
      contents: `let cached; export function embeddedClaudeRuntime() {
        if (!cached) { const module = {exports:{}}; const exports = module.exports;
          (function(module, exports, require, __filename) {\n${runtimeText}\n})(module, exports, require, __filename);
          cached = module.exports;
        } return cached;
      }`,
      loader: "js",
    }));
  },
};
await esbuild.build(runtime);
await esbuild.build({
  entryPoints: ["tests/embedded-runtime-entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: "dist/embedded-runtime-test.cjs",
  plugins: [embedded],
});
if (production) await esbuild.build({ ...main, plugins: [embedded] });
else {
  const context = await esbuild.context({ ...main, plugins: [embedded] });
  await context.watch();
}
