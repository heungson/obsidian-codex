import { setTimeout, clearTimeout } from "node:timers";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, isAbsolute } from "node:path";
export type RpcId = string | number;
export type Json = Record<string, any>;
export class RpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
  }
}
export function executableCandidates(
  configured: string,
  env = process.env,
  program = "codex",
): string[] {
  const dirs = [
    ...(env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    join(homedir(), ".npm-global/bin"),
    "/Applications/Codex.app/Contents/Resources",
  ];
  if (configured.trim())
    return [configured.trim().replace(/^~(?=\/)/, homedir())];
  return [
    ...new Set(
      dirs
        .filter(Boolean)
        .map((p) =>
          join(p, process.platform === "win32" ? `${program}.exe` : program),
        ),
    ),
  ];
}
export function findExecutable(configured: string, program = "codex"): string {
  for (const p of executableCandidates(configured, process.env, program)) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  throw new Error(
    configured
      ? `${program} executable is not accessible: ${configured}`
      : `${program} CLI not found. Install it, sign in in a terminal, then set its absolute executable path in Settings → Codex.`,
  );
}
/** JSONL transport. Server requests and notifications are delivered before their originating response, if emitted in that order. */
export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    RpcId,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private generation = 0;
  private buffer = "";
  private connecting?: Promise<void>;
  ready = false;
  stderr = "";
  constructor(
    private command: () => string,
    private cwd: () => string,
    private spawnProcess: typeof spawn = spawn,
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    const attempt = this.open();
    const connecting = attempt.finally(() => {
      if (this.connecting === connecting) this.connecting = undefined;
    });
    this.connecting = connecting;
    return connecting;
  }
  private async open() {
    const command = this.command();
    const cwd = this.cwd();
    if (!isAbsolute(cwd) || !existsSync(cwd))
      throw new Error("Working directory must be an existing absolute folder.");
    const gen = ++this.generation;
    this.buffer = "";
    this.stderr = "";
    const env = {
      ...process.env,
      PATH: [
        process.env.PATH,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        join(homedir(), ".local/bin"),
      ]
        .filter(Boolean)
        .join(delimiter),
    };
    const proc = this.spawnProcess(
      command,
      ["app-server", "--listen", "stdio://"],
      { cwd, env, stdio: "pipe", windowsHide: true },
    ) as ChildProcessWithoutNullStreams;
    this.child = proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (gen === this.generation) this.receive(chunk);
    });
    proc.stderr.on("data", (chunk: string) => {
      if (gen === this.generation)
        this.stderr = (this.stderr + chunk).slice(-4000);
    });
    proc.on("error", (error) => {
      if (gen === this.generation) this.fail(error);
    });
    proc.stdin.on("error", (error) => {
      if (gen === this.generation) this.fail(error);
    });
    proc.on("close", (code, signal) => {
      if (gen === this.generation)
        this.fail(
          new Error(
            `Codex disconnected (${signal ?? code ?? "unknown"}). Reconnect to resume saved history.`,
          ),
        );
    });
    try {
      await this.request(
        "initialize",
        {
          clientInfo: {
            name: "obsidian_codex",
            title: "Obsidian Codex",
            version: "0.2.0",
          },
          capabilities: { experimentalApi: true },
        },
        20000,
      );
      if (gen !== this.generation) throw new Error("Connection replaced");
      this.notify("initialized", {});
      this.ready = true;
      this.emit("status", "Connected");
    } catch (error) {
      if (gen === this.generation) this.disconnect();
      throw error;
    }
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) {
      this.fail(new Error("Codex sent an oversized protocol frame."));
      this.disconnect();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Json;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit("protocolWarning", "Ignored malformed app-server output");
        continue;
      }
      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        (message.method !== undefined && typeof message.method !== "string") ||
        (message.id !== undefined &&
          typeof message.id !== "number" &&
          typeof message.id !== "string") ||
        (message.method !== undefined &&
          message.params != null &&
          (typeof message.params !== "object" || Array.isArray(message.params)))
      ) {
        this.emit(
          "protocolWarning",
          "Ignored invalid app-server message shape",
        );
        continue;
      }
      if (message.method && message.params == null) message.params = {};
      if (message.method) {
        if (message.id !== undefined) this.emit("request", message);
        else this.emit("notification", message.method, message.params ?? {});
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new RpcError(
              message.error.message,
              message.error.code,
              message.error.data,
            ),
          );
        else pending.resolve(message.result);
      }
    }
  }
  request(method: string, params: Json = {}, timeout = 60000): Promise<any> {
    if (!this.child || this.child.killed)
      return Promise.reject(new Error("Codex is disconnected. Use Reconnect."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} timed out. Its outcome may be unknown; reconnect and inspect history before retrying a message.`,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: Json) {
    this.write({ method, params });
  }
  respond(id: RpcId, result: unknown) {
    this.write({ id, result });
  }
  rejectRequest(id: RpcId, message = "Unsupported client request") {
    this.write({ id, error: { code: -32601, message } });
  }
  private write(message: Json) {
    if (!this.child || this.child.killed || !this.child.stdin.writable)
      throw new Error("Codex is disconnected");
    this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
      if (error) this.fail(error);
    });
  }
  private fail(error: Error) {
    this.ready = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error);
  }
  disconnect() {
    ++this.generation;
    this.connecting = undefined;
    const proc = this.child;
    this.child = undefined;
    this.fail(new Error("Codex connection closed"));
    if (proc) {
      proc.stdin.end();
      proc.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }, 1500);
      timer.unref();
    }
  }
}
export type AccessMode = "read-only" | "agent" | "full-access";
export function threadPolicy(mode: AccessMode) {
  return {
    sandbox:
      mode === "full-access"
        ? "danger-full-access"
        : mode === "agent"
          ? "workspace-write"
          : "read-only",
    approvalPolicy: mode === "full-access" ? "never" : "on-request",
    approvalsReviewer: "user",
  };
}
export function turnPolicy(mode: AccessMode, cwd: string) {
  return {
    approvalPolicy: mode === "full-access" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandboxPolicy:
      mode === "full-access"
        ? { type: "dangerFullAccess" }
        : mode === "agent"
          ? {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : { type: "readOnly", networkAccess: false },
  };
}
export function itemText(item: Json): string {
  switch (item.type) {
    case "diff":
      return item.diff ?? item.text ?? "";
    case "agentMessage":
    case "plan":
      return item.text ?? "";
    case "userMessage":
      return (item.content ?? [])
        .map((c: Json) => c.text ?? c.path ?? `[${c.type}]`)
        .join("\n");
    case "reasoning":
      return (item.summary ?? []).join("\n");
    case "commandExecution":
      return `$ ${item.command}\n${item.aggregatedOutput ?? ""}${item.exitCode != null ? `\nExit ${item.exitCode}` : ""}`;
    case "fileChange":
      return (item.changes ?? [])
        .map((c: Json) => `${c.path}\n${c.diff ?? JSON.stringify(c.kind)}`)
        .join("\n\n");
    default:
      return JSON.stringify(item, null, 2);
  }
}
