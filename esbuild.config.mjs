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
  minify: production,
  banner: { js: "/* Obsidian Codex + Claude Code | plugin source MIT */" },
};
const runtime = {
  entryPoints: ["src/claude-sdk-runtime.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: "claude-sdk.cjs",
  minify: production,
  legalComments: "eof",
  define: { "import.meta.url": "__CLAUDE_SDK_MODULE_URL__" },
  banner: {
    js: '/* Anthropic Agent SDK runtime; see THIRD_PARTY_NOTICES.md */\nvar {setTimeout,clearTimeout,setInterval,clearInterval}=require("node:timers");\nvar AbortController=require("node:util").transferableAbortController().constructor; var AbortSignal=(new AbortController()).signal.constructor;\nvar __CLAUDE_SDK_MODULE_URL__=require("node:url").pathToFileURL(__filename).href;',
  },
};
if (production)
  await Promise.all([esbuild.build(main), esbuild.build(runtime)]);
else {
  const contexts = await Promise.all([
    esbuild.context(main),
    esbuild.context(runtime),
  ]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
}
