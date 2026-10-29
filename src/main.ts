import {
  App,
  Component,
  FileSystemAdapter,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import { basename, relative, resolve, isAbsolute, join } from "node:path";
import {
  CodexClient,
  findExecutable,
  itemText,
  threadPolicy,
  turnPolicy,
  type AccessMode,
  type Json,
} from "./protocol";
import {
  TurnState,
  buildInput,
  splitUserContext,
  type Attachment,
} from "./session";
import { enumOptions, validateFormValue } from "./forms";
import { ClaudeClient, type ClaudeRuntime } from "./claude";
type Provider = "codex" | "claude";
type ProviderPreferences = Pick<
  Settings,
  "model" | "effort" | "access" | "plan" | "lastThreadId"
>;
import { ComposerPopover } from "./popover";
import {
  captureNoteSelection,
  captureEditorSelection,
  selectionGesture,
  type NoteSelection,
  type SelectionView,
} from "./selection";
const VIEW = "obsidian-codex-chat";
interface Settings {
  provider: Provider;
  claudeExecutable: string;
  providerStates: Partial<Record<Provider, ProviderPreferences>>;
  claudeArchived: string[];
  executable: string;
  cwd: string;
  model: string;
  effort: string;
  access: AccessMode;
  plan: boolean;
  lastThreadId: string;
  exportFolder: string;
  maxContextChars: number;
}
const DEFAULTS: Settings = {
  provider: "codex",
  claudeExecutable: "",
  providerStates: {},
  claudeArchived: [],
  executable: "",
  cwd: "",
  model: "",
  effort: "high",
  access: "read-only",
  plan: false,
  lastThreadId: "",
  exportFolder: "Codex conversations",
  maxContextChars: 60000,
};

function button(
  parent: HTMLElement,
  label: string,
  action: () => void,
  title?: string,
) {
  const b = parent.createEl("button", {
    text: label,
    attr: { type: "button", ...(title ? { title } : {}) },
  });
  b.addEventListener("click", action);
  return b;
}
function detail(parent: HTMLElement, title: string, text: string) {
  const d = parent.createEl("details");
  d.createEl("summary", { text: title });
  d.createEl("pre", { text });
  return d;
}
function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
class InputModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private value: string,
    private accept: (value: string) => void,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: this.title });
    const input = this.contentEl.createEl("input", {
      type: "text",
      value: this.value,
      cls: "codex-wide",
    });
    const submit = () => {
      if (input.value.trim()) {
        this.accept(input.value.trim());
        this.close();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    button(this.contentEl, "Save", submit);
    setTimeout(() => input.focus(), 0);
  }
}
class InfoModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private text: string,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("pre", { text: this.text, cls: "codex-inspect" });
  }
}
class FilePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private accept: (f: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Attach a vault text file…");
  }
  getItems() {
    return this.app.vault
      .getFiles()
      .filter((f) =>
        [
          "md",
          "txt",
          "json",
          "yaml",
          "yml",
          "csv",
          "ts",
          "js",
          "css",
          "html",
          "py",
          "rs",
          "toml",
          "png",
          "jpg",
          "jpeg",
          "webp",
          "gif",
        ].includes(f.extension),
      );
  }
  getItemText(f: TFile) {
    return f.path;
  }
  onChooseItem(f: TFile) {
    this.accept(f);
  }
}
/** Each server request has one response. Dismissing an approval denies it. */
class RequestModal extends Modal {
  private answered = false;
  private submitters: Array<() => void> = [];
  constructor(
    app: App,
    public message: Json,
    private reply: (result: Json) => void,
    private finished: () => void,
  ) {
    super(app);
  }
  private respond(result: Json) {
    if (this.answered) return;
    this.answered = true;
    this.reply(result);
    this.close();
  }
  cancelWithoutResponse() {
    this.answered = true;
    this.close();
  }
  private deny(): Json {
    const m = this.message.method;
    if (m === "item/tool/requestUserInput") return { answers: {} };
    if (m === "item/permissions/requestApproval")
      return { permissions: {}, scope: "turn" };
    if (m === "mcpServer/elicitation/request")
      return { action: "cancel", content: null, _meta: null };
    return { decision: "decline" };
  }
  onOpen() {
    const { method, params: p } = this.message;
    this.titleEl.setText(
      method === "item/tool/requestUserInput"
        ? `${p.providerLabel ?? "Codex"} needs your input`
        : `${p.providerLabel ?? "Codex"} requests approval`,
    );
    this.contentEl.createEl("p", {
      text:
        p.reason ??
        p.message ??
        "Review the requested action before allowing it.",
    });
    if (method === "item/tool/requestUserInput") {
      const answers: Json = {};
      for (const q of p.questions ?? []) {
        const group = this.contentEl.createDiv({ cls: "codex-question" });
        group.createEl("h3", { text: q.header });
        group.createEl("p", { text: q.question });
        let choice: HTMLSelectElement | undefined;
        if (q.options?.length) {
          choice = group.createEl("select", { cls: "codex-wide" });
          if (q.multiSelect) {
            choice.multiple = true;
            choice.size = Math.min(5, q.options.length);
            group.createEl("small", {
              text: "Hold Cmd/Ctrl to select multiple answers.",
            });
          } else
            choice.createEl("option", { text: "Choose an answer", value: "" });
          for (const o of q.options)
            choice.createEl("option", {
              text: `${o.label} — ${o.description}`,
              value: o.label,
            });
        }
        const input =
          !choice || q.isOther
            ? group.createEl("input", {
                type: q.isSecret ? "password" : "text",
                cls: "codex-wide",
                placeholder: choice ? "Or type your answer" : "Your answer",
              })
            : undefined;
        this.submitters.push(() => {
          const typed = input?.value.trim();
          const values = typed
            ? [typed]
            : q.multiSelect
              ? Array.from(choice?.selectedOptions ?? [])
                  .map((o) => o.value)
                  .filter(Boolean)
              : choice?.value
                ? [choice.value]
                : [];
          if (!values.length)
            throw new Error(`Answer “${q.header}” before submitting.`);
          answers[q.id] = { answers: values };
        });
      }
      button(this.contentEl, "Submit answers", () => {
        try {
          this.submitters.forEach((f) => f());
          this.respond({ answers });
        } catch (e) {
          new Notice(errorMessage(e));
        }
      });
    } else if (method === "mcpServer/elicitation/request") {
      this.contentEl.createEl("p", {
        text: `MCP server: ${p.serverName ?? "unknown"}`,
      });
      if (p.mode === "url") {
        this.contentEl.createEl("p", { text: p.url });
        button(this.contentEl, "Open verification link", () => {
          if (/^https?:\/\//i.test(p.url))
            window.open(p.url, "_blank", "noopener");
        });
        button(this.contentEl, "I completed verification", () =>
          this.respond({ action: "accept", content: null, _meta: null }),
        );
      } else if (p.mode === "form") {
        const values: Json = {};
        const fields: Array<() => void> = [];
        for (const [key, schema] of Object.entries(
          p.requestedSchema?.properties ?? {},
        ) as [string, Json][]) {
          const row = this.contentEl.createDiv({ cls: "codex-question" });
          row.createEl("label", { text: schema.title ?? key });
          if (schema.description)
            row.createEl("p", { text: schema.description });
          let input: HTMLInputElement | HTMLSelectElement;
          const choices = enumOptions(schema);
          if (choices) {
            const select = row.createEl("select", { cls: "codex-wide" });
            input = select;
            if (schema.type === "array") {
              select.multiple = true;
              select.size = Math.min(8, Math.max(3, choices.length));
              row.createEl("small", {
                text: "Hold Cmd/Ctrl to select multiple values.",
              });
            } else
              select.createEl("option", {
                text: "Choose an option",
                value: "",
              });
            for (const option of choices) {
              const el = select.createEl("option", {
                text: option.label,
                value: option.value,
              });
              if (
                schema.type === "array" &&
                schema.default?.includes(option.value)
              )
                el.selected = true;
            }
            if (schema.type !== "array" && schema.default !== undefined)
              select.value = String(schema.default);
          } else {
            const field = row.createEl("input", {
              type:
                schema.type === "boolean"
                  ? "checkbox"
                  : schema.type === "number" || schema.type === "integer"
                    ? "number"
                    : schema.format === "email"
                      ? "email"
                      : schema.format === "uri"
                        ? "url"
                        : "text",
              cls: "codex-wide",
            });
            input = field;
            if (schema.type === "boolean")
              field.checked = schema.default ?? false;
            else if (schema.default !== undefined)
              field.value = String(schema.default);
            if (schema.type === "number") field.step = "any";
          }
          fields.push(() => {
            if (!(input as HTMLInputElement).checkValidity())
              throw new Error(`${key}: enter a valid value`);
            const raw =
              schema.type === "boolean"
                ? (input as HTMLInputElement).checked
                : schema.type === "array"
                  ? Array.from(
                      (input as HTMLSelectElement).selectedOptions,
                    ).map((o) => o.value)
                  : input.value;
            const value = validateFormValue(
              key,
              schema,
              raw,
              p.requestedSchema.required?.includes(key) ?? false,
            );
            if (value !== undefined) values[key] = value;
            else delete values[key];
          });
        }
        button(this.contentEl, "Submit form", () => {
          try {
            fields.forEach((f) => f());
            this.respond({ action: "accept", content: values, _meta: null });
          } catch (e) {
            new Notice(errorMessage(e));
          }
        });
      } else
        this.contentEl.createEl("p", {
          text: "This verification format is not supported. Cancel and complete it in Codex CLI.",
        });
      detail(this.contentEl, "Request details", JSON.stringify(p, null, 2));
    } else {
      if (p.command)
        this.contentEl.createEl("pre", {
          text: p.command,
          cls: "codex-inspect",
        });
      if (p.cwd)
        this.contentEl.createEl("p", { text: `Working directory: ${p.cwd}` });
      if (p.input?.file_path)
        this.contentEl.createEl("p", { text: `File: ${p.input.file_path}` });
      detail(this.contentEl, "Full request", JSON.stringify(p, null, 2));
      button(
        this.contentEl,
        method === "item/permissions/requestApproval"
          ? "Grant for this turn"
          : "Allow once",
        () => {
          if (method === "item/permissions/requestApproval") {
            const permissions: Json = {};
            for (const key of ["network", "fileSystem"])
              if (p.permissions?.[key] != null)
                permissions[key] = p.permissions[key];
            this.respond({ permissions, scope: "turn" });
          } else this.respond({ decision: "accept" });
        },
      );
    }
    button(this.contentEl, "Cancel / deny", () => this.respond(this.deny()));
  }
  onClose() {
    if (!this.answered) {
      this.answered = true;
      this.reply(this.deny());
    }
    this.finished();
  }
}
class HistoryModal extends Modal {
  private list!: HTMLElement;
  private search!: HTMLInputElement;
  private archived = false;
  private cursor: string | null = null;
  private serial = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    app: App,
    private view: CodexView,
  ) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText(`${this.view.plugin.providerLabel} conversations`);
    this.search = this.contentEl.createEl("input", {
      type: "search",
      placeholder: "Search conversation titles",
      cls: "codex-wide",
    });
    this.search.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.load(false), 250);
    });
    new Setting(this.contentEl)
      .setName("Archived conversations")
      .addToggle((t) =>
        t.onChange((v) => {
          this.archived = v;
          void this.load(false);
        }),
      );
    this.list = this.contentEl.createDiv();
    void this.load(false);
  }
  async load(more: boolean) {
    const serial = ++this.serial;
    if (!more) {
      this.cursor = null;
      this.list.empty();
    }
    const marker = this.list.createEl("p", { text: "Loading…" });
    try {
      const result = await this.view.plugin.client.request("thread/list", {
        limit: 40,
        cursor: more ? this.cursor : null,
        sortKey: "updated_at",
        cwd: this.view.plugin.cwd(),
        archived: this.archived,
        searchTerm: this.search.value || null,
      });
      if (this.closed || serial !== this.serial) return;
      marker.remove();
      this.list.querySelector(".codex-more")?.remove();
      this.cursor = result.nextCursor;
      for (const t of result.data ?? []) {
        const row = this.list.createDiv({ cls: "codex-history-row" });
        const name = t.name || t.preview || "Untitled conversation";
        button(
          row,
          name.slice(0, 130),
          () => {
            this.close();
            void this.view.guard(async () => {
              if (this.archived)
                await this.view.plugin.client.request("thread/unarchive", {
                  threadId: t.id,
                });
              await this.view.resume(t.id);
            });
          },
          name,
        );
        row.createEl("small", {
          text: new Date(t.updatedAt * 1000).toLocaleString(),
        });
      }
      if (!result.data?.length && !more)
        this.list.createEl("p", {
          text: "No conversations for this working folder.",
        });
      if (this.cursor)
        button(this.list, "Load more", () => void this.load(true)).addClass(
          "codex-more",
        );
    } catch (e) {
      marker.setText(errorMessage(e));
    }
  }
  onClose() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
