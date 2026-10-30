import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Window } from "happy-dom";
let host: any;
const hostPromise = build({
  entryPoints: ["tests/ui-entry.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  alias: { obsidian: resolve("tests/obsidian-mock.ts") },
}).then(
  (bundle) =>
    import(
      "data:text/javascript;base64," +
        Buffer.from(bundle.outputFiles[0].text).toString("base64")
    ),
);
function setupDOM() {
  const window = new Window({ url: "https://obsidian.test" });
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "MouseEvent",
    "KeyboardEvent",
    "Event",
    "navigator",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: (window as any)[key],
    });
  const proto = window.HTMLElement.prototype as any;
  proto.createEl = function (tag: string, options: any = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (options.text != null) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    for (const [key, value] of Object.entries(options.attr ?? {}))
      el.setAttribute(key, String(value));
    for (const key of ["type", "value", "placeholder"])
      if (options[key] != null) el[key] = options[key];
    this.append(el);
    return el;
  };
  proto.createDiv = function (options: any) {
    return this.createEl("div", options);
  };
  proto.createSpan = function (options: any) {
    return this.createEl("span", options);
  };
  proto.empty = function () {
    this.replaceChildren();
  };
  proto.setText = function (text: string) {
    this.textContent = text;
  };
  proto.addClass = function (cls: string) {
    this.classList.add(cls);
  };
  return window;
}
class FakeClient extends EventEmitter {
  ready = true;
  calls: { method: string; params: any }[] = [];
  responses: any[] = [];
  rejected: any[] = [];
  handler: (m: string, p: any) => any = () => undefined;
  async connect() {}
  disconnect() {
    this.ready = false;
    this.emit("disconnected", new Error("closed"));
  }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    const custom = await this.handler(method, params);
    if (custom !== undefined) return custom;
    if (method === "model/list")
      return {
        data: [
          {
            model: "gpt-6.1-sol",
            displayName: "GPT-6.1 Sol",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            defaultReasoningEffort: "high",
            inputModalities: ["text", "image"],
          },
        ],
      };
    if (method === "account/read")
      return { account: { type: "chatgpt", email: "person@example.test" } };
    if (method === "thread/start")
      return { thread: { id: "thread-1", name: null } };
    if (method === "thread/resume")
      return {
        thread: {
          id: params.threadId,
          name: "Saved conversation",
          turns: [],
          historyMode: "legacy",
        },
      };
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  }
  respond(id: any, result: any) {
    this.responses.push({ id, result });
  }
  rejectRequest(id: any, message: any) {
    this.rejected.push({ id, message });
  }
}
const flush = () => new Promise((r) => setTimeout(r, 90));
async function harness(settings: any = {}) {
  host = await hostPromise;
  setupDOM();
  const files = new Map<string, any>();
  const created: any[] = [];
  const app: any = {
    savedSettings: settings,
    vault: {
      adapter: new host.FileSystemAdapter("/vault"),
      getFiles: () => [...files.values()],
      getAbstractFileByPath: (p: string) => files.get(p),
      read: async (f: any) => f.text,
      createFolder: async (p: string) => files.set(p, { path: p }),
      create: async (p: string, text: string) => {
        const f = new host.TFile(p, text);
        files.set(p, f);
        created.push(f);
        return f;
      },
    },
    workspace: {
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      activeEditor: null,
      on: (name: string, callback: Function) => {
        const ref = { name, callback };
        ((app as any).workspaceEvents ??= []).push(ref);
        return ref;
      },
      offref: (ref: any) => {
        (app as any).workspaceEvents = (
          (app as any).workspaceEvents ?? []
        ).filter((item: any) => item !== ref);
      },
      getLeavesOfType: () => [],
      getLeaf: () => ({ openFile: async () => {} }),
    },
  };
  const plugin = new host.CodexPlugin(app);
  await plugin.onload();
  const client = new FakeClient();
  plugin.client = client;
  const leaf = { app };
  const view = plugin.views.get("obsidian-codex-chat")(leaf);
  await view.onOpen();
  return { app, plugin, client, view, created, files };
}
function click(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll("button")].find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text,
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `Missing button ${text}`);
  button.click();
}
function event(client: FakeClient, method: string, params: any) {
  client.emit("notification", method, { threadId: "thread-1", ...params });
}
test("plugin migrates synced foreign paths before client creation and saves local edits without overwriting the other OS", async (t) => {
  const foreign =
    process.platform === "win32"
      ? {
          executable: "/Users/other/bin/codex",
          claudeExecutable: "/Users/other/bin/claude",
          cwd: "/Users/other/vault",
        }
      : {
          executable: "C:\\tools\\codex.exe",
          claudeExecutable: "C:\\tools\\claude.exe",
          cwd: "C:\\vault",
        };
  const foreignPlatform = process.platform === "win32" ? "darwin" : "win32";
  const h = await harness(foreign);
  t.after(() => h.view.onClose());
  assert.equal(h.plugin.settings.executable, "");
  assert.equal(h.plugin.settings.claudeExecutable, "");
  assert.equal(h.plugin.cwd(), "/vault");
  assert.deepEqual(h.app.savedSettings.platformPaths[foreignPlatform], foreign);
  h.plugin.settings.executable = process.execPath;
  await h.plugin.save();
  assert.equal(
    h.app.savedSettings.platformPaths[process.platform].executable,
    process.execPath,
  );
  assert.deepEqual(h.app.savedSettings.platformPaths[foreignPlatform], foreign);
});
test("compact pickers retain choices, dismiss with keyboard/outside focus, and close while busy", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  const model = document.querySelector<HTMLButtonElement>(
    ".codex-model-trigger",
  )!;
  const mode = document.querySelector<HTMLButtonElement>(
    ".codex-mode-trigger",
  )!;
  assert.equal(document.querySelectorAll(".codex-options select").length, 0);
  model.click();
  assert.equal(model.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement?.getAttribute("role"), "option");
  assert.equal(document.activeElement?.getAttribute("aria-selected"), "true");
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(document.querySelector(".codex-composer-popover"), null);
  assert.equal(document.activeElement, model);
  mode.click();
  const select = document.querySelector<HTMLSelectElement>(
    '[aria-label="Collaboration mode"]',
  )!;
  select.value = "plan";
  select.dispatchEvent(new Event("change"));
  await flush();
  assert.equal(h.app.savedSettings.plan, true);
  assert.match(mode.textContent!, /Plan · Read-only/);
  document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  assert.equal(document.querySelector(".codex-composer-popover"), null);
  model.click();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  assert.equal(model.getAttribute("aria-expanded"), "false");
  model.click();
  await h.view.ensureThread();
  event(h.client, "turn/started", {
    turn: { id: "busy", status: "inProgress" },
  });
  assert.equal(document.querySelector(".codex-composer-popover"), null);
  assert.equal(model.disabled, true);
  event(h.client, "turn/completed", {
    turn: { id: "busy", status: "completed" },
  });
  assert.equal(model.disabled, false);
});
test("compact permissions require confirmation and reject a stale confirmation during work", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  const openConfirmation = () => {
    document.querySelector<HTMLButtonElement>(".codex-mode-trigger")!.click();
    const select = document.querySelector<HTMLSelectElement>(
      '[aria-label="Permissions"]',
    )!;
    select.value = "full-access";
    select.dispatchEvent(new Event("change"));
  };
  openConfirmation();
  assert.equal(h.plugin.settings.access, "read-only");
  click("Keep current permissions");
  assert.equal(h.plugin.settings.access, "read-only");
  openConfirmation();
  await h.view.ensureThread();
  event(h.client, "turn/started", {
    turn: { id: "busy", status: "inProgress" },
  });
  click("Enable full access");
  await flush();
  assert.equal(h.plugin.settings.access, "read-only");
  click("Keep current permissions");
});
test("view sends note snapshot with explicit read-only/plan policies; completion before response leaves Send enabled", async (t) => {
  const h = await harness({ plan: true });
  t.after(() => h.view.onClose());
  h.view.attach({ label: "Note.md", text: "ORBIT-731" });
  h.client.handler = (method, params) => {
    if (method === "turn/start") {
      event(h.client, "item/started", {
        item: { id: "u1", type: "userMessage", content: params.input },
      });
      event(h.client, "item/completed", {
        item: { id: "a1", type: "agentMessage", text: "ORBIT-731" },
      });
      event(h.client, "turn/completed", {
        turn: { id: "turn-1", status: "completed" },
      });
      return { turn: { id: "turn-1" } };
    }
  };
  const input = document.querySelector("textarea")!;
  input.value = "Find the reference";
  click("Send");
  await flush();
  const call = h.client.calls.find((c) => c.method === "turn/start")!;
  assert.deepEqual(call.params.sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
  assert.equal(call.params.approvalsReviewer, "user");
  assert.equal(call.params.collaborationMode.mode, "plan");
  assert.match(call.params.input[0].text, /ORBIT-731/);
  assert.equal(
    (
      document.querySelector(
        ".codex-send-row button:last-child",
      ) as HTMLButtonElement
    ).disabled,
    false,
  );
  assert.equal(input.value, "");
  assert.match(
    document.querySelector(".codex-header strong")!.textContent!,
    /Find the reference/,
  );
  assert.equal(
    document.querySelector(".codex-userMessage .codex-message>div")!
      .textContent,
    "Find the reference",
  );
  assert.equal(
    document.querySelector(".codex-userMessage details")!.hasAttribute("open"),
    false,
  );
});
test("history searches working folder and resumes selected paginated conversation", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  h.client.handler = (method) => {
    if (method === "thread/list")
      return {
        data: [{ id: "history-1", name: "History test", updatedAt: 1 }],
        nextCursor: null,
      };
    if (method === "thread/resume")
      return {
        thread: {
          id: "history-1",
          name: "History test",
          historyMode: "paginated",
          turns: [],
        },
      };
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: "old-turn",
            status: "completed",
            items: [
              { id: "answer", type: "agentMessage", text: "Restored answer" },
            ],
          },
        ],
        nextCursor: "older",
      };
  };
  click("Conversation history");
  await flush();
  assert.equal(
    h.client.calls.find((c) => c.method === "thread/list")!.params.cwd,
    "/vault",
  );
  click("History test", document.querySelector(".modal")!);
  await flush();
  assert.equal(h.plugin.settings.lastThreadId, "history-1");
  assert.match(
    document.querySelector(".codex-transcript")!.textContent!,
    /Restored answer/,
  );
  assert.ok(
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Load earlier messages",
    ),
  );
  assert.equal(document.querySelector(".modal"), null);
});
test("full-history export reads additional pages and saves Markdown through vault API", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  h.client.handler = (method, params) => {
    if (method === "thread/resume")
      return {
        thread: {
          id: "history-1",
          name: "Export test",
          historyMode: "paginated",
          turns: [],
        },
      };
    if (method === "thread/turns/list") {
      if (params.limit === 30)
        return {
          data: [
            {
              id: "t2",
              items: [
                { id: "a2", type: "agentMessage", text: "Recent answer" },
              ],
            },
          ],
          nextCursor: "older",
        };
      return params.cursor
        ? {
            data: [
              {
                id: "t1",
                items: [
                  { id: "a1", type: "agentMessage", text: "Earlier answer" },
                ],
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              {
                id: "t2",
                items: [
                  { id: "a2", type: "agentMessage", text: "Recent answer" },
                ],
              },
            ],
            nextCursor: "older",
          };
    }
  };
  await h.view.resume("history-1");
  click("⋯");
  click("Export conversation to note");
  await flush();
  assert.equal(h.created.length, 1);
  assert.match(h.created[0].path, /^Codex conversations\/Export test/);
  assert.match(h.created[0].text, /Earlier answer/);
  assert.match(h.created[0].text, /Recent answer/);
  assert.ok(
    h.created[0].text.indexOf("Earlier answer") <
      h.created[0].text.indexOf("Recent answer"),
  );
});
test("approval dismiss denies once; resolved requests do not send duplicate denial; unrelated thread rejected", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  await h.view.ensureThread();
  h.client.emit("request", {
    id: 12,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", command: "echo safe" },
  });
  await flush();
  assert.match(document.querySelector(".modal")!.textContent!, /echo safe/);
  click("Cancel / deny");
  assert.deepEqual(h.client.responses, [
    { id: 12, result: { decision: "decline" } },
  ]);
  h.client.emit("request", {
    id: 13,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1" },
  });
  await flush();
  event(h.client, "serverRequest/resolved", { requestId: 13 });
  assert.equal(document.querySelector(".modal"), null);
  assert.equal(h.client.responses.length, 1);
  h.client.emit("request", {
    id: 14,
    method: "item/permissions/requestApproval",
    params: { threadId: "another-thread", permissions: {} },
  });
  assert.equal(h.client.rejected[0].id, 14);
});
test("structured user input submits selected answer; permission grant is scoped to turn", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  await h.view.ensureThread();
  h.client.emit("request", {
    id: 15,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      questions: [
        {
          id: "q1",
          header: "Scope",
          question: "Which scope?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Note", description: "One note" }],
        },
      ],
    },
  });
  await flush();
  const select = document.querySelector(".modal select") as HTMLSelectElement;
  select.value = "Note";
  click("Submit answers");
  assert.deepEqual(h.client.responses[0], {
    id: 15,
    result: { answers: { q1: { answers: ["Note"] } } },
  });
  h.client.emit("request", {
    id: 16,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      permissions: { network: { enabled: true }, fileSystem: null },
    },
  });
  await flush();
  click("Grant for this turn");
  assert.deepEqual(h.client.responses[1], {
    id: 16,
    result: { permissions: { network: { enabled: true } }, scope: "turn" },
  });
});
test("review reapplies newly selected read-only policy before starting reviewer", async (t) => {
  const h = await harness({ access: "full-access" });
  t.after(() => h.view.onClose());
  await h.view.ensureThread();
  h.plugin.settings.access = "read-only";
  h.client.handler = (method) =>
    method === "review/start" ? { turn: { id: "review-turn" } } : undefined;
  click("⋯");
  click("Review uncommitted Git changes");
  await flush();
  const resume = h.client.calls.find((c) => c.method === "thread/resume")!;
  assert.equal(resume.params.sandbox, "read-only");
  assert.equal(resume.params.approvalPolicy, "on-request");
  assert.ok(
    h.client.calls.findIndex((c) => c.method === "thread/resume") <
      h.client.calls.findIndex((c) => c.method === "review/start"),
  );
});

