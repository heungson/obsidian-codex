// Minimal Obsidian host contracts; native UI rendering is verified separately in Obsidian.
export const notices: string[] = [];
export class Component {
  load() {}
  unload() {}
}
export class App {}
export class Plugin extends Component {
  app: any;
  views = new Map<string, any>();
  commands: any[] = [];
  constructor(app: any) {
    super();
    this.app = app;
    app.plugin = this;
  }
  async loadData() {
    return this.app.savedSettings ?? {};
  }
  async saveData(data: any) {
    this.app.savedSettings = structuredClone(data);
  }
  registerView(type: string, factory: any) {
    this.views.set(type, factory);
  }
  addSettingTab() {}
  addRibbonIcon() {}
  addCommand(command: any) {
    this.commands.push(command);
  }
  registerEvent() {}
}
export class ItemView extends Component {
  app: any;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(public leaf: any) {
    super();
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.contentEl = this.containerEl.appendChild(
      document.createElement("div"),
    );
    document.body.append(this.containerEl);
  }
}
export class Modal {
  app: any;
  modalEl: HTMLElement;
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  private opened = false;
  constructor(app: any) {
    this.app = app;
    this.modalEl = document.createElement("section");
    this.modalEl.className = "modal";
    this.titleEl = this.modalEl.appendChild(document.createElement("h1"));
    this.contentEl = this.modalEl.appendChild(document.createElement("div"));
  }
  open() {
    this.opened = true;
    document.body.append(this.modalEl);
    (this as any).onOpen?.();
  }
  close() {
    if (!this.opened) return;
    this.opened = false;
    (this as any).onClose?.();
    this.modalEl.remove();
  }
}
export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder() {}
  getItems(): T[] {
    return [];
  }
  getItemText() {
    return "";
  }
}
export class PluginSettingTab {
  containerEl: HTMLElement;
  app: any;
  constructor(app: any, _plugin: any) {
    this.app = app;
    this.containerEl = document.createElement("div");
  }
}
export class Setting {
  constructor(private el: HTMLElement) {}
  setName(name: string) {
    this.el.appendChild(document.createElement("label")).textContent = name;
    return this;
  }
  setDesc() {
    return this;
  }
  addToggle(callback: any) {
    const input = this.el.appendChild(document.createElement("input"));
    input.type = "checkbox";
    callback({
      onChange: (f: any) => {
        input.addEventListener("change", () => f(input.checked));
        return this;
      },
    });
    return this;
  }
  addButton() {
    return this;
  }
  addText() {
    return this;
  }
}
export class Menu {
  private hides: Array<() => void> = [];
  onHide(callback: () => void) {
    this.hides.push(callback);
  }
  private actions: { title: string; action: () => void }[] = [];
  addItem(callback: any) {
    const entry = { title: "", action: () => {} };
    const item = {
      setTitle: (title: string) => {
        entry.title = title;
        return item;
      },
      setIcon: () => item,
      onClick: (action: () => void) => {
        entry.action = action;
        return item;
      },
    };
    callback(item);
    this.actions.push(entry);
    return this;
  }
  addSeparator() {
    return this;
  }
  showAtMouseEvent() {
    const menu = document.body.appendChild(document.createElement("nav"));
    menu.className = "test-menu";
    for (const a of this.actions) {
      const button = menu.appendChild(document.createElement("button"));
      button.textContent = a.title;
      button.addEventListener("click", () => {
        menu.remove();
        a.action();
        this.hides.forEach((f) => f());
      });
    }
  }
}
export class Notice {
  constructor(text: string) {
    notices.push(text);
  }
}
export class TFile {
  extension: string;
  stat = { size: 30 };
  constructor(
    public path: string,
    public text = "",
  ) {
    this.extension = path.split(".").at(-1) ?? "";
  }
}
export class MarkdownView {}
export class FileSystemAdapter {
  constructor(private path = "/vault") {}
  getBasePath() {
    return this.path;
  }
  getFullPath(path: string) {
    return this.path + "/" + path;
  }
}
export const MarkdownRenderer = {
  async render(_app: any, text: string, target: HTMLElement) {
    target.textContent = text;
  },
};
export function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}
export class WorkspaceLeaf {}
export function setIcon(element: HTMLElement, icon: string) {
  const svg = element.ownerDocument.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  svg.setAttribute("data-icon", icon);
  element.replaceChildren(svg);
}