export default class CodexPlugin extends Plugin {
  declare settings: Settings;
  client!: CodexClient | ClaudeClient;
  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.client = this.createClient();
    this.registerView(VIEW, (leaf) => new CodexView(leaf, this));
    this.addSettingTab(new CodexSettingsTab(this.app, this));
    this.addRibbonIcon("bot", "Open Codex", () => void this.open());
    this.addCommand({
      id: "open",
      name: "Open chat",
      callback: () => void this.open(),
    });
    for (const [id, name, action] of [
      ["history", "Show conversation history", "history"],
      ["new-chat", "New chat", "new"],
      ["export", "Export conversation to note", "export"],
      ["copy-response", "Copy latest response", "copy"],
      ["review", "Review changes", "review"],
      ["rename", "Rename conversation", "rename"],
    ])
      this.addCommand({
        id,
        name,
        callback: () =>
          void this.open().then((view) => view?.runAction(action)),
      });
    for (const provider of ["codex", "claude"] as const)
      this.addCommand({
        id: `use-${provider}`,
        name: provider === "claude" ? "Use Claude Code CLI" : "Use Codex CLI",
        callback: () =>
          void this.open().then((view) => view?.changeProvider(provider)),
      });
    this.addCommand({
      id: "send-selection",
      name: "Attach selection to chat",
      checkCallback: (checking) => {
        const snapshot = this.noteSelection();
        if (checking) return !!snapshot;
        if (snapshot) void this.attachCapturedSelection(snapshot);
        return !!snapshot;
      },
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const dom = this.noteSelection();
        const snapshot =
          dom?.sourcePath === info.file?.path
            ? dom
            : captureEditorSelection(editor, info);
        if (snapshot)
          menu.addItem((item) =>
            item
              .setTitle("Attach selection to chat")
              .setIcon("text-select")
              .onClick(() => void this.attachCapturedSelection(snapshot)),
          );
      }),
    );
    this.addCommand({
      id: "attach-note",
      name: "Attach active note to chat",
      callback: () => void this.open().then((v) => v?.attachActive()),
    });
  }
  noteSelection(
    document: Document = globalThis.document,
  ): NoteSelection | null {
    const views = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof MarkdownView) as MarkdownView[];
    const snapshot = captureNoteSelection(
      views as unknown as SelectionView[],
      document,
    );
    if (snapshot) return snapshot;
    const dom = document.getSelection();
    if (dom && !dom.isCollapsed) return null;
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (
      active?.getMode() === "source" &&
      document.activeElement?.closest(".prompt")
    )
      return captureEditorSelection(active.editor, active);
    return null;
  }
  async attachCapturedSelection(snapshot: NoteSelection) {
    const gesture = selectionGesture(snapshot);
    try {
      const view = await this.open();
      const current = gesture.take();
      if (current)
        view?.attach({
          label: current.label,
          text: current.text,
          selection: true,
        });
      else new Notice("The note selection changed. Select the passage again.");
    } finally {
      gesture.dispose();
    }
  }
  get providerLabel() {
    return this.settings.provider === "claude" ? "Claude Code" : "Codex";
  }
  createClient(): CodexClient | ClaudeClient {
    if (this.settings.provider === "claude")
      return new ClaudeClient(
        () => findExecutable(this.settings.claudeExecutable, "claude"),
        () => this.cwd(),
        () => {
          const adapter = this.app.vault.adapter;
          if (!(adapter instanceof FileSystemAdapter))
            throw new Error("Claude Code requires a local vault");
          const dir = this.manifest?.dir ?? ".obsidian/plugins/obsidian-codex";
          return require(
            join(adapter.getBasePath(), dir, "claude-sdk.cjs"),
          ) as ClaudeRuntime;
        },
        {
          get: () => this.settings.claudeArchived,
          set: async (ids) => {
            this.settings.claudeArchived = ids;
            await this.save();
          },
        },
      );
    return new CodexClient(
      () => findExecutable(this.settings.executable),
      () => this.cwd(),
    );
  }
  async useProvider(provider: Provider) {
    if (provider === this.settings.provider) return;
    const s = this.settings;
    s.providerStates = {
      ...s.providerStates,
      [s.provider]: {
        model: s.model,
        effort: s.effort,
        access: s.access,
        plan: s.plan,
        lastThreadId: s.lastThreadId,
      },
    };
    this.client.disconnect();
    s.provider = provider;
    Object.assign(
      s,
      s.providerStates[provider] ?? {
        model: "",
        effort: "high",
        access: "read-only",
        plan: false,
        lastThreadId: "",
      },
    );
    this.client = this.createClient();
    await this.save();
  }
  onunload() {
    this.client.disconnect();
  }
  cwd() {
    if (this.settings.cwd.trim()) return this.settings.cwd.trim();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter))
      throw new Error("This plugin requires a local desktop vault.");
    return adapter.getBasePath();
  }
  async save() {
    await this.saveData(this.settings);
  }
  async open() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (!right) return;
      leaf = right;
      await leaf.setViewState({ type: VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as CodexView;
  }
}
class CodexSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: CodexPlugin,
  ) {
    super(app, plugin);
  }
  display() {
    const { containerEl: c } = this;
    c.empty();
    c.createEl("h2", { text: "Codex & Claude Code" });
    c.createEl("p", {
      text: "Uses the selected installed CLI and its existing login. No credentials are stored by this plugin. Restart the connection after changing the executable or working folder.",
    });
    new Setting(c)
      .setName("Provider")
      .setDesc(
        "Each provider keeps its own model, permissions, and last conversation.",
      )
      .addDropdown((d) =>
        d
          .addOption("codex", "Codex CLI")
          .addOption("claude", "Claude Code CLI")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            await this.plugin
              .open()
              .then((view) => view?.changeProvider(value as Provider));
            this.display();
          }),
      );
    new Setting(c)
      .setName("Claude Code executable")
      .setDesc(
        "Absolute path to your installed Claude CLI. Blank checks PATH, Homebrew and user-local locations. Existing Claude login is reused.",
      )
      .addText((t) =>
        t
          .setPlaceholder("/opt/homebrew/bin/claude")
          .setValue(this.plugin.settings.claudeExecutable)
          .onChange(async (value) => {
            this.plugin.settings.claudeExecutable = value.trim();
            await this.plugin.save();
          }),
      );
    new Setting(c)
      .setName("Codex executable")
      .setDesc(
        "Absolute path. Blank discovers common Homebrew, npm, user-local and Codex.app locations. Run “which codex” in a terminal to find it.",
      )
      .addText((t) =>
        t
          .setPlaceholder("/opt/homebrew/bin/codex")
          .setValue(this.plugin.settings.executable)
          .onChange(async (v) => {
            this.plugin.settings.executable = v.trim();
            await this.plugin.save();
          }),
      );
    new Setting(c)
      .setName("Working folder")
      .setDesc(
        "Blank uses the vault folder. This controls tools and conversation history. New turns use this folder.",
      )
      .addText((t) =>
        t
          .setPlaceholder("Vault folder")
          .setValue(this.plugin.settings.cwd)
          .onChange(async (v) => {
            this.plugin.settings.cwd = v.trim();
            await this.plugin.save();
          }),
      );
    new Setting(c)
      .setName("Export folder")
      .setDesc("Vault-relative folder for conversation notes.")
      .addText((t) =>
        t.setValue(this.plugin.settings.exportFolder).onChange(async (v) => {
          this.plugin.settings.exportFolder = v;
          await this.plugin.save();
        }),
      );
    new Setting(c)
      .setName("Attachment size limit")
      .setDesc(
        "Maximum total characters attached to one message. Files are attached explicitly; the vault is not uploaded automatically.",
      )
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.maxContextChars))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 1000 && n <= 500000) {
              this.plugin.settings.maxContextChars = Math.round(n);
              await this.plugin.save();
            }
          }),
      );
    new Setting(c).setName("Connection").addButton((b) =>
      b.setButtonText("Reconnect").onClick(() => {
        this.plugin.client.disconnect();
        void this.plugin.open().then((v) => v?.connect());
      }),
    );
    c.createEl("p", {
      text: "Desktop only. Codex agent mode uses its workspace sandbox. Claude manual mode uses Claude tool permissions, not an OS sandbox; its read-only mode restricts tools and blocks writes/shell/unknown tools. Loaded CLI hooks and settings remain part of your trusted CLI configuration. Cloud tasks, VS Code editor actions, and rich MCP app widgets are unavailable. CLI configuration, skills, and MCP servers are shared with your other Codex clients.",
    });
  }
}
class CodexView extends ItemView {
  private status!: HTMLElement;
  private title!: HTMLElement;
  private transcript!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private options!: HTMLElement;
  private modelButton!: HTMLButtonElement;
  private modeButton!: HTMLButtonElement;
  private picker?: ComposerPopover;
  private threadId = "";
  private turns = new TurnState();
  private get turnId() {
    return this.turns.current;
  }
  private set turnId(value: string) {
    this.turns.current = value;
  }
  private starting = false;
  private operation = false;
  private items = new Map<string, Json>();
  private rows = new Map<
    string,
    { body: HTMLElement; version: number; component: Component }
  >();
  private models: Json[] = [];
  private attachments: Attachment[] = [];
  private selectionButton!: HTMLButtonElement;
  private selectionWatch?: () => void;
  private selectionIntent?: ReturnType<typeof selectionGesture>;
  private menuSelectionCleanup?: () => void;
  private pending: Json[] = [];
  private requestModal?: RequestModal;
  private closed = false;
  private connectedOnce = false;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private dirty = new Set<string>();
  private historyCursor: string | null = null;
  private paginated = false;
  private notification = (method: string, p: Json) => this.onEvent(method, p);
  private serverRequest = (m: Json) => this.onRequest(m);
  private disconnect = (e: Error) => {
    this.status?.setText(e.message);
    this.starting = false;
    this.turns.reset();
    this.updateBusy();
    this.pending = [];
    this.requestModal?.close();
  };
  constructor(
    leaf: WorkspaceLeaf,
    public plugin: CodexPlugin,
  ) {
    super(leaf);
  }
  getViewType() {
    return VIEW;
  }
  getDisplayText() {
    return this.plugin.providerLabel;
  }
  getIcon() {
    return "bot";
  }
  async onOpen() {
    this.closed = false;
    const root = this.contentEl;
    root.empty();
    root.addClass("codex-view");
    const header = root.createDiv({ cls: "codex-header" });
    this.title = header.createEl("strong", { text: "New conversation" });
    const actions = header.createDiv({ cls: "codex-actions" });
    button(actions, "New", () => void this.guard(() => this.newChat()));
    button(
      actions,
      "History",
      () =>
        void this.guard(async () => {
          await this.plugin.client.connect();
          new HistoryModal(this.app, this).open();
        }),
    );
    button(actions, "⋯", () => this.menu(), "Conversation actions");
    this.status = root.createDiv({
      cls: "codex-status",
      text: `Connecting to local ${this.plugin.providerLabel}…`,
      attr: { role: "status", "aria-live": "polite" },
    });
    this.transcript = root.createDiv({ cls: "codex-transcript" });
    this.emptyState();
    const composer = root.createDiv({ cls: "codex-composer" });
    this.attachmentsEl = composer.createDiv({ cls: "codex-attachments" });
    this.input = composer.createEl("textarea", {
      cls: "codex-input",
      placeholder: `Ask ${this.plugin.providerLabel}…`,
      attr: {
        "aria-label": `Message to ${this.plugin.providerLabel}`,
        rows: "3",
      },
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.send();
      }
    });
    this.options = composer.createDiv({ cls: "codex-options codex-controls" });
    this.buildOptions();
    const actionsRow = composer.createDiv({ cls: "codex-composer-actions" });
    const context = actionsRow.createDiv({ cls: "codex-actions" });
    const plus = button(
      context,
      "+",
      () => this.attachmentMenu(),
      "Attach note, selection, or file",
    );
    plus.setAttribute("aria-label", "Attach context");
    plus.addEventListener("pointerdown", () => this.captureSelectionIntent());
    this.selectionButton = button(
      context,
      "Attach selection",
      () => this.attachSelectionIntent(),
      "Attach selected note text",
    );
    this.selectionButton.addClass("codex-selection-action");
    this.selectionButton.hidden = true;
    this.selectionButton.addEventListener("pointerdown", () =>
      this.captureSelectionIntent(),
    );
    button(
      context,
      "/",
      () => this.commandMenu(),
      "Chat commands",
    ).setAttribute("aria-label", "Chat commands");
    const footer = actionsRow.createDiv({
      cls: "codex-actions codex-send-row",
    });
    this.stopButton = button(
      footer,
      "Stop",
      () =>
        void this.guard(async () => {
          if (this.turnId)
            await this.plugin.client.request("turn/interrupt", {
              threadId: this.threadId,
              turnId: this.turnId,
            });
        }),
    );
    this.sendButton = button(footer, "Send", () => void this.send());
    this.sendButton.addClass("mod-cta");
    this.sendButton.title = "Send (Cmd/Ctrl + Enter)";
    this.updateBusy();
    this.plugin.client.on("notification", this.notification);
    this.plugin.client.on("request", this.serverRequest);
    this.plugin.client.on("disconnected", this.disconnect);
    this.watchNoteSelection();
    await this.connect();
  }
  async onClose() {
    this.closed = true;
    this.selectionWatch?.();
    this.selectionIntent?.dispose();
    this.menuSelectionCleanup?.();
    clearTimeout(this.renderTimer);
    this.picker?.close(false);
    this.requestModal?.close();
    for (const p of this.pending) {
      try {
        this.plugin.client.rejectRequest(
          p.id,
          `${this.plugin.providerLabel} panel closed`,
        );
      } catch {}
    }
    this.pending = [];
    this.plugin.client.off("notification", this.notification);
    this.plugin.client.off("request", this.serverRequest);
    this.plugin.client.off("disconnected", this.disconnect);
    this.clearRows();
    this.plugin.client.disconnect();
  }
  async changeProvider(provider: Provider) {
    await this.guard(async () => {
      this.requireIdle();
      if (provider === this.plugin.settings.provider) return;
      this.operation = true;
      this.updateBusy();
      try {
        const old = this.plugin.client;
        old.off("notification", this.notification);
        old.off("request", this.serverRequest);
        old.off("disconnected", this.disconnect);
        await this.plugin.useProvider(provider);
        this.plugin.client.on("notification", this.notification);
        this.plugin.client.on("request", this.serverRequest);
        this.plugin.client.on("disconnected", this.disconnect);
        this.threadId = "";
        this.turns.reset();
        this.connectedOnce = false;
        this.models = [];
        this.attachments = [];
        this.renderAttachments();
        this.input.value = "";
        this.input.placeholder = `Ask ${this.plugin.providerLabel}…`;
        this.input.setAttribute(
          "aria-label",
          `Message to ${this.plugin.providerLabel}`,
        );
        this.title.setText("New conversation");
        this.clearRows();
        this.transcript.empty();
        this.emptyState();
        this.buildOptions();
        await this.connect(true);
      } finally {
        this.operation = false;
        this.updateBusy();
      }
    });
  }
  private emptyState() {
    this.transcript.createDiv({
      cls: "codex-empty",
      text: "Ask about a note, explore an idea, or work on files. Attach a note or selection below to include its current text. Read-only is the default.",
    });
  }
  async guard(work: () => Promise<any>) {
    try {
      await work();
    } catch (e) {
      const message = errorMessage(e);
      this.status?.setText(message);
      new Notice(message, 8000);
    }
  }
  async connect(withinOperation = false) {
    await this.guard(async () => {
      this.status.setText("Connecting…");
      await this.plugin.client.connect();
      if (this.closed) return;
      const results = await Promise.allSettled([
        this.plugin.client.request("model/list", {}),
        this.plugin.client.request("account/read", { refreshToken: false }),
      ]);
      if (results[0].status === "fulfilled") {
        this.models = results[0].value.data ?? [];
        if (!this.plugin.settings.model)
          this.plugin.settings.model =
            (this.models.find((m) => m.isDefault) ?? this.models[0])?.model ??
            "";
        this.buildOptions();
      }
      const account =
        results[1].status === "fulfilled" ? results[1].value.account : null;
      this.status.setText(
        account
          ? `Connected · ${basename(this.plugin.cwd())}`
          : "Connected · Sign in using “codex login” in a terminal if needed.",
      );
      this.status.title = this.plugin.cwd();
      const last =
        this.threadId ||
        (!this.connectedOnce ? this.plugin.settings.lastThreadId : "");
      this.connectedOnce = true;
      if (last) await this.resume(last, withinOperation);
    });
  }
  private buildOptions() {
    if (!this.options) return;
    this.picker?.close(false);
    this.options.empty();
    this.modelButton = button(
      this.options,
      "",
      () => this.openModelPicker(),
      "Choose provider, model, and reasoning effort",
    );
    this.modelButton.addClass("codex-control-trigger");
    this.modelButton.addClass("codex-model-trigger");
    this.modelButton.setAttribute("aria-haspopup", "dialog");
    this.modelButton.setAttribute("aria-expanded", "false");
    this.modeButton = button(
      this.options,
      "",
      () => this.openModePicker(),
      "Choose work mode and permissions",
    );
    this.modeButton.addClass("codex-control-trigger");
    this.modeButton.addClass("codex-mode-trigger");
    this.modeButton.setAttribute("aria-haspopup", "dialog");
    this.modeButton.setAttribute("aria-expanded", "false");
    this.refreshControlLabels();
    this.updateBusy();
  }
  private accessLabel() {
    const s = this.plugin.settings;
    return s.access === "read-only"
      ? "Read-only"
      : s.access === "agent"
        ? s.provider === "claude"
          ? "Manual approvals"
          : "Agent"
        : s.provider === "claude"
          ? "Bypass approvals"
          : "Full access";
  }
  private refreshControlLabels() {
    const s = this.plugin.settings;
    const model = this.models.find((m) => m.model === s.model);
    const name =
      s.provider === "claude" && s.model === "default"
        ? "Claude default"
        : (model?.displayName ?? s.model ?? "CLI default");
    const effort = s.effort
      ? s.effort[0].toUpperCase() + s.effort.slice(1)
      : "Default";
    this.modelButton?.setText((name || "CLI default") + " · " + effort);
    this.modelButton?.setAttribute(
      "aria-label",
      this.plugin.providerLabel +
        " model: " +
        (name || "CLI default") +
        ", reasoning: " +
        effort +
        ". Choose provider, model, or effort",
    );
    if (this.modelButton)
      this.modelButton.title =
        this.plugin.providerLabel +
        " · " +
        (name || "CLI default") +
        " · " +
        effort;
    this.modeButton?.setText(
      (s.plan ? "Plan" : "Work") + " · " + this.accessLabel(),
    );
    this.modeButton?.setAttribute(
      "aria-label",
      "Mode: " +
        (s.plan ? "Plan" : "Work") +
        ", permissions: " +
        this.accessLabel() +
        ". Change mode or permissions",
    );
    if (this.modeButton)
      this.modeButton.title =
        s.provider === "claude"
          ? "Claude Code · " +
            this.accessLabel() +
            " (tool permissions; not an OS sandbox)"
          : this.accessLabel();
  }
  private beginPicker(anchor: HTMLButtonElement, label: string) {
    if (this.turnId || this.starting || this.operation) return;
    if (this.picker) {
      const same = anchor.getAttribute("aria-expanded") === "true";
      this.picker.close();
      if (same) return;
    }
    const picker = new ComposerPopover(anchor, label, this.contentEl, () => {
      if (this.picker === picker) this.picker = undefined;
    });
    this.picker = picker;
    return picker;
  }
  private pickerSelect(parent: HTMLElement, label: string) {
    const field = parent.createEl("label", { cls: "codex-picker-field" });
    field.createEl("span", { text: label });
    return field.createEl("select", { attr: { "aria-label": label } });
  }
  private openModelPicker() {
    const picker = this.beginPicker(this.modelButton, "Model and reasoning");
    if (!picker) return;
    const s = this.plugin.settings;
    picker.content.createEl("div", {
      text: "Model & reasoning",
      cls: "codex-picker-title",
    });
    const provider = this.pickerSelect(picker.content, "Provider");
    provider.createEl("option", { text: "Codex CLI", value: "codex" });
    provider.createEl("option", { text: "Claude Code CLI", value: "claude" });
    provider.value = s.provider;
    provider.addEventListener("change", () => {
      const value = provider.value as Provider;
      picker.close(false);
      void this.changeProvider(value).then(() => this.modelButton.focus());
    });
    const model = this.pickerSelect(picker.content, "Model");
    if (!this.models.length)
      model.createEl("option", {
        text: s.model || "CLI default",
        value: s.model,
      });
    for (const m of this.models)
      model.createEl("option", {
        text: m.displayName ?? m.model,
        value: m.model,
      });
    model.value = s.model;
    const effort = this.pickerSelect(picker.content, "Reasoning effort");
    const fillEffort = () => {
      effort.empty();
      for (const e of this.models.find((m) => m.model === s.model)
        ?.supportedReasoningEfforts ?? [{ reasoningEffort: s.effort }])
        effort.createEl("option", {
          text: e.reasoningEffort
            ? e.reasoningEffort[0].toUpperCase() + e.reasoningEffort.slice(1)
            : "Default",
          value: e.reasoningEffort,
        });
      effort.value = s.effort;
    };
    fillEffort();
    model.addEventListener("change", () => {
      if (this.turnId || this.starting || this.operation) return;
      s.model = model.value;
      const selected = this.models.find((m) => m.model === s.model);
      if (
        !selected?.supportedReasoningEfforts?.some(
          (e: Json) => e.reasoningEffort === s.effort,
        )
      )
        s.effort = selected?.defaultReasoningEffort ?? "";
      fillEffort();
      this.refreshControlLabels();
      void this.plugin.save();
    });
    effort.addEventListener("change", () => {
      if (this.turnId || this.starting || this.operation) return;
      s.effort = effort.value;
      this.refreshControlLabels();
      void this.plugin.save();
    });
    picker.show();
  }
  private openModePicker() {
    const picker = this.beginPicker(this.modeButton, "Mode and permissions");
    if (!picker) return;
    const s = this.plugin.settings;
    picker.content.createEl("div", {
      text: "Mode & permissions",
      cls: "codex-picker-title",
    });
    const mode = this.pickerSelect(picker.content, "Collaboration mode");
    mode.createEl("option", { text: "Work", value: "work" });
    mode.createEl("option", { text: "Plan", value: "plan" });
    mode.value = s.plan ? "plan" : "work";
    mode.addEventListener("change", () => {
      if (this.turnId || this.starting || this.operation) return;
      s.plan = mode.value === "plan";
      this.refreshControlLabels();
      void this.plugin.save();
    });
    const access = this.pickerSelect(picker.content, "Permissions");
    for (const [value, text] of [
      [
        "read-only",
        s.provider === "claude" ? "Read-only · restricted tools" : "Read-only",
      ],
      [
        "agent",
        s.provider === "claude" ? "Manual approvals" : "Agent · folder edits",
      ],
      [
        "full-access",
        s.provider === "claude" ? "Bypass approvals" : "Full access",
      ],
    ])
      access.createEl("option", { text, value });
    access.value = s.access;
    access.addEventListener("change", () => {
      const value = access.value as AccessMode;
      if (this.turnId || this.starting || this.operation) return;
      if (value === "full-access") {
        access.value = s.access;
        picker.close(false);
        this.confirmFullAccess();
      } else {
        s.access = value;
        this.refreshControlLabels();
        void this.plugin.save();
      }
    });
    if (s.provider === "claude")
      picker.content.createEl("p", {
        text: "Claude tool permissions are not an OS sandbox.",
        cls: "codex-picker-hint",
      });
    picker.show();
  }
  private confirmFullAccess() {
    const provider = this.plugin.settings.provider;
    const modal = new Modal(this.app);
    modal.titleEl.setText(
      provider === "claude"
        ? "Bypass permission prompts?"
        : "Enable full access?",
    );
    modal.contentEl.createEl("p", {
      text:
        provider === "claude"
          ? "Claude Code can use tools without normal permission prompts. This is not an operating-system sandbox. Existing settings and hooks still apply. Only enable this for work you trust."
          : "Codex commands can access files outside this vault and use the network without approval. Only enable this for work you trust.",
    });
    button(
      modal.contentEl,
      "Enable full access",
      () =>
        void this.guard(async () => {
          this.requireIdle();
          if (this.plugin.settings.provider !== provider)
            throw new Error("The provider changed. Select permissions again.");
          this.plugin.settings.access = "full-access";
          await this.plugin.save();
          this.refreshControlLabels();
          modal.close();
          this.modeButton.focus();
        }),
    );
    button(modal.contentEl, "Keep current permissions", () => {
      modal.close();
      this.modeButton.focus();
    });
    modal.open();
  }
  private attachmentMenu() {
    this.menuSelectionCleanup?.();
    const gesture =
      this.selectionIntent ??
      selectionGesture(this.plugin.noteSelection(this.contentEl.ownerDocument));
    this.selectionIntent = undefined;
    this.menuSelectionCleanup = gesture.dispose;
    const menu = new Menu();
    menu.onHide(() => {
      gesture.dispose();
      if (this.menuSelectionCleanup === gesture.dispose)
        this.menuSelectionCleanup = undefined;
    });
    menu.addItem((i) =>
      i.setTitle("Attach active note").onClick(() => void this.attachActive()),
    );
    menu.addItem((i) =>
      i.setTitle("Attach selection").onClick(() => {
        const snapshot = gesture.take();
        if (snapshot) this.attachSelection(snapshot);
        else new Notice("Select text in a note first.");
      }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Attach file or image")
        .onClick(() =>
          new FilePicker(
            this.app,
            (f) => void this.guard(() => this.attachFile(f)),
          ).open(),
        ),
    );
    menu.showAtMouseEvent(
      new MouseEvent("click", {
        clientX: this.input.getBoundingClientRect().left,
        clientY: this.input.getBoundingClientRect().bottom,
      }),
    );
  }
  private updateBusy() {
    const busy = !!this.turnId || this.starting || this.operation;
    this.sendButton?.setText(
      this.turnId
        ? this.plugin.settings.provider === "claude"
          ? "Running"
          : "Steer"
        : "Send",
    );
    if (this.sendButton)
      this.sendButton.disabled =
        this.starting ||
        this.operation ||
        (!!this.turnId && this.plugin.settings.provider === "claude");
    if (this.stopButton) this.stopButton.disabled = !this.turnId;
    if (busy) this.picker?.close(false);
    this.options
      ?.querySelectorAll("button")
      .forEach((e) => ((e as HTMLButtonElement).disabled = busy));
  }
  private clearRows() {
    for (const row of this.rows.values()) row.component.unload();
    this.rows.clear();
    this.items.clear();
    this.dirty.clear();
  }
  async newChat() {
    this.requireIdle();
    this.threadId = "";
    this.turns.reset();
    this.plugin.settings.lastThreadId = "";
    await this.plugin.save();
    this.title.setText("New conversation");
    this.paginated = false;
    this.clearRows();
    this.transcript.empty();
    this.emptyState();
    this.updateBusy();
  }
  private async ensureThread() {
    if (this.threadId) return;
    const r = await this.plugin.client.request("thread/start", {
      cwd: this.plugin.cwd(),
      model: this.plugin.settings.model || undefined,
      ...threadPolicy(this.plugin.settings.access),
    });
    this.threadId = r.thread.id;
    this.title.setText(r.thread.name || "New conversation");
    this.plugin.settings.lastThreadId = this.threadId;
    await this.plugin.save();
  }
  async resume(id: string, withinOperation = false) {
    if (!withinOperation) this.requireIdle();
    const previousOperation = this.operation;
    this.operation = true;
    this.updateBusy();
    try {
      const r = await this.plugin.client.request("thread/resume", {
        threadId: id,
        cwd: this.plugin.cwd(),
        ...threadPolicy(this.plugin.settings.access),
      });
      if (this.closed) return;
      this.threadId = id;
      this.plugin.settings.lastThreadId = id;
      await this.plugin.save();
      this.title.setText(
        r.thread.name || r.thread.preview?.slice(0, 80) || "Conversation",
      );
      this.clearRows();
      this.transcript.empty();
      let turns = r.thread.turns ?? [];
      this.paginated = r.thread.historyMode === "paginated";
      if (this.paginated) {
        const page: Json = await this.plugin.client.request(
          "thread/turns/list",
          {
            threadId: id,
            limit: 30,
            sortDirection: "desc",
            itemsView: "full",
          },
        );
        turns = [...(page.data ?? [])].reverse();
        this.historyCursor = page.nextCursor;
      } else this.historyCursor = null;
      if (this.historyCursor)
        button(
          this.transcript,
          "Load earlier messages",
          () => void this.guard(() => this.loadEarlier()),
        ).addClass("codex-load-earlier");
      for (const t of turns) {
        for (const item of t.items ?? []) this.putItem(item);
        if (t.status === "inProgress") this.turns.accept(t.id);
      }
      if (["idle", "notLoaded", "systemError"].includes(r.thread.status?.type))
        this.turns.idle();
      if (!this.items.size) this.emptyState();
      this.status.setText(`Connected · ${basename(this.plugin.cwd())}`);
      this.status.title = this.plugin.cwd();
    } finally {
      this.operation = previousOperation;
      this.updateBusy();
    }
  }
  private async loadEarlier() {
    const r = await this.plugin.client.request("thread/turns/list", {
      threadId: this.threadId,
      cursor: this.historyCursor,
      limit: 30,
      sortDirection: "desc",
      itemsView: "full",
    });
    const older = (r.data ?? []).reverse().flatMap((t: Json) => t.items ?? []);
    const current = [...this.items.values()];
    this.clearRows();
    this.transcript.empty();
    this.historyCursor = r.nextCursor;
    if (this.historyCursor)
      button(
        this.transcript,
        "Load earlier messages",
        () => void this.guard(() => this.loadEarlier()),
      ).addClass("codex-load-earlier");
    for (const item of [...older, ...current]) this.putItem(item);
  }
  attach(a: Attachment) {
    if (
      this.attachments.reduce((n, c) => n + (c.text?.length ?? 0), 0) +
        (a.text?.length ?? 0) >
      this.plugin.settings.maxContextChars
    ) {
      new Notice(
        `Attachment limit: ${this.plugin.settings.maxContextChars.toLocaleString()} characters. Select a smaller excerpt.`,
      );
      return;
    }
    this.attachments.push(a);
    this.renderAttachments();
    this.input?.focus();
  }
  async attachActive() {
    await this.guard(async () => {
      const f = this.app.workspace.getActiveFile();
      if (!f) throw new Error("Open a note first.");
      const editor =
        this.app.workspace.activeEditor?.editor ??
        this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
      this.attach({
        label: f.path,
        text: editor ? editor.getValue() : await this.app.vault.read(f),
      });
    });
  }
  private captureSelectionIntent() {
    this.selectionIntent?.dispose();
    this.selectionIntent = selectionGesture(
      this.plugin.noteSelection(this.contentEl.ownerDocument),
    );
  }
  private attachSelectionIntent() {
    const gesture =
      this.selectionIntent ??
      selectionGesture(this.plugin.noteSelection(this.contentEl.ownerDocument));
    this.selectionIntent = undefined;
    const snapshot = gesture.take();
    if (snapshot) this.attachSelection(snapshot);
    else new Notice("Select text in a note first.");
  }
  private watchNoteSelection() {
    const document = this.contentEl.ownerDocument;
    const update = () => {
      const snapshot = this.plugin.noteSelection(document);
      this.selectionButton.hidden = !snapshot;
      this.selectionButton.title = snapshot
        ? "Attach " + snapshot.label
        : "Select note text first";
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", update);
    document.addEventListener("keyup", update);
    const refs = [
      this.app.workspace.on("active-leaf-change", update),
      this.app.workspace.on("file-open", update),
      this.app.workspace.on("editor-change", update),
    ];
    this.selectionWatch = () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", update);
      document.removeEventListener("keyup", update);
      for (const ref of refs) this.app.workspace.offref(ref);
    };
    update();
  }
  attachSelection(
    snapshot: NoteSelection | null = this.plugin.noteSelection(
      this.contentEl.ownerDocument,
    ),
  ) {
    if (!snapshot?.valid()) {
      new Notice(
        "Select text in a note first, or use the Attach selection to chat command.",
      );
      return;
    }
    this.attach({
      label: snapshot.label,
      text: snapshot.text,
      selection: true,
    });
  }
  async attachFile(f: TFile) {
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(f.extension)) {
      const model = this.models.find(
        (m) => m.model === this.plugin.settings.model,
      );
      if (!model?.inputModalities?.includes("image"))
        throw new Error(
          "The selected model does not advertise image input. Select an image-capable model first.",
        );
      if (f.stat.size > 10 * 1024 * 1024)
        throw new Error("Choose an image smaller than 10 MiB.");
      if (this.attachments.filter((a) => a.imagePath).length >= 8)
        throw new Error("Attach up to eight images per message.");
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter))
        throw new Error("Image attachments require a local vault.");
      this.attach({ label: f.path, imagePath: adapter.getFullPath(f.path) });
    } else this.attach({ label: f.path, text: await this.app.vault.read(f) });
  }
  private renderAttachments() {
    this.attachmentsEl.empty();
    for (const [index, a] of this.attachments.entries()) {
      const card = this.attachmentsEl.createDiv({
        cls: a.selection ? "codex-selection-attachment" : "codex-attachment",
      });
      const chip = card.createSpan({ cls: "codex-chip" });
      chip.createSpan({
        text: `${a.label} · ${a.imagePath ? "image" : (a.text?.length ?? 0).toLocaleString() + " chars"}`,
      });
      if (a.selection && a.text) {
        const preview = card.createEl("details", {
          cls: "codex-excerpt-preview",
        });
        preview.createEl("summary", {
          text:
            a.text.replace(/\s+/g, " ").slice(0, 100) +
            (a.text.length > 100 ? "…" : ""),
        });
        preview.createEl("pre", { text: a.text });
      }
      button(
        chip,
        "×",
        () => {
          this.attachments.splice(index, 1);
          this.renderAttachments();
        },
        `Remove ${a.label}`,
      );
    }
  }
  private async send() {
    const prompt = this.input.value.trim();
    if (!prompt || this.starting || this.operation) return;
    if (this.localCommand(prompt)) {
      this.input.value = "";
      return;
    }
    await this.guard(async () => {
      const client = this.plugin.client;
      await client.connect();
      if (client !== this.plugin.client || this.starting || this.operation)
        return;
      const steer = !!this.turnId;
      this.starting = true;
      this.updateBusy();
      try {
        await this.ensureThread();
        const input = buildInput(prompt, this.attachments);
        let result;
        if (steer)
          result = await this.plugin.client.request("turn/steer", {
            threadId: this.threadId,
            expectedTurnId: this.turnId,
            input,
          });
        else {
          const s = this.plugin.settings;
          const params: Json = {
            threadId: this.threadId,
            input,
            cwd: this.plugin.cwd(),
            model: s.model || undefined,
            effort: s.effort,
            ...turnPolicy(s.access, this.plugin.cwd()),
            collaborationMode: {
              mode: s.plan ? "plan" : "default",
              settings: {
                model: s.model,
                reasoning_effort: s.effort,
                developer_instructions: null,
              },
            },
          };
          if (!s.model) delete params.collaborationMode;
          result = await this.plugin.client.request("turn/start", params);
        }
        const id = result.turn?.id ?? result.turnId;
        this.turns.accept(id);
        if (this.title.textContent === "New conversation")
          this.title.setText(prompt.split("\n")[0].slice(0, 80));
        this.input.value = "";
        this.attachments = [];
        this.renderAttachments();
        if (this.turnId)
          this.status.setText(
            steer
              ? "Follow-up added to the running turn."
              : `${this.plugin.providerLabel} is working…`,
          );
      } finally {
        this.starting = false;
        this.updateBusy();
      }
    });
  }
  private putItem(item: Json) {
    if (!item.id) return;
    this.transcript.querySelector(".codex-empty")?.remove();
    const existing = this.items.get(item.id);
    this.items.set(item.id, { ...existing, ...item });
    if (!this.rows.has(item.id)) {
      const outer = this.transcript.createDiv({
        cls: `codex-item codex-${item.type}`,
      });
      outer.createDiv({
        cls: "codex-item-label",
        text:
          item.type === "userMessage"
            ? "You"
            : item.type === "agentMessage"
              ? this.plugin.providerLabel
              : item.type.replace(/([A-Z])/g, " $1"),
      });
      let body: HTMLElement;
      if (["agentMessage", "userMessage", "plan"].includes(item.type))
        body = outer.createDiv({ cls: "codex-message" });
      else {
        const d = outer.createEl("details");
        d.createEl("summary", { text: item.command || item.tool || item.type });
        body = d.createEl("pre");
      }
      const component = new Component();
      component.load();
      this.rows.set(item.id, { body, version: 0, component });
    }
    this.scheduleRender(item.id);
  }
  private scheduleRender(id: string) {
    this.dirty.add(id);
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      for (const id of this.dirty) this.renderItem(id);
      this.dirty.clear();
    }, 60);
  }
  private openChangedFile(path: string) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const rel = isAbsolute(path) ? relative(adapter.getBasePath(), path) : path;
    if (rel.startsWith("..") || isAbsolute(rel)) {
      new Notice(
        "This file is outside the vault. Its path is available in the change details.",
      );
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizePath(rel));
    if (file instanceof TFile)
      void this.app.workspace.getLeaf(false).openFile(file);
    else
      new Notice(
        "File is not present in this vault (it may have been deleted).",
      );
  }
  private renderItem(id: string) {
    const item = this.items.get(id),
      row = this.rows.get(id);
    if (!item || !row) return;
    const bottom =
      this.transcript.scrollHeight -
        this.transcript.scrollTop -
        this.transcript.clientHeight <
      100;
    if (item.type === "fileChange") {
      const outer = row.body.closest(".codex-item") as HTMLElement;
      outer.querySelector(".codex-changed-files")?.remove();
      const links = outer.createDiv({
        cls: "codex-changed-files codex-actions",
      });
      for (const change of item.changes ?? [])
        button(
          links,
          change.path,
          () => this.openChangedFile(change.path),
          "Open changed vault file",
        );
    }
    const text = itemText(item);
    const version = ++row.version;
    row.component.unload();
    row.component = new Component();
    row.component.load();
    row.body.empty();
    if (["agentMessage", "plan"].includes(item.type)) {
      const target = row.body.createDiv();
      void MarkdownRenderer.render(
        this.app,
        text,
        target,
        this.app.workspace.getActiveFile()?.path ?? "",
        row.component,
      ).then(() => {
        if (version !== row.version) target.remove();
        if (bottom) this.transcript.scrollTop = this.transcript.scrollHeight;
      });
    } else if (item.type === "userMessage") {
      const parts = splitUserContext(text);
      row.body.createDiv({ text: parts.prompt });
      if (parts.context) detail(row.body, "Attached context", parts.context);
    } else row.body.setText(text);
    if (bottom) this.transcript.scrollTop = this.transcript.scrollHeight;
  }
  private onEvent(method: string, p: Json) {
    if (p.threadId && p.threadId !== this.threadId) return;
    if (!this.threadId) return;
    if (
      method === "thread/status/changed" &&
      ["idle", "notLoaded", "systemError"].includes(p.status?.type)
    ) {
      this.turns.idle();
      this.updateBusy();
    } else if (method === "turn/started") {
      this.turns.accept(p.turn.id);
      this.updateBusy();
    } else if (method === "turn/completed") {
      this.turns.finish(p.turn.id);
      this.status.setText(
        p.turn.error?.message ?? `Turn ${p.turn.status ?? "completed"}`,
      );
      this.updateBusy();
    } else if (method === "item/started" || method === "item/completed")
      this.putItem(p.item);
    else if (
      method === "item/agentMessage/delta" ||
      method === "item/plan/delta"
    ) {
      const item = this.items.get(p.itemId) ?? {
        id: p.itemId,
        type: method.includes("agentMessage") ? "agentMessage" : "plan",
        text: "",
      };
      this.putItem({ ...item, text: (item.text ?? "") + p.delta });
    } else if (method === "item/commandExecution/outputDelta") {
      const item = this.items.get(p.itemId);
      if (item)
        this.putItem({
          ...item,
          aggregatedOutput: (item.aggregatedOutput ?? "") + p.delta,
        });
    } else if (method === "item/reasoning/summaryTextDelta") {
      const item = this.items.get(p.itemId) ?? {
        id: p.itemId,
        type: "reasoning",
        summary: [],
      };
      const summary = [...(item.summary ?? [])];
      summary[p.summaryIndex] = (summary[p.summaryIndex] ?? "") + p.delta;
      this.putItem({ ...item, summary });
    } else if (method === "item/fileChange/patchUpdated") {
      const item = this.items.get(p.itemId) ?? {
        id: p.itemId,
        type: "fileChange",
      };
      this.putItem({ ...item, changes: p.changes });
    } else if (method === "item/mcpToolCall/progress") {
      const item = this.items.get(p.itemId);
      if (item) this.putItem({ ...item, progress: p.message });
    } else if (method === "turn/diff/updated")
      this.putItem({
        id: `diff-${p.turnId}`,
        type: "diff",
        text: p.diff,
        diff: p.diff,
      });
    else if (method === "turn/plan/updated")
      this.putItem({
        id: `plan-${p.turnId}`,
        type: "plan",
        text: [
          p.explanation,
          ...(p.plan ?? []).map(
            (s: Json) =>
              `- [${s.status === "completed" ? "x" : " "}] ${s.step} (${s.status})`,
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    else if (method === "thread/name/updated" && p.threadName)
      this.title.setText(p.threadName);
    else if (method === "error")
      this.status.setText(
        p.error?.message ??
          p.message ??
          `${this.plugin.providerLabel} reported an error`,
      );
    else if (method === "thread/tokenUsage/updated") {
      const info = p.tokenUsage?.last;
      if (info)
        this.status.setText(
          `Tokens this turn: ${(info.totalTokens ?? 0).toLocaleString()} · ${this.turnId ? "Working" : "Ready"}`,
        );
    } else if (method === "serverRequest/resolved") {
      this.pending = this.pending.filter((m) => m.id !== p.requestId);
      if (this.requestModal && this.requestModal.message.id === p.requestId)
        this.requestModal.cancelWithoutResponse();
    }
  }
  private onRequest(message: Json) {
    if (message.params?.threadId && message.params.threadId !== this.threadId) {
      this.plugin.client.rejectRequest(
        message.id,
        "This thread is not open in the Obsidian panel",
      );
      return;
    }
    const supported = [
      "claude/tool/requestApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ];
    if (!supported.includes(message.method)) {
      this.plugin.client.rejectRequest(message.id);
      return;
    }
    this.pending.push(message);
    this.showRequest();
  }
  private showRequest() {
    if (this.requestModal || !this.pending.length || this.closed) return;
    const m = this.pending.shift()!;
    this.status.setText("Waiting for your input or approval");
    this.requestModal = new RequestModal(
      this.app,
      m,
      (result) => {
        try {
          this.plugin.client.respond(m.id, result);
        } catch (e) {
          new Notice(errorMessage(e));
        }
      },
      () => {
        this.requestModal = undefined;
        this.showRequest();
      },
    );
    this.requestModal.open();
  }
  runAction(action: string) {
    if (action === "rename") this.renameConversation();
    else if (action === "copy") void this.copyLatestResponse();
    else this.localCommand("/" + action);
  }
  private renameConversation() {
    if (!this.threadId) {
      new Notice("Send a message first.");
      return;
    }
    const id = this.threadId;
    new InputModal(
      this.app,
      "Conversation name",
      this.title.textContent ?? "",
      (name) =>
        void this.guard(async () => {
          await this.plugin.client.request("thread/name/set", {
            threadId: id,
            name,
          });
          if (this.threadId === id) this.title.setText(name);
        }),
    ).open();
  }
  private async copyLatestResponse() {
    await this.guard(async () => {
      const text = [...this.items.values()]
        .filter((i) => i.type === "agentMessage")
        .at(-1)?.text;
      if (!text) throw new Error("No response to copy.");
      await navigator.clipboard.writeText(text);
      new Notice("Response copied");
    });
  }
  private commandMenu() {
    const menu = new Menu();
    for (const [command, description] of [
      ["/new", "New conversation"],
      ["/history", "Conversation history"],
      ["/review", "Review Git changes"],
      ["/skills", "Discover skills"],
      ["/mcp", "MCP servers and tools"],
      ["/status", "Account and usage limits"],
      ["/export", "Export to note"],
      ["/help", "Command help"],
    ])
      menu.addItem((i) =>
        i.setTitle(`${command} · ${description}`).onClick(() => {
          this.localCommand(command);
        }),
      );
    menu.showAtMouseEvent(
      new MouseEvent("click", {
        clientX: this.contentEl.getBoundingClientRect().left + 30,
        clientY: this.input.getBoundingClientRect().top,
      }),
    );
  }
  private localCommand(text: string): boolean {
    const command = text.toLowerCase();
    switch (command) {
      case "/new":
        void this.guard(() => this.newChat());
        break;
      case "/history":
        void this.guard(async () => {
          await this.plugin.client.connect();
          new HistoryModal(this.app, this).open();
        });
        break;
      case "/review":
        void this.review();
        break;
      case "/skills":
        void this.inspect("Available skills", [
          ["skills/list", { cwds: [this.plugin.cwd()] }],
        ]);
        break;
      case "/mcp":
        void this.inspect("MCP servers and tools", [
          [
            "mcpServerStatus/list",
            {
              limit: 100,
              detail: "toolsAndAuthOnly",
              ...(this.threadId ? { threadId: this.threadId } : {}),
            },
          ],
        ]);
        break;
      case "/status":
        void this.inspect("Account and usage limits", [
          ["account/read", { refreshToken: false }],
          ["account/rateLimits/read", {}],
        ]);
        break;
      case "/export":
        void this.exportNote();
        break;
      case "/help":
        new InfoModal(
          this.app,
          `${this.plugin.providerLabel} commands`,
          "/new — New conversation\n/history — Resume or restore a conversation\n/review — Review uncommitted Git changes\n/skills — List available skills (Claude uses /skill-name; Codex uses $name)\n/mcp — Inspect configured servers and tools\n/status — Account and rate limits\n/export — Save the full conversation to a vault note\n\nUse the controls above the chat for model, reasoning, permissions, and Plan mode. Provider CLI slash commands are not a complete local command interface. Claude live steering and manual compaction are unavailable.",
        ).open();
        break;
      default:
        return false;
    }
    return true;
  }
  private menu() {
    const m = new Menu();
    m.addItem((i) =>
      i
        .setTitle("Reconnect")
        .setIcon("refresh-cw")
        .onClick(() => {
          this.plugin.client.disconnect();
          void this.connect();
        }),
    );
    m.addItem((i) =>
      i
        .setTitle("Rename conversation")
        .onClick(() => this.renameConversation()),
    );
    m.addItem((i) =>
      i.setTitle("Fork conversation").onClick(
        () =>
          void this.guard(async () => {
            this.requireIdle();
            if (!this.threadId) throw new Error("Send a message first.");
            this.operation = true;
            this.updateBusy();
            let id: string;
            try {
              const r = await this.plugin.client.request("thread/fork", {
                threadId: this.threadId,
                cwd: this.plugin.cwd(),
                ...threadPolicy(this.plugin.settings.access),
              });
              id = r.thread.id;
            } finally {
              this.operation = false;
              this.updateBusy();
            }
            await this.resume(id);
          }),
      ),
    );
    m.addItem((i) =>
      i.setTitle("Archive conversation").onClick(
        () =>
          void this.guard(async () => {
            this.requireIdle();
            if (!this.threadId) return;
            this.operation = true;
            this.updateBusy();
            try {
              await this.plugin.client.request("thread/archive", {
                threadId: this.threadId,
              });
            } finally {
              this.operation = false;
              this.updateBusy();
            }
            await this.newChat();
          }),
      ),
    );
    m.addSeparator();
    m.addItem((i) =>
      i
        .setTitle("Review uncommitted Git changes")
        .onClick(() => void this.review()),
    );
    if (this.plugin.settings.provider === "codex")
      m.addItem((i) =>
        i.setTitle("Compact conversation").onClick(
          () =>
            void this.guard(async () => {
              this.requireIdle();
              if (!this.threadId) throw new Error("Send a message first.");
              await this.plugin.client.request("thread/compact/start", {
                threadId: this.threadId,
              });
            }),
        ),
      );
    m.addSeparator();
    m.addItem((i) =>
      i
        .setTitle("Copy latest response")
        .onClick(() => void this.copyLatestResponse()),
    );
    m.addItem((i) =>
      i.setTitle("Copy conversation").onClick(
        () =>
          void this.guard(async () => {
            const items = await this.conversationItems();
            if (!items.length) throw new Error("No conversation to copy.");
            await navigator.clipboard.writeText(
              items.map((i) => `## ${i.type}\n\n${itemText(i)}`).join("\n\n"),
            );
            new Notice("Conversation copied");
          }),
      ),
    );
    m.addItem((i) =>
      i
        .setTitle("Save latest response to note")
        .onClick(() => void this.exportNote(true)),
    );
    m.addItem((i) =>
      i
        .setTitle("Export conversation to note")
        .onClick(() => void this.exportNote()),
    );
    m.addItem((i) =>
      i.setTitle("Account and usage limits").onClick(
        () =>
          void this.inspect("Account and usage limits", [
            ["account/read", { refreshToken: false }],
            ["account/rateLimits/read", {}],
          ]),
      ),
    );
    m.addItem((i) =>
      i
        .setTitle("Discover skills")
        .onClick(
          () =>
            void this.inspect("Available skills", [
              ["skills/list", { cwds: [this.plugin.cwd()] }],
            ]),
        ),
    );
    m.addItem((i) =>
      i.setTitle("MCP servers and tools").onClick(
        () =>
          void this.inspect("MCP servers and tools", [
            [
              "mcpServerStatus/list",
              {
                limit: 100,
                detail: "toolsAndAuthOnly",
                ...(this.threadId ? { threadId: this.threadId } : {}),
              },
            ],
          ]),
      ),
    );
    m.showAtMouseEvent(
      new MouseEvent("click", {
        clientX: this.contentEl.getBoundingClientRect().right - 20,
        clientY: this.contentEl.getBoundingClientRect().top + 40,
      }),
    );
  }
  private requireIdle() {
    if (this.turnId || this.starting || this.operation)
      throw new Error("Stop the current turn before this action.");
  }
  private async review() {
    await this.guard(async () => {
      this.requireIdle();
      this.starting = true;
      this.updateBusy();
      try {
        await this.plugin.client.connect();
        await this.ensureThread();
        await this.plugin.client.request("thread/resume", {
          threadId: this.threadId,
          excludeTurns: true,
          cwd: this.plugin.cwd(),
          ...threadPolicy(this.plugin.settings.access),
        });
        this.turns.beginReview();
        const r = await this.plugin.client.request("review/start", {
          threadId: this.threadId,
          target: { type: "uncommittedChanges" },
          delivery: "inline",
          ...(this.plugin.settings.provider === "claude"
            ? {
                model: this.plugin.settings.model,
                effort: this.plugin.settings.effort,
              }
            : {}),
        });
        this.turns.accept(r.turn?.id);
      } finally {
        this.starting = false;
        this.updateBusy();
      }
    });
  }
  private async inspect(title: string, calls: [string, Json][]) {
    await this.guard(async () => {
      await this.plugin.client.connect();
      const results = await Promise.allSettled(
        calls.map(([method, params]) =>
          this.plugin.client.request(method, params),
        ),
      );
      const text = results
        .map(
          (r, i) =>
            `${calls[i][0]}\n${r.status === "fulfilled" ? JSON.stringify(r.value, null, 2) : errorMessage(r.reason)}`,
        )
        .join("\n\n");
      new InfoModal(this.app, title, text).open();
    });
  }
  private async conversationItems() {
    if (!this.paginated || !this.threadId) return [...this.items.values()];
    const turns: Json[] = [];
    let cursor: string | null = null;
    do {
      const page: Json = await this.plugin.client.request("thread/turns/list", {
        threadId: this.threadId,
        cursor,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const items = new Map<string, Json>();
    for (const t of turns.reverse())
      for (const item of t.items ?? []) items.set(item.id, item);
    for (const item of this.items.values()) items.set(item.id, item);
    return [...items.values()];
  }
  private async exportNote(latestOnly = false) {
    await this.guard(async () => {
      if (!this.items.size) throw new Error("No conversation to export.");
      const exportItems = latestOnly
        ? [...this.items.values()]
            .filter((i) => i.type === "agentMessage")
            .slice(-1)
        : await this.conversationItems();
      if (!exportItems.length) throw new Error("No response to export.");
      const rawFolder = this.plugin.settings.exportFolder.trim();
      if (isAbsolute(rawFolder))
        throw new Error(
          "Choose a vault-relative export folder in Settings → Codex.",
        );
      const folder = normalizePath(rawFolder);
      if (
        !folder ||
        folder === "." ||
        folder.split("/").includes("..") ||
        isAbsolute(folder)
      )
        throw new Error(
          "Choose a vault-relative export folder in Settings → Codex.",
        );
      if (!this.app.vault.getAbstractFileByPath(folder))
        await this.app.vault.createFolder(folder);
      const date = new Date().toISOString().replace(/[:.]/g, "-");
      const title = (this.title.textContent ?? "Codex")
        .replace(/[\\/:*?"<>|#\[\]]/g, "")
        .slice(0, 60);
      const contents = `# ${title}\n\nExported ${new Date().toLocaleString()}\n\nProvider: ${this.plugin.providerLabel}\n\nThread: ${this.threadId}\n\n${exportItems.map((i) => `## ${i.type === "userMessage" ? "You" : i.type === "agentMessage" ? this.plugin.providerLabel : i.type}\n\n${["agentMessage", "userMessage", "plan"].includes(i.type) ? itemText(i) : "```text\n" + itemText(i).replace(/```/g, "ˋˋˋ") + "\n```"}`).join("\n\n")}`;
      const f = await this.app.vault.create(
        `${folder}/${title || "Codex"} ${date}.md`,
        contents,
      );
      await this.app.workspace.getLeaf(false).openFile(f);
      new Notice("Conversation exported");
    });
  }
}