test("real CLI review lifecycle with differing response and runtime IDs unlocks all controls on canonical completion", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  await h.view.ensureThread();
  h.client.handler = (method) =>
    method === "review/start"
      ? { turn: { id: "review-operation", status: "inProgress" } }
      : undefined;
  h.view.runAction("review");
  await flush();
  event(h.client, "turn/started", {
    turn: { id: "runtime-turn", status: "inProgress" },
  });
  assert.equal(
    (
      document.querySelector(
        ".codex-send-row button:last-child",
      ) as HTMLButtonElement
    ).textContent,
    "Steer",
  );
  event(h.client, "item/completed", {
    turnId: "review-operation",
    item: {
      id: "finding",
      type: "agentMessage",
      text: "The sum function subtracts.",
    },
  });
  event(h.client, "turn/completed", {
    turn: { id: "review-operation", status: "completed" },
  });
  await flush();
  for (const select of document.querySelectorAll(".codex-options button"))
    assert.equal((select as HTMLButtonElement).disabled, false);
  const buttons = Array.from(
    document.querySelectorAll(".codex-send-row button"),
  ) as HTMLButtonElement[];
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].textContent, "Send");
  assert.equal(buttons[1].disabled, false);
  assert.equal(
    document.querySelector(".codex-status")?.textContent,
    "Turn completed",
  );
  assert.match(
    document.querySelector(".codex-transcript")!.textContent!,
    /sum function subtracts/,
  );
});
test("authoritative idle clears stale review busy state before completion notification", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  await h.view.ensureThread();
  h.client.handler = (method) =>
    method === "review/start"
      ? { turn: { id: "review-operation" } }
      : undefined;
  h.view.runAction("review");
  await flush();
  event(h.client, "turn/started", {
    turn: { id: "runtime-turn", status: "inProgress" },
  });
  event(h.client, "thread/status/changed", { status: { type: "idle" } });
  assert.equal(
    (
      document.querySelector(
        ".codex-send-row button:last-child",
      ) as HTMLButtonElement
    ).textContent,
    "Send",
  );
  event(h.client, "turn/completed", {
    turn: { id: "review-operation", status: "completed" },
  });
  assert.equal(
    (document.querySelector(".codex-options button") as HTMLButtonElement)
      .disabled,
    false,
  );
});

