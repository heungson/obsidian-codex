import { EventEmitter } from "node:events";
// Claude runs as a Node child process, so its timeouts must use Node timers.
import {
  setTimeout as nodeSetTimeout,
  clearTimeout as nodeClearTimeout,
} from "node:timers";
import { spawn } from "node:child_process";
import { resolveCliLaunch, type ExecutableContext } from "./executable";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Json, RpcId, AccessMode } from "./protocol";
import { claudeReviewSnapshot } from "./claude-review";
export type ClaudeRuntime = Pick<
  typeof import("@anthropic-ai/claude-agent-sdk"),
  | "query"
  | "listSessions"
  | "getSessionMessages"
  | "getSessionInfo"
  | "renameSession"
  | "forkSession"
>;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
type TranscriptItem = Record<string, unknown> & { id: string; type: string };
interface ProviderParams {
  threadId: string;
  turnId: string;
  name: string;
  searchTerm: string;
  archived: boolean;
  excludeTurns: boolean;
  cursor: string | number | undefined;
  limit: number;
  input: Record<string, unknown>[];
  model: string;
  effort: Options["effort"];
  claudeAccess: AccessMode | undefined;
  sandboxPolicy: Record<string, unknown>;
  collaborationMode: Record<string, unknown>;
}
function providerParams(value: unknown): ProviderParams {
  const p = record(value);
  const effort = p.effort;
  const access = p.claudeAccess;
  return {
    threadId: text(p.threadId),
    turnId: text(p.turnId),
    name: text(p.name),
    searchTerm: text(p.searchTerm),
    archived: p.archived === true,
    excludeTurns: p.excludeTurns === true,
    cursor:
      typeof p.cursor === "string" || typeof p.cursor === "number"
        ? p.cursor
        : undefined,
    limit:
      typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 40,
    input: Array.isArray(p.input) ? p.input.map(record) : [],
    model: text(p.model),
    effort:
      effort === "low" ||
      effort === "medium" ||
      effort === "high" ||
      effort === "xhigh" ||
      effort === "max"
        ? effort
        : undefined,
    claudeAccess:
      access === "read-only" || access === "agent" || access === "full-access"
        ? access
        : undefined,
    sandboxPolicy: record(p.sandboxPolicy),
    collaborationMode: record(p.collaborationMode),
  };
}
/** Match the SDK spawn contract while launching npm JS entries with an actual Node runtime. */
export function claudeExecutableOptions(
  executable: string,
  context: ExecutableContext = {},
  spawnProcess: typeof spawn = spawn,
  onStderr?: (data: string) => void,
): Pick<
  Options,
  "pathToClaudeCodeExecutable" | "env" | "executable" | "spawnClaudeCodeProcess"
