import { setTimeout, clearTimeout } from "node:timers";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveCliLaunch } from "./executable";
export { executableCandidates, findExecutable } from "./executable";
export type RpcId = string | number;
export type Json = Record<string, unknown>;
export class RpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
  }
}
/** JSONL transport. Server requests and notifications are delivered before their originating response, if emitted in that order. */
export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    RpcId,
    {
      resolve: (v: unknown) => void;
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
    const launch = resolveCliLaunch(command);
    const proc = this.spawnProcess(
      launch.command,
      [...launch.args, "app-server", "--listen", "stdio://"],
      { cwd, env: launch.env, stdio: "pipe", windowsHide: true, shell: false },
    );
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
      let decoded: unknown;
      try {
        decoded = JSON.parse(line) as unknown;
      } catch {
        this.emit("protocolWarning", "Ignored malformed app-server output");
        continue;
      }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        this.emit(
          "protocolWarning",
          "Ignored invalid app-server message shape",
        );
        continue;
      }
      const message = decoded as Record<string, unknown>;
      if (
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
      if (typeof message.method === "string" && message.method) {
        if (message.id !== undefined) this.emit("request", message);
        else this.emit("notification", message.method, message.params ?? {});
      } else if (
        typeof message.id === "string" ||
        typeof message.id === "number"
      ) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = objectValue(message.error);
          pending.reject(
            new RpcError(
              textValue(error.message, "Unknown app-server error"),
              typeof error.code === "number" ? error.code : undefined,
              error.data,
            ),
          );
        } else pending.resolve(message.result);
      }
    }
  }
  request(
    method: string,
    params: Json = {},
    timeout = 60000,
  ): Promise<unknown> {
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
        reject(error instanceof Error ? error : new Error(String(error)));
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
    const generation = this.generation;
    this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
      if (error && generation === this.generation) this.fail(error);
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
function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
export function itemText(item: Record<string, unknown>): string {
  switch (item.type) {
    case "diff":
      return textValue(item.diff, textValue(item.text));
    case "agentMessage":
    case "plan":
      return textValue(item.text);
    case "userMessage":
      return (Array.isArray(item.content) ? item.content : [])
        .map((value: unknown) => {
          const c = objectValue(value);
          return textValue(c.text, textValue(c.path, `[${textValue(c.type)}]`));
        })
        .join("\n");
    case "reasoning":
      return (Array.isArray(item.summary) ? item.summary : [])
        .filter((value: unknown): value is string => typeof value === "string")
        .join("\n");
    case "commandExecution":
      return `$ ${textValue(item.command)}\n${textValue(item.aggregatedOutput)}${typeof item.exitCode === "number" ? `\nExit ${item.exitCode}` : ""}`;
    case "fileChange":
      return (Array.isArray(item.changes) ? item.changes : [])
        .map((value: unknown) => {
          const c = objectValue(value);
          return `${textValue(c.path)}\n${textValue(c.diff, JSON.stringify(c.kind))}`;
        })
        .join("\n\n");
    default:
      return JSON.stringify(item, null, 2) ?? "";
  }
}