test("provider switch locks rapid switching and sending, clears context, and restores separate preferences and sessions", async (t) => {
  const h = await harness({
    model: "gpt-6.1-sol",
    effort: "high",
    lastThreadId: "codex-session",
    providerStates: {
      claude: {
        model: "default",
        effort: "low",
        access: "read-only",
        plan: false,
        lastThreadId: "claude-session",
      },
    },
  });
  t.after(() => h.view.onClose());
  const claude = new FakeClient();
  claude.handler = (method, params) => {
    if (method === "model/list")
      return {
        data: [
          {
            model: "default",
            displayName: "Claude default",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "high" },
            ],
            defaultReasoningEffort: "high",
            inputModalities: ["text", "image"],
          },
        ],
      };
    if (method === "thread/resume")
      return {
        thread: {
          id: params.threadId,
          name: "Claude restored",
          historyMode: "legacy",
          turns: [],
        },
      };
  };
  h.plugin.createClient = () =>
    h.plugin.settings.provider === "claude" ? claude : h.client;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const save = h.plugin.save.bind(h.plugin);
  h.plugin.save = async () => {
    await gate;
    await save();
  };
  h.view.attach({ label: "Codex-only.md", text: "Old context" });
  const switching = h.view.changeProvider("claude");
  await new Promise((resolve) => setImmediate(resolve));
  const input = document.querySelector("textarea")!;
  input.value = "Do not send during switching";
  await h.view.send();
  await h.view.changeProvider("codex");
  assert.equal(h.plugin.settings.provider, "claude");
  assert.equal(
    claude.calls.some((c) => c.method === "turn/start"),
    false,
  );
  assert.equal(
    (
      document.querySelector(
        ".codex-send-row button:last-child",
      ) as HTMLButtonElement
    ).disabled,
    true,
  );
  release();
  await switching;
  assert.equal(h.plugin.settings.model, "default");
  assert.equal(h.plugin.settings.effort, "low");
  assert.equal(h.plugin.settings.lastThreadId, "claude-session");
  assert.equal(input.value, "");
  assert.equal(document.querySelector(".codex-attachments")!.textContent, "");
  assert.match(input.placeholder, /Claude Code/);
  assert.equal(
    (
      document.querySelector(
        ".codex-send-row button:last-child",
      ) as HTMLButtonElement
    ).disabled,
    false,
  );
  await h.view.changeProvider("codex");
  assert.equal(h.plugin.settings.model, "gpt-6.1-sol");
  assert.equal(h.plugin.settings.effort, "high");
  assert.equal(h.plugin.settings.lastThreadId, "codex-session");
  assert.equal(h.plugin.client, h.client);
});
test("Claude approval shows provider/file target and multi-select question returns all selected labels", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  await h.view.ensureThread();
  h.client.emit("request", {
    id: 21,
    method: "claude/tool/requestApproval",
    params: {
      threadId: "thread-1",
      providerLabel: "Claude Code",
      tool: "Write",
      input: { file_path: "/vault/A.md" },
    },
  });
  await flush();
  assert.match(
    document.querySelector(".modal")!.textContent!,
    /Claude Code requests approval/,
  );
  assert.match(
    document.querySelector(".modal")!.textContent!,
    /File: \/vault\/A.md/,
  );
  click("Cancel / deny");
  h.client.emit("request", {
    id: 22,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      providerLabel: "Claude Code",
      questions: [
        {
          id: "q",
          header: "Files",
          question: "Which files?",
          multiSelect: true,
          isOther: false,
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
        },
      ],
    },
  });
  await flush();
  const select = document.querySelector(".modal select") as HTMLSelectElement;
  assert.equal(select.multiple, true);
  select.options[0].selected = true;
  select.options[1].selected = true;
  click("Submit answers");
  assert.deepEqual(h.client.responses.at(-1), {
    id: 22,
    result: { answers: { q: { answers: ["A", "B"] } } },
  });
});

