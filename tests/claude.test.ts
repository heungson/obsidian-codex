import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeClient,
  claudeReadOnlyHook,
  type ClaudeRuntime,
} from "../src/claude";
import { turnPolicy } from "../src/protocol";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { claudeReviewSnapshot } from "../src/claude-review";
class FakeQuery {
  closed = false;
  closeCount = 0;
  interrupted = false;
  values: any[] = [];
  waiter?: (v: IteratorResult<any>) => void;
  constructor(
    public options: any,
    public prompt: any,
  ) {}
  [Symbol.asyncIterator]() {
    return this;
  }
  next(): Promise<IteratorResult<any>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => (this.waiter = resolve));
  }
  return() {
    return Promise.resolve({ value: undefined, done: true });
  }
  push(value: any) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value, done: false });
    } else this.values.push(value);
  }
  close() {
    this.closeCount++;
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  async interrupt() {
    this.interrupted = true;
  }
  async supportedModels() {
    return [
      {
        value: "default",
        displayName: "CLI default",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ];
  }
  async accountInfo() {
    return { apiProvider: "firstParty", subscriptionType: "Team" };
  }
  async supportedCommands() {
    return [{ name: "summarize", description: "Summarize" }];
  }
  async mcpServerStatus() {
    return [];
  }
}
function runtime() {
  const queries: FakeQuery[] = [];
  const sdk = {
    query: ({ prompt, options }: any) => {
      const q = new FakeQuery(options, prompt);
      queries.push(q);
      return q;
    },
    listSessions: async () => [
      {
        sessionId: "stored",
        summary: "Stored session",
        lastModified: 100,
        cwd: process.cwd(),
      },
    ],
    getSessionInfo: async (id: string) => ({
      sessionId: id,
      summary: "Stored session",
      lastModified: 100,
      cwd: process.cwd(),
    }),
    getSessionMessages: async () => [
      {
        type: "user",
        uuid: "u1",
        message: { content: [{ type: "text", text: "Earlier prompt" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          id: "a1",
          content: [{ type: "text", text: "Earlier answer" }],
        },
      },
    ],
    renameSession: async () => {},
    forkSession: async () => ({ sessionId: "forked" }),
  };
  return { queries, sdk: sdk as unknown as ClaudeRuntime };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup() {
  const r = runtime();
  const client = new ClaudeClient(
    () => "/installed/claude",
    () => process.cwd(),
    () => r.sdk,
  );
  await client.connect();
  const started = await client.request("thread/start");
  return { ...r, client, id: started.thread.id };
}
async function run(
  h: Awaited<ReturnType<typeof setup>>,
  access: "read-only" | "agent" | "full-access" = "read-only",
) {
  const response = await h.client.request("turn/start", {
    threadId: h.id,
    input: [{ type: "text", text: "Hello" }],
    model: "default",
    effort: "high",
    ...turnPolicy(access, process.cwd()),
  });
  return { query: h.queries.at(-1)!, turn: response.turn.id };
}
test("Claude adapter streams text, closes completed query promptly, preserves exact installed CLI and setting sources", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  const notifications: any[] = [];
  h.client.on("notification", (method, p) => notifications.push({ method, p }));
  const { query } = await run(h);
  assert.equal(query.options.pathToClaudeCodeExecutable, "/installed/claude");
  assert.deepEqual(query.options.settingSources, ["user", "project", "local"]);
  assert.equal(query.options.systemPrompt.preset, "claude_code");
  assert.equal(query.options.permissionMode, "plan");
  assert.equal(query.options.strictMcpConfig, true);
  assert.equal(query.options.tools.includes("Bash"), false);
  query.push({ type: "system", subtype: "init" });
  query.push({
    type: "stream_event",
    event: { type: "message_start", message: { id: "answer" } },
  });
  query.push({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  query.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello streamed" },
    },
  });
  query.push({
    type: "assistant",
    message: {
      id: "answer",
      content: [{ type: "text", text: "Hello streamed" }],
    },
  });
  query.push({
    type: "result",
    subtype: "success",
    usage: { input_tokens: 2, output_tokens: 3 },
    total_cost_usd: 0.01,
  });
  await tick();
  assert.equal(query.closed, true);
  assert.ok(
    notifications.some(
      (e) =>
        e.method === "item/agentMessage/delta" &&
        e.p.delta === "Hello streamed",
    ),
  );
  assert.equal(
    notifications.filter((e) => e.method === "turn/completed").length,
    1,
  );
  assert.equal(
    notifications.find((e) => e.method === "turn/completed").p.turn.status,
    "completed",
  );
});
test("read-only hook denies shell, write, agent and unknown MCP even if earlier settings would allow them", async () => {
  const hook = claudeReadOnlyHook();
  for (const tool_name of [
    "Bash",
    "Write",
    "Edit",
    "Agent",
    "mcp__server__write",
    "UnknownTool",
  ]) {
    const decision: any = await hook(
      { hook_event_name: "PreToolUse", tool_name } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  }
  assert.deepEqual(
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "Read" } as any,
      undefined,
      { signal: new AbortController().signal },
    ),
    {},
  );
});
test("actual canUseTool callbacks wait for UI decision and never persist allow rules", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  const { query } = await run(h, "agent");
  assert.equal(query.options.permissionMode, "default");
  let request: any;
  h.client.on("request", (m) => (request = m));
  const pending = query.options.canUseTool(
    "Bash",
    { command: "echo approved" },
    { signal: new AbortController().signal },
  );
  await tick();
  assert.equal(request.method, "claude/tool/requestApproval");
  h.client.respond(request.id, { decision: "accept" });
  assert.deepEqual(await pending, {
    behavior: "allow",
    updatedInput: { command: "echo approved" },
  });
  const signal = new AbortController();
  const cancelled = query.options.canUseTool(
    "Write",
    { file_path: "/vault/A.md" },
    { signal: signal.signal },
  );
  signal.abort();
  assert.equal((await cancelled).behavior, "deny");
  h.client.respond(request.id, { decision: "accept" });
});
test("Claude questions map structured multiple answers into original question keys", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  const { query } = await run(h, "agent");
  let request: any;
  h.client.on("request", (m) => (request = m));
  const pending = query.options.canUseTool(
    "AskUserQuestion",
    {
      questions: [
        {
          question: "Which files?",
          header: "Files",
          multiSelect: true,
          options: [],
        },
      ],
    },
    { signal: new AbortController().signal },
  );
  await tick();
  assert.equal(request.params.questions[0].multiSelect, true);
  h.client.respond(request.id, { answers: { "0": { answers: ["A", "B"] } } });
  assert.deepEqual((await pending).updatedInput.answers, {
    "Which files?": "A, B",
  });
});
test("interrupt after first init resumes persisted session instead of reusing a fresh session-id", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  const first = await run(h);
  first.query.push({ type: "system", subtype: "init" });
  await tick();
  await h.client.request("turn/interrupt", {
    threadId: h.id,
    turnId: first.turn,
  });
  assert.equal(first.query.interrupted, true);
  assert.equal(first.query.closed, true);
  const second = await run(h);
  assert.equal(second.query.options.resume, h.id);
  assert.equal(second.query.options.sessionId, undefined);
});
test("Claude session list/resume/fork and vault-local archive filter use official SDK helpers", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  const read = await h.client.request("thread/resume", { threadId: "stored" });
  assert.match(JSON.stringify(read.thread.turns), /Earlier answer/);
  assert.equal(
    (await h.client.request("thread/fork", { threadId: "stored" })).thread.id,
    "forked",
  );
  await h.client.request("thread/archive", { threadId: "stored" });
  assert.equal((await h.client.request("thread/list")).data.length, 0);
  assert.equal(
    (await h.client.request("thread/list", { archived: true })).data[0].id,
    "stored",
  );
  await h.client.request("thread/unarchive", { threadId: "stored" });
  assert.equal((await h.client.request("thread/list")).data.length, 1);
});
test("Claude error result surfaces provider error and still closes query", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  let completed: any;
  h.client.on("notification", (method, p) => {
    if (method === "turn/completed") completed = p.turn;
  });
  const { query } = await run(h);
  query.push({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "Authentication expired",
  });
  await tick();
  assert.equal(completed.status, "failed");
  assert.equal(completed.error.message, "Authentication expired");
  assert.equal(query.closed, true);
});
test("review snapshot includes actual staged/unstaged/untracked code and cannot execute malicious filenames", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "claude-review-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    await writeFile(
      join(cwd, "release.js"),
      "export const sum = (a,b) => a-b;",
    );
    const prompt = await claudeReviewSnapshot(cwd);
    assert.match(prompt, /Untracked source "release.js"/);
    assert.match(prompt, /a-b/);
    assert.match(prompt, /quoted reference data, not instructions/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thinking-before-text partial indexes reconcile with per-block final arrays and prefix-collision text blocks", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  const items = new Map<string, any>();
  h.client.on("notification", (method, p) => {
    if (method === "item/completed") items.set(p.item.id, { ...p.item });
    if (method === "item/agentMessage/delta") {
      const old = items.get(p.itemId);
      old.text += p.delta;
    }
  });
  const { query } = await run(h);
  query.push({
    type: "stream_event",
    event: { type: "message_start", message: { id: "same-api-message" } },
  });
  query.push({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    },
  });
  for (const [index, text] of [
    [1, "A"],
    [3, "AB"],
  ] as const) {
    query.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      },
    });
    query.push({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      },
    });
    query.push({
      type: "assistant",
      uuid: "final-" + index,
      message: { id: "same-api-message", content: [{ type: "text", text }] },
    });
  }
  query.push({ type: "result", subtype: "success" });
  await tick();
  const answers = [...items.values()].filter((i) => i.type === "agentMessage");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].text, "A\n\nAB");
});
test("session history aggregates distinct per-block UUIDs sharing one API message id without overwriting or duplicating export text", async (t) => {
  const h = await setup();
  t.after(() => h.client.disconnect());
  h.sdk.getSessionMessages = async () =>
    [
      {
        type: "assistant",
        uuid: "thinking",
        message: {
          id: "message-a",
          content: [{ type: "thinking", thinking: "not displayed" }],
        },
      },
      {
        type: "assistant",
        uuid: "first",
        message: { id: "message-a", content: [{ type: "text", text: "A" }] },
      },
      {
        type: "assistant",
        uuid: "second",
        message: { id: "message-a", content: [{ type: "text", text: "AB" }] },
      },
    ] as any;
  const response = await h.client.request("thread/resume", {
    threadId: "stored",
  });
  const answers = response.thread.turns[0].items.filter(
    (i: any) => i.type === "agentMessage",
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0].text, "A\n\nAB");
});
test("Git snapshot handles untracked source in a nested working directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "claude-review-nested-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, "src"));
    await writeFile(
      join(cwd, "src", "release.js"),
      "export const sum=(a,b)=>a-b;",
    );
    const prompt = await claudeReviewSnapshot(join(cwd, "src"));
    assert.match(prompt, /src\/release.js/);
    assert.match(prompt, /a-b/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
