export interface PlatformPaths {
  executable: string;
  claudeExecutable: string;
  cwd: string;
}

export type PlatformPathMap = Record<string, PlatformPaths>;
const fields = ["executable", "claudeExecutable", "cwd"] as const;
const emptyPaths = (): PlatformPaths => ({
  executable: "",
  claudeExecutable: "",
  cwd: "",
});

/** Only infer unmistakable OS-specific legacy paths; shared Unix paths stay local. */
function pathPlatform(path: string, current: string): string {
  if (/^(?:[a-z]:[\\/]|\\\\|\\)/i.test(path)) return "win32";
  if (/^\/(?:Users|Applications|opt\/homebrew)\//.test(path)) return "darwin";
  if (/^\/home\//.test(path)) return "linux";
  if (current === "win32" && path.startsWith("/")) return "linux";
  return current;
}

/** A synced vault must not apply one operating system's absolute paths to another. */
export function loadPlatformPaths(
  saved: Partial<PlatformPaths> & { platformPaths?: unknown },
  platform = process.platform as string,
): PlatformPaths & { platformPaths: PlatformPathMap } {
  const platformPaths: PlatformPathMap = {};
  const existing = saved.platformPaths;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [key, value] of Object.entries(existing)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const paths = emptyPaths();
      for (const field of fields)
        if (typeof (value as PlatformPaths)[field] === "string")
          paths[field] = (value as PlatformPaths)[field];
      platformPaths[key] = paths;
    }
  } else {
    // Preserve legacy overrides for the OS that can use them. A missing local
    // override means CLI auto-discovery / the current vault, never a foreign path.
    for (const field of fields) {
      const value =
        typeof saved[field] === "string" ? saved[field]!.trim() : "";
      if (!value) continue;
      const owner = pathPlatform(value, platform);
      (platformPaths[owner] ??= emptyPaths())[field] = value;
    }
  }
  const active = platformPaths[platform] ?? emptyPaths();
  return { ...active, platformPaths };
}

export function rememberPlatformPaths(
  paths: PlatformPaths,
  saved: PlatformPathMap,
  platform = process.platform as string,
): PlatformPathMap {
  return {
    ...saved,
    [platform]: {
      executable: paths.executable,
      claudeExecutable: paths.claudeExecutable,
      cwd: paths.cwd,
    },
  };
}

export function platformName(platform = process.platform as string): string {
  return (
    { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform] ?? platform
  );
}