function noteSelectionFixture(h: any, rendered = false) {
  const root = document.body.appendChild(document.createElement("section"));
  root.innerHTML =
    '<div class="markdown-source-view"><div class="cm-content" tabindex="0"><p>ASTER-592 belongs to Mira.</p><div class="cm-html-embed"><blockquote>VIOLET-627 belongs to Jun.</blockquote></div></div></div>';
  const note = new host.MarkdownView();
  note.contentEl = root;
  note.file = new host.TFile("Selection verification.md");
  note.editor = {
    getSelection: () => "",
    getValue: () => "NEVER ATTACH THE WHOLE NOTE",
    getCursor: () => ({ line: 0, ch: 0 }),
  };
  note.getMode = () => "source";
  h.app.workspace.getLeavesOfType = (type: string) =>
    type === "markdown" ? [{ view: note }] : [];
  h.app.workspace.getActiveViewOfType = (type: any) =>
    type === host.MarkdownView ? note : null;
  h.app.workspace.getActiveFile = () => note.file;
  h.app.workspace.activeEditor = note;
  const node = root.querySelector(rendered ? "blockquote" : "p")!.firstChild!;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, rendered ? 10 : 9);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return { root, note, node };
}
test("rendered selection offers a direct action and inspectable exact preview; outgoing payload contains only selected passage", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  noteSelectionFixture(h, true);
  const direct = document.querySelector(
    ".codex-selection-action",
  ) as HTMLButtonElement;
  assert.equal(direct.hidden, false);
  direct.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  (document.querySelector("textarea") as HTMLTextAreaElement).focus();
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  direct.click();
  const preview = document.querySelector(".codex-excerpt-preview")!;
  assert.match(preview.textContent!, /VIOLET-627/);
  assert.equal(preview.querySelector("pre")!.textContent, "VIOLET-627");
  assert.match(
    document.querySelector(".codex-selection-attachment")!.textContent!,
    /Selection verification.md/,
  );
  (document.querySelector("textarea") as HTMLTextAreaElement).value =
    "Identify this code";
  click("Send");
  await flush();
  const input = h.client.calls.find((c) => c.method === "turn/start")!.params
    .input[0].text;
  assert.match(input, /VIOLET-627/);
  assert.doesNotMatch(input, /ASTER-592|Mira|Jun|NEVER ATTACH/);
});
test("+ menu retains only its current pointerdown selection despite UI focus collapse", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  noteSelectionFixture(h);
  const plus = document.querySelector(
    'button[aria-label="Attach context"]',
  ) as HTMLButtonElement;
  plus.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  (document.querySelector("textarea") as HTMLTextAreaElement).focus();
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  plus.click();
  click("Attach selection", document.querySelector(".test-menu")!);
  assert.equal(
    document.querySelector(".codex-excerpt-preview pre")!.textContent,
    "ASTER-592",
  );
});
test("palette captures source label before asynchronous chat opening and remains available for note DOM selection while chat is focused", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  const { note } = noteSelectionFixture(h);
  (document.querySelector("textarea") as HTMLTextAreaElement).focus();
  const command = h.plugin.commands.find((c: any) => c.id === "send-selection");
  assert.equal(command.checkCallback(true), true);
  h.plugin.open = async () => {
    h.app.workspace.getActiveFile = () => new host.TFile("Unrelated.md");
    return h.view;
  };
  command.checkCallback(false);
  await flush();
  assert.match(
    document.querySelector(".codex-selection-attachment")!.textContent!,
    /Selection verification.md/,
  );
  assert.doesNotMatch(
    document.querySelector(".codex-selection-attachment")!.textContent!,
    /Unrelated/,
  );
  assert.equal(
    document.querySelector(".codex-excerpt-preview pre")!.textContent,
    "ASTER-592",
  );
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  h.app.workspace.getActiveViewOfType = () => null;
  assert.equal(command.checkCallback(true), false);
  assert.equal(
    (document.querySelector(".codex-selection-action") as HTMLButtonElement)
      .hidden,
    true,
  );
  note.file = new host.TFile("Other.md");
});
test("editor context menu preserves explicit source selection and original label through async chat opening", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  const { note, root } = noteSelectionFixture(h);
  document.getSelection()!.removeAllRanges();
  note.editor = {
    getSelection: () => "Exact editor excerpt",
    getCursor: (side: string) =>
      side === "from" ? { line: 3, ch: 0 } : { line: 3, ch: 20 },
    getRange: () => "Exact editor excerpt",
  };
  const handler = h.app.workspaceEvents.find(
    (r: any) => r.name === "editor-menu",
  ).callback;
  const menu = new host.Menu();
  handler(menu, note.editor, note);
  h.plugin.open = async () => {
    h.app.workspace.getActiveFile = () => new host.TFile("Wrong.md");
    return h.view;
  };
  menu.showAtMouseEvent();
  click("Attach selection to chat", document.querySelector(".test-menu")!);
  await flush();
  assert.equal(
    document.querySelector(".codex-excerpt-preview pre")!.textContent,
    "Exact editor excerpt",
  );
  assert.match(
    document.querySelector(".codex-selection-attachment")!.textContent!,
    /Selection verification.md · L4/,
  );
  root
    .querySelector(".cm-content")!
    .dispatchEvent(new Event("pointerdown", { bubbles: true }));
});

