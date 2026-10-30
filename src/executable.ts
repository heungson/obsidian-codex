import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Injectable host facts keep discovery testable without executing another OS's CLI. */
export interface ExecutableContext {
  platform?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  isFile?: (path: string, executable: boolean) => boolean;
}
function host(context: ExecutableContext = {}) {
  const platform = context.platform ?? process.platform;
  return {
    platform,
    home: context.home ?? homedir(),
    env: context.env ?? process.env,
    execPath: context.execPath ?? process.execPath,
    path: platform === "win32" ? win32 : posix,
    isFile:
      context.isFile ??
      ((path: string, executable: boolean) => {
        try {
          if (!statSync(path).isFile()) return false;
          accessSync(
            path,
            executable && platform !== "win32"
              ? constants.X_OK
              : constants.R_OK,
          );
          return true;
        } catch {
          return false;
        }
      }),
  };
}
function envValue(env: NodeJS.ProcessEnv, key: string, windows: boolean) {
  return env[
    windows
      ? (Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase()) ??
        key)
      : key
  ];
}
function directories(context: ExecutableContext = {}) {
  const h = host(context);
  const windows = h.platform === "win32";
  const extra = [
    h.path.join(h.home, ".local", "bin"),
    h.path.join(h.home, ".npm-global", "bin"),
  ];
  if (h.platform === "darwin")
    extra.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Applications/Codex.app/Contents/Resources",
    );
  else if (windows) {
    const local = envValue(h.env, "LOCALAPPDATA", true);
    const roaming = envValue(h.env, "APPDATA", true);
    const programs = envValue(h.env, "ProgramFiles", true);
    if (local)
      extra.push(
        h.path.join(local, "Programs", "OpenAI", "Codex", "bin"),
        h.path.join(local, "Programs", "claude"),
        h.path.join(local, "Programs", "nodejs"),
      );
    if (roaming) extra.push(h.path.join(roaming, "npm"));
    if (programs) extra.push(h.path.join(programs, "nodejs"));
  } else extra.push("/usr/local/bin", "/usr/bin", "/bin");
  const inherited = (envValue(h.env, "PATH", windows) ?? "").split(
    windows ? ";" : ":",
  );
  const seen = new Set<string>();
  return [...inherited, ...extra]
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    .filter((s) => {
      // Never search the vault/current directory through an empty or relative PATH component.
      if (!s || !h.path.isAbsolute(s)) return false;
      const key = windows ? s.toLowerCase() : s;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
/** One platform-correct PATH for Codex, Claude, their tools and JS runtimes. */
export function cliEnvironment(
  context: ExecutableContext = {},
): NodeJS.ProcessEnv {
  const h = host(context);
  const env = { ...h.env };
  if (h.platform === "win32")
    for (const key of Object.keys(env))
      if (key.toLowerCase() === "path") delete env[key];
  env.PATH = directories(context).join(h.platform === "win32" ? ";" : ":");
  return env;
}
function configuredPath(configured: string, context: ExecutableContext) {
  const h = host(context);
  const value = configured.trim();
  if (
    (h.platform !== "win32" && /^(?:[a-z]:[\\/]|\\)/i.test(value)) ||
    (h.platform === "win32" && value.startsWith("/")) ||
    (h.platform === "linux" &&
      /^\/(?:Users\/|Applications\/|opt\/homebrew\/)/.test(value)) ||
    (h.platform === "darwin" && value.startsWith("/home/"))
  )
    throw new Error(
      `This CLI path belongs to another operating system: ${value}. Clear the executable setting to auto-detect the CLI on this computer, or choose its local executable.`,
    );
  const expanded = value.replace(/^~(?=$|[\\/])/, h.home);
  if (expanded && /[\\/]/.test(expanded) && !h.path.isAbsolute(expanded))
    throw new Error(
      `Relative CLI paths are not supported: ${value}. Use an absolute local executable path, or a command name such as codex or claude to search PATH.`,
    );
  return expanded;
}
export function executableCandidates(
  configured: string,
  env = process.env,
  program = "codex",
  context: ExecutableContext = {},
): string[] {
  context = { ...context, env };
  const h = host(context);
  const value = configuredPath(configured, context);
  const names =
    h.platform === "win32" && !h.path.extname(value || program)
      ? [`${value || program}.exe`, `${value || program}.cmd`]
      : [value || program];
  if (value && (h.path.isAbsolute(value) || /[\\/]/.test(value)))
    return [value];
  return directories(context).flatMap((dir) =>
    names.map((name) => h.path.join(dir, name)),
  );
}
export function findExecutable(
  configured: string,
  program = "codex",
  context: ExecutableContext = {},
): string {
  const h = host(context);
  for (const candidate of executableCandidates(
    configured,
    h.env,
    program,
    context,
  )) {
    const script = /\.(?:[cm]?js|cmd|bat)$/i.test(candidate);
    if (h.isFile(candidate, !script)) return candidate;
  }
  throw new Error(
    configured.trim()
      ? `${program} executable is not an accessible regular file: ${configured}. Correct its local path, or clear the setting to auto-detect.`
      : `${program} CLI not found. Install it and sign in in a terminal, then set its absolute executable path in Settings → Codex.`,
  );
}
export interface CliLaunch {
  command: string;
  args: string[];
  entry: string;
  env: NodeJS.ProcessEnv;
}
/** Resolve known npm shims without executing .cmd/.bat files or passing paths to a shell. */
export function resolveCliLaunch(
  executable: string,
  program = "codex",
  context: ExecutableContext = {},
): CliLaunch {
  const h = host(context);
  let entry = configuredPath(executable, context);
  if (/\.(?:cmd|bat|ps1)$/i.test(entry)) {
    const bin = h.path.basename(entry, h.path.extname(entry)).toLowerCase();
    if (
      h.platform !== "win32" ||
      bin !== program ||
      !["codex", "claude"].includes(program)
    )
      throw new Error(
        `Unsupported CLI shim: ${entry}. Select the installed native executable or JavaScript CLI entry instead.`,
      );
    const packageEntry =
      program === "codex"
        ? ["@openai", "codex", "bin", "codex.js"]
        : ["@anthropic-ai", "claude-code", "cli.js"];
    const actual = h.path.join(
      h.path.dirname(entry),
      "node_modules",
      ...packageEntry,
    );
    if (!h.isFile(actual, false))
      throw new Error(
        `Cannot resolve npm shim ${entry}. Reinstall the ${program} CLI, or select its native .exe / JavaScript entry directly. Shell shims are not executed.`,
      );
    entry = actual;
  }
  const env = cliEnvironment(context);
  if (/\.[cm]?js$/i.test(entry)) {
    const nodeName = h.platform === "win32" ? "node.exe" : "node";
    const candidates = [
      h.path.join(h.path.dirname(executable), nodeName),
      ...executableCandidates("", env, "node", context),
    ];
    if (h.path.basename(h.execPath).toLowerCase() === nodeName)
      candidates.push(h.execPath);
    const node = candidates.find(
      (p) => h.path.basename(p).toLowerCase() === nodeName && h.isFile(p, true),
    );
    if (!node)
      throw new Error(
        `${program} uses a JavaScript CLI entry, but Node.js was not found. Install Node.js and restart Obsidian, or select the native ${program} executable. Obsidian/Electron cannot be used as the Node runtime.`,
      );
    return { command: node, args: [entry], entry, env };
  }
  return { command: entry, args: [], entry, env };
}