> {
  const launch = resolveCliLaunch(executable, "claude", context);
  return {
    pathToClaudeCodeExecutable: launch.entry,
    env: launch.env,
    ...(launch.args.length
      ? {
          executable: "node" as const,
          spawnClaudeCodeProcess: (options) => {
            // SDK versions classify .cjs differently. Normalize the entry exactly once.
            const args =
              options.args[0] === launch.entry
                ? options.args.slice(1)
                : options.args;
            const child = spawnProcess(
              launch.command,
              [...launch.args, ...args],
              {
                cwd: options.cwd,
                env: options.env,
                signal: options.signal,
                stdio: "pipe",
                windowsHide: true,
                shell: false,
              },
            );
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (data: string) => onStderr?.(data));
            // Wait for stdio to drain before delivering SDK exit/error summaries.
            const event = (name: "exit" | "error") =>
              name === "exit" ? "close" : name;
            return {
              stdin: child.stdin,
              stdout: child.stdout,
              get killed() {
                return child.killed;
              },
              get exitCode() {
                return child.exitCode;
              },
              get signalCode() {
                return child.signalCode;
              },
              kill: child.kill.bind(child),
              on: (name, listener) => {
                child.on(event(name), listener);
              },
              once: (name, listener) => {
                child.once(event(name), listener);
              },
              off: (name, listener) => {
                child.off(event(name), listener);
              },
            };
          },
        }
      : {}),
  };
}
export interface ClaudeArchiveStore {
  get(): string[];
  set(ids: string[]): Promise<void>;
}
const READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  "TodoWrite",
  "TaskList",
  "TaskGet",
]);
/** An explicit tool boundary, not an operating-system sandbox. Unknown/MCP/code tools fail closed. */
export function claudeReadOnlyHook(): HookCallback {
  return async (input) => {
    if (
      input.hook_event_name === "PreToolUse" &&
      !READ_TOOLS.has(input.tool_name)
    )
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Obsidian read-only mode blocks write, shell, agent and unclassified tools. Switch permissions explicitly to use this tool.",
        },
      };
    return {};
  };
}
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private ended = false;
  push(value: SDKUserMessage) {
    if (this.ended) throw new Error("Claude input stream is closed");
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value, done: false });
    } else this.values.push(value);
  }
  close() {
    this.ended = true;
    this.values = [];
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true as const };
      },
    };
  }
}
interface Run {
  id: string;
  threadId: string;
  query: Query;
  queue: InputQueue;
  generation: number;
  items: Map<string, TranscriptItem>;
  messageId: string;
  blocks: Map<number, Json>;
  textParts: Map<string, Map<string, string>>;
  finalTextSeen: Set<string>;
  interrupted: boolean;
  finished: boolean;
}
interface Pending {
  run: Run;
  finish: (result: PermissionResult) => void;
  input: Record<string, unknown>;
  questions?: Record<string, unknown>[];
}
export class ClaudeClient extends EventEmitter {
  readonly provider = "claude";
  readonly supportsSteer = false;
  ready = false;
  stderr = "";
  private sdk?: ClaudeRuntime;
  private inspection?: Query;
  private inspectionQueue?: InputQueue;
  private connecting?: Promise<void>;
  private generation = 0;
  private active?: Run;
  private starting?: symbol;
  private threadId = "";
  private fresh = new Set<string>();
  private pending = new Map<RpcId, Pending>();
  private localArchived: string[] = [];
  constructor(
    private command: () => string,
    private cwd: () => string,
    private runtime: () => ClaudeRuntime,
    private archive?: ClaudeArchiveStore,
    private readImage?: (path: string) => Promise<Uint8Array>,
  ) {
    super();
  }
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    const attempt = this.open();
    const promise = attempt.finally(() => {
      if (this.connecting === promise) this.connecting = undefined;
    });
    this.connecting = promise;
    return promise;
  }
  private async open() {
    const dir = this.cwd();
    if (!isAbsolute(dir) || !existsSync(dir))
      throw new Error("Working directory must be an existing absolute folder.");
    this.command();
    this.sdk = this.runtime();
    const gen = this.generation;
    try {
      const q = this.metadataQuery();
      await this.timed(q.supportedModels(), 30000, "Claude initialization");
      if (gen !== this.generation)
        throw new Error("Claude connection replaced");
      this.ready = true;
      this.emit("status", "Connected");
    } catch (error) {
      if (gen === this.generation) this.closeInspection();
      throw error;
    }
  }
  private baseOptions(): Options {
    const stderr = (data: string) => {
      this.stderr = (this.stderr + data).slice(-4000);
    };
    const executable = claudeExecutableOptions(
      this.command(),
      {},
      spawn,
      stderr,
    );
    return {
      ...executable,
      cwd: this.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      permissionMode: "default",
      includePartialMessages: true,
      env: {
        ...executable.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "obsidian-codex/0.2.0",
      },
      stderr,
    };
  }
  private metadataQuery() {
    if (this.active) return this.active.query;
    if (this.inspection) return this.inspection;
    this.sdk ??= this.runtime();
    this.inspectionQueue = new InputQueue();
    this.inspection = this.sdk.query({
      prompt: this.inspectionQueue,
      options: {
        ...this.baseOptions(),
        persistSession: false,
        tools: [],
        permissionMode: "plan",
      },
    });
    return this.inspection;
  }
  private closeInspection() {
    this.inspectionQueue?.close();
    this.inspection?.close();
    this.inspection = undefined;
    this.inspectionQueue = undefined;
  }
  private async timed<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof nodeSetTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = nodeSetTimeout(
            () =>
              reject(
                new Error(`${label} timed out. Reconnect before retrying.`),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      nodeClearTimeout(timer);
    }
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
    _timeout?: number,
  ): Promise<Json> {
    const p = providerParams(params);
    await this.connect();
    const sdk = this.sdk!;
    switch (method) {
      case "model/list": {
        const models = await this.timed(
          this.metadataQuery().supportedModels(),
          30000,
          "Claude models",
        );
        return {
          data: models.map((m, i) => ({
            id: m.value,
            model: m.value,
            displayName: m.displayName,
            description: m.description,
            isDefault: m.value === "default" || i === 0,
            supportedReasoningEfforts: (
              m.supportedEffortLevels ?? ["high"]
            ).map((e) => ({ reasoningEffort: e })),
            defaultReasoningEffort: m.supportedEffortLevels?.includes("high")
              ? "high"
              : (m.supportedEffortLevels?.[0] ?? ""),
            inputModalities: ["text", "image"],
          })),
        };
      }
      case "account/read": {
        const account = await this.timed(
          this.metadataQuery().accountInfo(),
          30000,
          "Claude account",
        );
        return { account: { ...account, type: "claude-code" } };
      }
      case "account/rateLimits/read":
        return {
          available: false,
          provider: "Claude Code",
          message:
            "A stable rate-limit API is not exposed by this adapter. Token usage and cost are shown after each completed turn. Use Claude Code /usage for plan limits.",
        };
      case "skills/list":
        return {
          provider: "Claude Code",
          commands: await this.timed(
            this.metadataQuery().supportedCommands(),
            30000,
            "Claude skills",
          ),
          note: "Claude Code skills use /skill-name syntax; Codex $skill-name syntax is provider-specific.",
        };
      case "mcpServerStatus/list":
        return {
          data: await this.timed(
            this.metadataQuery().mcpServerStatus(),
            30000,
            "Claude MCP status",
          ),
        };
      case "thread/start": {
        this.assertIdle();
        const id = randomUUID();
        this.threadId = id;
        this.fresh.add(id);
        return {
          thread: {
            id,
            name: null,
            turns: [],
            historyMode: "legacy",
            status: { type: "idle" },
          },
        };
      }
      case "thread/list": {
        const sessions = await sdk.listSessions({ dir: this.cwd() });
        const archived = new Set(this.archive?.get() ?? this.localArchived);
        const filtered = sessions
          .filter(
            (s) =>
              archived.has(s.sessionId) === !!p.archived &&
              (!p.searchTerm ||
                (s.customTitle ?? s.summary ?? "")
                  .toLowerCase()
                  .includes(p.searchTerm.toLowerCase())),
          )
          .sort((a, b) => b.lastModified - a.lastModified);
        const offset = Number(p.cursor ?? 0);
        const limit = p.limit ?? 40;
        return {
          data: filtered
            .slice(offset, offset + limit)
            .map((s) => this.sessionThread(s)),
          nextCursor:
            offset + limit < filtered.length ? String(offset + limit) : null,
        };
      }
      case "thread/resume": {
        this.assertIdle();
        this.threadId = p.threadId;
        if (this.fresh.has(p.threadId))
          return {
            thread: {
              id: p.threadId,
              turns: [],
              historyMode: "legacy",
              status: { type: "idle" },
            },
          };
        const info = await sdk.getSessionInfo(p.threadId, { dir: this.cwd() });
        if (!info)
          throw new Error(
            "Claude session was not found in this working folder.",
          );
        const messages = p.excludeTurns
          ? []
          : await sdk.getSessionMessages(p.threadId, { dir: this.cwd() });
        return {
          thread: {
            ...this.sessionThread(info),
            historyMode: "legacy",
            turns: [
              {
                id: "history-" + p.threadId,
                status: "completed",
                items: this.historyItems(messages),
              },
            ],
            status: { type: "idle" },
          },
        };
      }
      case "thread/name/set":
        await sdk.renameSession(p.threadId, p.name, { dir: this.cwd() });
        this.notice("thread/name/updated", {
          threadId: p.threadId,
          threadName: p.name,
        });
        return {};
      case "thread/fork": {
        this.assertIdle();
        const result = await sdk.forkSession(p.threadId, { dir: this.cwd() });
        return { thread: { id: result.sessionId } };
      }
      case "thread/archive":
      case "thread/unarchive": {
        this.assertIdle();
        const ids = new Set(this.archive?.get() ?? this.localArchived);
        if (method === "thread/archive") ids.add(p.threadId);
        else ids.delete(p.threadId);
        this.localArchived = [...ids];
        await this.archive?.set([...ids]);
        return {};
      }
      case "turn/start":
        return this.start(p);
      case "turn/interrupt":
        await this.interrupt(p.turnId);
        return {};
      case "turn/steer":
        throw new Error(
          "Claude Code live steering is not supported here. Stop or finish the current turn, then send a follow-up in the same session.",
        );
      case "review/start":
        return this.start({
          ...p,
          threadId: p.threadId,
          input: [
            { type: "text", text: await claudeReviewSnapshot(this.cwd()) },
          ],
          model: p.model,
          effort: p.effort,
          claudeAccess: "read-only",
        });
      case "thread/compact/start":
        throw new Error(
          "Claude session compaction is managed by Claude Code. This adapter does not expose manual compaction.",
        );
      default:
        throw new Error(
          `Claude Code does not support ${method} in this client.`,
        );
    }
  }
  private sessionThread(
    s: Awaited<ReturnType<ClaudeRuntime["listSessions"]>>[number],
  ) {
    return {
      id: s.sessionId,
      name:
        s.customTitle ?? s.summary ?? s.firstPrompt ?? "Claude conversation",
      preview: s.firstPrompt ?? s.summary ?? "",
      updatedAt: Math.floor(s.lastModified / 1000),
      cwd: s.cwd ?? this.cwd(),
      turns: [],
      historyMode: "legacy",
    };
  }
  private historyItems(
    messages: Awaited<ReturnType<ClaudeRuntime["getSessionMessages"]>>,
  ) {
    const items = new Map<string, TranscriptItem>();
    const seenText = new Set<string>();
    for (const msg of messages) {
      if (msg.parent_tool_use_id) continue;
      const message = record(msg.message);
      const content: unknown[] =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : Array.isArray(message.content)
            ? message.content
            : [];
      if (msg.type === "user") {
        const promptText = content
          .map(record)
          .filter((b) => b.type === "text")
          .map((b) => text(b.text))
          .join("\n");
        if (promptText)
          items.set(msg.uuid, {
            id: msg.uuid,
            type: "userMessage",
            content: [{ type: "text", text: promptText }],
          });
      }
      for (const [index, value] of content.entries()) {
        const block = record(value);
        if (msg.type === "assistant" && block.type === "text") {
          const key = `${msg.uuid}:${index}`;
          if (seenText.has(key)) continue;
          seenText.add(key);
          const id = `${text(message.id, msg.uuid)}:text`;
          const previous = items.get(id)?.text;
          items.set(id, {
            id,
            type: "agentMessage",
            text:
              typeof previous === "string" && previous
                ? previous + "\n\n" + text(block.text)
                : text(block.text),
          });
        } else if (block.type === "tool_use" && typeof block.id === "string")
          items.set(block.id, this.toolItem(block));
        else if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          const old = items.get(block.tool_use_id);
          if (old) items.set(old.id, this.resultItem(old, block));
        }
      }
    }
    return [...items.values()];
  }
  private access(p: ProviderParams): AccessMode {
    return (
      p.claudeAccess ??
      (p.sandboxPolicy?.type === "dangerFullAccess"
        ? "full-access"
        : p.sandboxPolicy?.type === "workspaceWrite"
          ? "agent"
          : "read-only")
    );
  }
  private async start(p: ProviderParams) {
    this.assertIdle();
    const attempt = Symbol("Claude start");
    const generation = this.generation;
    this.starting = attempt;
    try {
      if (!p.threadId || p.threadId !== this.threadId)
        throw new Error("Open this Claude session before sending.");
      const content: Exclude<
        Extract<SDKUserMessage["message"], { role: "user" }>["content"],
        string
      > = [];
      for (const input of p.input ?? []) {
        if (input.type === "text") {
          if (typeof input.text !== "string")
            throw new Error("Invalid text input");
          content.push({ type: "text", text: input.text });
        } else if (input.type === "localImage") {
          if (typeof input.path !== "string")
            throw new Error("Invalid image path");
          if (!this.readImage)
            throw new Error("Image attachment access is unavailable.");
          const data = await this.readImage(input.path);
          if (data.byteLength > 10 * 1024 * 1024)
            throw new Error("Choose an image smaller than 10 MiB.");
          const ext = extname(input.path).toLowerCase();
          const mime: Record<
            string,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
          > = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
          };
          if (!mime[ext]) throw new Error("Unsupported Claude image type");
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mime[ext],
              data: Buffer.from(data).toString("base64"),
            },
          });
        } else throw new Error(`Unsupported Claude input: ${input.type}`);
      }
      if (generation !== this.generation)
        throw new Error("Claude connection closed before the turn started.");
      this.closeInspection();
      const access = this.access(p);
      const plan = p.collaborationMode?.mode === "plan";
      const queue = new InputQueue();
      let run!: Run;
      const canUseTool: CanUseTool = (name, input, options) =>
        this.permission(run, name, input, options.signal);
      const options: Options = {
        ...this.baseOptions(),
        model: p.model || undefined,
        effort: p.effort || undefined,
        ...(this.fresh.has(p.threadId)
          ? { sessionId: p.threadId }
          : { resume: p.threadId }),
        permissionMode: plan
          ? "plan"
          : access === "full-access"
            ? "bypassPermissions"
            : access === "agent"
              ? "default"
              : "plan",
        allowDangerouslySkipPermissions: access === "full-access",
        canUseTool,
        ...(access === "read-only"
          ? {
              tools: [...READ_TOOLS],
              strictMcpConfig: true,
              hooks: { PreToolUse: [{ hooks: [claudeReadOnlyHook()] }] },
            }
          : {}),
      };
      const query = this.sdk!.query({ prompt: queue, options });
      run = {
        id: randomUUID(),
        threadId: p.threadId,
        query,
        queue,
        generation: this.generation,
        items: new Map(),
        messageId: "",
        blocks: new Map(),
        textParts: new Map(),
        finalTextSeen: new Set(),
        interrupted: false,
        finished: false,
      };
      this.active = run;
      const userId = randomUUID();
      queue.push({
        type: "user",
        uuid: userId,
        session_id: p.threadId,
        parent_tool_use_id: null,
        message: { role: "user", content },
      });
      this.notice("turn/started", {
        threadId: run.threadId,
        turn: { id: run.id, status: "inProgress" },
      });
      this.item(run, { id: userId, type: "userMessage", content: p.input });
      void this.consume(run);
      return { turn: { id: run.id, status: "inProgress" } };
    } finally {
      if (this.starting === attempt) this.starting = undefined;
    }
  }
  private async consume(run: Run) {
    try {
      for await (const message of run.query) {
        if (run.generation !== this.generation || run.finished) break;
        this.message(run, message);
        if (run.finished) break;
      }
      if (!run.finished)
        this.finish(
          run,
          run.interrupted ? "interrupted" : "failed",
          run.interrupted
            ? undefined
            : "Claude exited before returning a result.",
        );
    } catch (error) {
      if (run.generation === this.generation && !run.finished)
        this.finish(
          run,
          run.interrupted ? "interrupted" : "failed",
          run.interrupted
            ? undefined
            : String(error instanceof Error ? error.message : error),
        );
    } finally {
      run.queue.close();
      run.query.close();
    }
  }
  private message(run: Run, m: SDKMessage) {
    if ("parent_tool_use_id" in m && m.parent_tool_use_id) return;
    if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "message_start") {
        run.messageId = e.message.id;
        run.blocks.clear();
      } else if (e.type === "content_block_start") {
        run.blocks.set(e.index, { ...e.content_block });
        if (e.content_block.type === "text") {
          const parts = this.textParts(run, run.messageId);
          parts.set(String(e.index), e.content_block.text ?? "");
          this.publishText(run, run.messageId);
        }
      } else if (
        e.type === "content_block_delta" &&
        e.delta?.type === "text_delta"
      ) {
        const parts = this.textParts(run, run.messageId);
        const key = String(e.index);
        parts.set(key, (parts.get(key) ?? "") + e.delta.text);
        this.publishText(run, run.messageId);
      }
      return;
    }
    if (m.type === "assistant") {
      for (const [index, b] of (m.message?.content ?? []).entries()) {
        if (b.type === "text") {
          const seen = `${m.uuid}:${index}:${b.text}`;
          if (run.finalTextSeen.has(seen)) continue;
          run.finalTextSeen.add(seen);
          const messageId = m.message.id ?? m.uuid;
          const parts = this.textParts(run, messageId);
          const streamed = Array.from(parts.entries()).filter(
            ([key]) => !key.startsWith("final:"),
          );
          const matching =
            streamed.find(([, text]) => text === b.text) ??
            streamed
              .filter(([, text]) => b.text.startsWith(text))
              .sort((a, b) => b[1].length - a[1].length)[0];
          if (matching)
            parts.set(
              matching[0],
              b.text.length >= matching[1].length ? b.text : matching[1],
            );
          else parts.set(`final:${m.uuid ?? index}:${index}`, b.text);
          this.publishText(run, messageId);
        } else if (b.type === "tool_use") this.item(run, this.toolItem(b));
      }
      return;
    }
    if (m.type === "user") {
      for (const b of Array.isArray(m.message.content) ? m.message.content : [])
        if (b.type === "tool_result") {
          const item = run.items.get(b.tool_use_id);
          if (item) this.item(run, this.resultItem(item, b));
        }
      return;
    }
    if (m.type === "result") {
      this.fresh.delete(run.threadId);
      const usage = m.usage ?? {};
      this.notice("thread/tokenUsage/updated", {
        threadId: run.threadId,
        turnId: run.id,
        tokenUsage: {
          last: {
            totalTokens:
              (usage.input_tokens ?? 0) +
              (usage.output_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
          },
        },
      });
      this.item(run, {
        id: "usage-" + run.id,
        type: "usage",
        provider: "Claude Code",
        costUSD: m.total_cost_usd,
        usage,
        durationMs: m.duration_ms,
      });
      this.finish(
        run,
        run.interrupted
          ? "interrupted"
          : m.is_error || m.subtype !== "success"
            ? "failed"
            : "completed",
        "errors" in m && Array.isArray(m.errors)
          ? m.errors.join("\n")
          : m.is_error
            ? String("result" in m ? m.result : m.subtype)
            : undefined,
      );
      return;
    }
    if (m.type === "system" && m.subtype === "init")
      this.fresh.delete(run.threadId);
    if (m.type === "system" && m.subtype === "status" && m.status)
      this.notice("provider/status", {
        threadId: run.threadId,
        message: m.status,
      });
  }
  private textParts(run: Run, messageId: string) {
    let parts = run.textParts.get(messageId);
    if (!parts) {
      parts = new Map();
      run.textParts.set(messageId, parts);
    }
    return parts;
  }
  /** SDK final assistant events are per block: array index is not the stream block index. */
  private publishText(run: Run, messageId: string) {
    const id = `${messageId}:text`;
    const text = Array.from(this.textParts(run, messageId).values()).join(
      "\n\n",
    );
    const previous = run.items.get(id)?.text;
    if (previous === text) return;
    if (typeof previous === "string" && text.startsWith(previous)) {
      run.items.set(id, { id, type: "agentMessage", text });
      this.notice("item/agentMessage/delta", {
        threadId: run.threadId,
        turnId: run.id,
        itemId: id,
        delta: text.slice(previous.length),
      });
    } else this.item(run, { id, type: "agentMessage", text });
  }
  private toolItem(value: unknown): TranscriptItem {
    const block = record(value);
    const input = record(block.input);
    const name = text(block.name);
    const id = text(block.id);
    if (name === "Bash" || name === "PowerShell")
      return {
        id,
        type: "commandExecution",
        command: text(input.command, name),
        cwd: this.cwd(),
        status: "inProgress",
        aggregatedOutput: "",
        exitCode: null,
      };
    if (["Write", "Edit", "MultiEdit"].includes(name))
      return {
        id,
        type: "fileChange",
        status: "inProgress",
        changes: [
          {
            path: text(input.file_path, "Unknown path"),
            diff:
              name === "Write"
                ? String(input.content ?? "")
                : `${text(input.old_string)}\n→\n${text(input.new_string, JSON.stringify(input.edits ?? []))}`,
            kind: { type: "update" },
          },
        ],
      };
    return {
      id,
      type: "mcpToolCall",
      server: name.startsWith("mcp__") ? name.split("__")[1] : "Claude Code",
      tool: name,
      arguments: input,
      status: "inProgress",
    };
  }
  private resultItem(old: TranscriptItem, value: unknown): TranscriptItem {
    const block = record(value);
    const text =
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content ?? "");
    return {
      ...old,
      status: block.is_error ? "failed" : "completed",
      ...(old.type === "commandExecution"
        ? { aggregatedOutput: text }
        : { result: text }),
    };
  }
  private item(run: Run, item: TranscriptItem) {
    run.items.set(item.id, item);
    this.notice("item/completed", {
      threadId: run.threadId,
      turnId: run.id,
      item,
    });
  }
  private notice(method: string, p: Json) {
    this.emit("notification", method, p);
  }
  private permission(
    run: Run,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (!run || run.finished || signal.aborted)
      return Promise.resolve({
        behavior: "deny",
        message: "Request cancelled",
      });
    const id = "claude-" + randomUUID();
    return new Promise((resolve) => {
      const onAbort = () =>
        this.resolvePermission(id, {
          behavior: "deny",
          message: "Request cancelled",
        });
      const questions =
        toolName === "AskUserQuestion"
          ? Array.isArray(input.questions)
            ? input.questions.map(record)
            : []
          : undefined;
      const pending: Pending = {
        run,
        input,
        questions,
        finish: (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      };
      this.pending.set(id, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit("request", {
        id,
        method: questions
          ? "item/tool/requestUserInput"
          : "claude/tool/requestApproval",
        params: {
          threadId: run.threadId,
          turnId: run.id,
          providerLabel: "Claude Code",
          tool: toolName,
          input,
          cwd: this.cwd(),
          command:
            typeof input.command === "string" ? input.command : undefined,
          reason:
            typeof input.description === "string"
              ? input.description
              : `Claude Code requests ${toolName}`,
          questions: questions?.map((q, index) => ({
            ...q,
            id: String(index),
            isOther: true,
            isSecret: false,
          })),
        },
      });
    });
  }
  respond(id: RpcId, result: Record<string, unknown>) {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.questions) {
      const answers: Record<string, string> = {};
      for (const [index, q] of p.questions.entries()) {
        const values = record(record(result.answers)[String(index)]).answers;
        const key = text(q.question);
        if (key && Array.isArray(values)) {
          const selected = values.filter(
            (value: unknown): value is string => typeof value === "string",
          );
          if (selected.length) answers[key] = selected.join(", ");
        }
      }
      if (!Object.keys(answers).length)
        this.resolvePermission(id, {
          behavior: "deny",
          message: "User cancelled the question",
        });
      else
        this.resolvePermission(id, {
          behavior: "allow",
          updatedInput: { ...p.input, answers },
        });
    } else
      this.resolvePermission(
        id,
        result.decision === "accept"
          ? { behavior: "allow", updatedInput: p.input }
          : { behavior: "deny", message: "User denied the tool request" },
      );
  }
  rejectRequest(id: RpcId, message = "Unsupported client request") {
    this.resolvePermission(id, { behavior: "deny", message });
  }
  private resolvePermission(id: RpcId, result: PermissionResult) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.finish(result);
    this.notice("serverRequest/resolved", {
      threadId: p.run.threadId,
      requestId: id,
    });
  }
  private finish(run: Run, status: string, message?: string) {
    if (run.finished) return;
    run.finished = true;
    for (const [id, p] of this.pending)
      if (p.run === run)
        this.resolvePermission(id, {
          behavior: "deny",
          message: "Turn finished",
        });
    if (this.active === run) this.active = undefined;
    this.notice("turn/completed", {
      threadId: run.threadId,
      turn: { id: run.id, status, ...(message ? { error: { message } } : {}) },
    });
  }
  private async interrupt(id: string) {
    const run = this.active;
    if (!run || run.id !== id) return;
    run.interrupted = true;
    for (const [request, p] of this.pending)
      if (p.run === run)
        this.resolvePermission(request, {
          behavior: "deny",
          message: "User interrupted",
        });
    try {
      await this.timed(run.query.interrupt(), 4000, "Claude interrupt");
    } finally {
      if (!run.finished) {
        run.queue.close();
        run.query.close();
        this.finish(run, "interrupted");
      }
    }
  }
  private assertIdle() {
    if (this.active || this.starting)
      throw new Error("Stop the current Claude turn before this action.");
  }
  disconnect() {
    this.generation++;
    this.starting = undefined;
    this.connecting = undefined;
    for (const id of this.pending.keys())
      this.resolvePermission(id, {
        behavior: "deny",
        message: "Claude connection closed",
      });
    const run = this.active;
    this.active = undefined;
    if (run) {
      run.finished = true;
      run.queue.close();
      run.query.close();
    }
    this.closeInspection();
    this.ready = false;
    this.emit(
      "disconnected",
      new Error(
        "Claude Code connection closed. Reconnect to resume saved history.",
      ),
    );
  }
}