test("model picker uses actual model rows and effort radios, preserves selection, handles keyboard navigation and unsupported effort fallback", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  h.view.models = [
    {
      model: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      description: "Actual provider description",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
      defaultReasoningEffort: "high",
    },
    {
      model: "small-model",
      displayName: "Smaller model",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
      ],
      defaultReasoningEffort: "medium",
    },
    {
      model: "seven-efforts",
      displayName:
        "Long model name that should remain fully accessible while its visible text can ellipsize",
      supportedReasoningEfforts: [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "ultra",
      ].map((reasoningEffort) => ({ reasoningEffort })),
      defaultReasoningEffort: "high",
    },
  ];
  h.view.buildOptions();
  const trigger = document.querySelector(
    ".codex-model-trigger",
  ) as HTMLButtonElement;
  assert.ok(trigger.title);
  trigger.click();
  const popup = document.querySelector(".codex-model-picker")!;
  assert.equal(popup.querySelectorAll("select").length, 0);
  assert.equal(popup.querySelector(".codex-picker-title"), null);
  assert.equal(trigger.hasAttribute("title"), false);
  const rows = Array.from(
    popup.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  );
  assert.equal(rows.length, 3);
  assert.equal(document.activeElement, rows[0]);
  assert.equal(
    rows[0].getAttribute("aria-description"),
    "Actual provider description",
  );
  rows[0].dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  assert.equal(document.activeElement, rows[1]);
  assert.equal(h.plugin.settings.model, "gpt-6.1-sol");
  rows[1].dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await flush();
  assert.equal(h.plugin.settings.model, "small-model");
  assert.equal(h.plugin.settings.effort, "medium");
  assert.equal(rows[1].getAttribute("aria-selected"), "true");
  assert.equal(rows[0].getAttribute("aria-selected"), "false");
  assert.equal(document.querySelector(".codex-model-picker"), popup);
  let checked = popup.querySelector<HTMLButtonElement>(
    '[role="radio"][aria-checked="true"]',
  )!;
  assert.equal(checked.dataset.effort, "medium");
  checked.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
  );
  assert.equal(h.plugin.settings.effort, "low");
  assert.equal(document.activeElement?.getAttribute("aria-checked"), "true");
  rows[2].click();
  await flush();
  assert.equal(h.plugin.settings.model, "seven-efforts");
  assert.equal(popup.querySelectorAll('[role="radio"]').length, 7);
  const high = popup.querySelector<HTMLButtonElement>(
    '[role="radio"][data-effort="high"]',
  )!;
  high.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await flush();
  assert.equal(h.app.savedSettings.effort, "high");
  assert.match(trigger.textContent!, /High/);
  assert.equal(trigger.hasAttribute("title"), false);
  high.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(document.activeElement, trigger);
  assert.ok(trigger.title);
});
test("unlisted saved model stays checked without invented effort options until explicit selection", async (t) => {
  const h = await harness({ model: "custom-cli-model", effort: "xhigh" });
  t.after(() => h.view.onClose());
  (document.querySelector(".codex-model-trigger") as HTMLButtonElement).click();
  const selected = document.querySelector<HTMLButtonElement>(
    '[role="option"][aria-selected="true"]',
  )!;
  assert.equal(selected.dataset.model, "custom-cli-model");
  assert.equal(document.activeElement, selected);
  assert.equal(h.plugin.settings.model, "custom-cli-model");
  assert.equal(h.plugin.settings.effort, "xhigh");
  assert.equal(
    document.querySelectorAll('.codex-model-picker [role="radio"]').length,
    0,
  );
  (
    document.querySelector(
      '[role="option"][data-model="gpt-6.1-sol"]',
    ) as HTMLButtonElement
  ).click();
  await flush();
  assert.equal(h.plugin.settings.model, "gpt-6.1-sol");
  assert.equal(h.plugin.settings.effort, "high");
});
test("provider tabs use manual keyboard activation, lock during switch, reopen with refreshed models and preserve provider preferences", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  const claude = new FakeClient();
  claude.handler = (method) =>
    method === "model/list"
      ? {
          data: [
            {
              model: "default",
              displayName: "Claude current default",
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "high",
            },
          ],
        }
      : undefined;
  h.plugin.createClient = () =>
    h.plugin.settings.provider === "claude" ? claude : h.client;
  (document.querySelector(".codex-model-trigger") as HTMLButtonElement).click();
  const codex = document.querySelector<HTMLButtonElement>(
    '[role="tab"][aria-selected="true"]',
  )!;
  codex.focus();
  codex.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  const next = document.activeElement as HTMLButtonElement;
  assert.equal(next.textContent, "Claude");
  assert.equal(h.plugin.settings.provider, "codex");
  next.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.equal(
    (document.querySelector(".codex-model-trigger") as HTMLButtonElement)
      .disabled,
    true,
  );
  await flush();
  assert.equal(h.plugin.settings.provider, "claude");
  assert.equal(
    document.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
    "Claude",
  );
  assert.equal(document.activeElement?.getAttribute("data-model"), "default");
  assert.equal(h.plugin.settings.model, "default");
  assert.equal(
    document.querySelectorAll(".codex-model-picker select").length,
    0,
  );
  assert.equal(h.plugin.settings.providerStates.codex.model, "gpt-6.1-sol");
});
test("slow provider switch never reopens picker over an intervening action, and detached model rows cannot change busy settings", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  const claude = new FakeClient();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  claude.connect = async () => {
    await gate;
  };
  h.plugin.createClient = () => claude;
  (document.querySelector(".codex-model-trigger") as HTMLButtonElement).click();
  const stale = document.querySelector<HTMLButtonElement>('[role="option"]')!;
  document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click();
  await new Promise((resolve) => setImmediate(resolve));
  stale.click();
  assert.equal(h.plugin.settings.model, "");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  release();
  await flush();
  assert.equal(h.plugin.settings.provider, "claude");
  assert.equal(document.querySelector(".codex-model-picker"), null);
});
test("failed provider connection does not reopen a model picker and fallback uses only actually supported effort", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  h.view.models = [
    {
      model: "restricted",
      displayName: "Restricted",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      defaultReasoningEffort: "unsupported",
    },
  ];
  h.view.buildOptions();
  (document.querySelector(".codex-model-trigger") as HTMLButtonElement).click();
  (
    document.querySelector(
      '[role="option"][data-model="restricted"]',
    ) as HTMLButtonElement
  ).click();
  assert.equal(h.plugin.settings.effort, "low");
  const claude = new FakeClient();
  claude.connect = async () => {
    claude.ready = false;
    throw new Error("CLI unavailable");
  };
  h.plugin.createClient = () => claude;
  document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click();
  await flush();
  assert.equal(document.querySelector(".codex-model-picker"), null);
  assert.match(
    document.querySelector(".codex-status")!.textContent!,
    /CLI unavailable/,
  );
});

