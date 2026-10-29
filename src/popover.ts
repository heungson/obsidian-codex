let nextPickerId = 1;
/** Small non-modal picker owned by its trigger; never changes renderer globals. */
export class ComposerPopover {
  readonly content: HTMLElement;
  private closed = false;
  private document: Document;
  private window: Window | null;
  private pointer = (event: Event) => {
    const target = event.target as Node | null;
    if (
      target &&
      !this.content.contains(target) &&
      !this.anchor.contains(target)
    )
      this.close(false);
  };
  private focus = (event: FocusEvent) => {
    const target = event.target as Node | null;
    if (
      target &&
      !this.content.contains(target) &&
      !this.anchor.contains(target)
    )
      this.close(false);
  };
  private key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    }
  };
  private resize = () => this.close(false);
  constructor(
    private anchor: HTMLButtonElement,
    label: string,
    private boundary: HTMLElement,
    private finished: () => void,
  ) {
    this.document = anchor.ownerDocument;
    this.window = this.document.defaultView;
    this.content = this.document.createElement("div");
    this.content.className = "codex-composer-popover";
    this.content.id = `codex-picker-${nextPickerId++}`;
    this.content.setAttribute("role", "dialog");
    this.content.setAttribute("aria-label", label);
    this.content.tabIndex = -1;
    anchor.setAttribute("aria-haspopup", "dialog");
    anchor.setAttribute("aria-controls", this.content.id);
    anchor.setAttribute("aria-expanded", "true");
    this.document.body.append(this.content);
    this.document.addEventListener("pointerdown", this.pointer, true);
    this.document.addEventListener("focusin", this.focus, true);
    this.document.addEventListener("keydown", this.key, true);
    this.window?.addEventListener("resize", this.resize);
  }
  show() {
    const anchor = this.anchor.getBoundingClientRect();
    const panel = this.boundary.getBoundingClientRect();
    const viewportWidth =
      this.document.documentElement.clientWidth ||
      this.window?.innerWidth ||
      800;
    const viewportHeight =
      this.document.documentElement.clientHeight ||
      this.window?.innerHeight ||
      600;
    const width = Math.min(
      320,
      Math.max(180, (panel.width || 320) - 16),
      viewportWidth - 16,
    );
    this.content.style.width = `${width}px`;
    this.content.style.maxHeight = `${Math.min(360, Math.max(120, viewportHeight - 24))}px`;
    const height = Math.min(
      this.content.scrollHeight || 230,
      360,
      viewportHeight - 24,
    );
    const left = Math.max(
      8,
      Math.min(
        anchor.left,
        Math.max(8, panel.right - width - 4),
        viewportWidth - width - 8,
      ),
    );
    const top =
      anchor.top - height - 6 >= 8
        ? anchor.top - height - 6
        : Math.min(anchor.bottom + 6, viewportHeight - height - 8);
    this.content.style.left = `${left}px`;
    this.content.style.top = `${Math.max(8, top)}px`;
    const first = this.content.querySelector<HTMLElement>(
      'select,button,input,[tabindex="0"]',
    );
    (first ?? this.content).focus();
  }
  close(restoreFocus = true) {
    if (this.closed) return;
    this.closed = true;
    this.document.removeEventListener("pointerdown", this.pointer, true);
    this.document.removeEventListener("focusin", this.focus, true);
    this.document.removeEventListener("keydown", this.key, true);
    this.window?.removeEventListener("resize", this.resize);
    this.content.remove();
    this.anchor.setAttribute("aria-expanded", "false");
    this.anchor.removeAttribute("aria-controls");
    this.finished();
    if (restoreFocus && this.anchor.isConnected && !this.anchor.disabled)
      this.anchor.focus();
  }
}