test("model changes remeasure picker height and preserve the anchor when effort controls appear or disappear", async (t) => {
  const h = await harness();
  t.after(() => h.view.onClose());
  h.view.models = [
    {
      model: "gpt-6.1-sol",
      displayName: "Many efforts",
      supportedReasoningEfforts: [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "ultra",
      ].map((reasoningEffort) => ({ reasoningEffort })),
      defaultReasoningEffort: "high",
    },
    {
      model: "without-effort",
      displayName: "No reported effort",
      supportedReasoningEfforts: [],
    },
  ];
  h.view.buildOptions();
  const trigger = document.querySelector<HTMLButtonElement>(
    ".codex-model-trigger",
  )!;
  trigger.getBoundingClientRect = () => ({
    top: 600,
    bottom: 626,
    left: 20,
    right: 200,
    width: 180,
    height: 26,
    x: 20,
    y: 600,
    toJSON() {},
  });
  trigger.click();
  const popup = document.querySelector<HTMLElement>(".codex-model-picker")!;
  Object.defineProperty(popup, "scrollHeight", {
    configurable: true,
    get: () => (popup.querySelectorAll('[role="radio"]').length ? 300 : 180),
  });
  const many = popup.querySelector<HTMLButtonElement>(
    '[data-model="gpt-6.1-sol"]',
  )!;
  const none = popup.querySelector<HTMLButtonElement>(
    '[data-model="without-effort"]',
  )!;
  many.click();
  assert.equal(popup.style.top, "294px");
  assert.equal(document.activeElement, many);
  none.click();
  assert.equal(popup.style.top, "414px");
  assert.equal(document.activeElement, none);
  many.click();
  assert.equal(popup.style.top, "294px");
  assert.equal(document.querySelector(".codex-model-picker"), popup);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
});
