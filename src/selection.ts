import type { Attachment } from "./session";
export interface SelectionEditor {
  getSelection(): string;
  getCursor?(side: "from" | "to"): { line: number; ch: number };
  getRange?(
    from: { line: number; ch: number },
    to: { line: number; ch: number },
  ): string;
}
export interface SelectionView {
  file: { path: string } | null;
  contentEl: HTMLElement;
  editor?: SelectionEditor;
}
export interface NoteSelection extends Attachment {
  text: string;
  sourcePath: string;
  document: Document;
  body: HTMLElement | null;
  valid(): boolean;
}
const BODY =
  ".markdown-source-view .cm-content, .markdown-preview-view .markdown-preview-sizer, .markdown-reading-view .markdown-preview-sizer";
const EXCLUDED =
  ".inline-title,.metadata-container,.cm-gutters,.view-header,.markdown-embed";
const element = (node: Node | null) =>
  node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
function bodyFor(view: SelectionView, node: Node): HTMLElement | null {
  const el = element(node);
  if (!el || !view.contentEl.contains(node) || el.closest(EXCLUDED))
    return null;
  const body = el.closest<HTMLElement>(BODY);
  return body && view.contentEl.contains(body) ? body : null;
}
function editorLines(
  editor: SelectionEditor | undefined,
  text: string,
): string {
  try {
    if (!editor || editor.getSelection() !== text || !editor.getCursor)
      return "";
    const from = editor.getCursor("from"),
      to = editor.getCursor("to");
    if (editor.getRange && editor.getRange(from, to) !== text) return "";
    const start = from.line + 1,
      end = Math.max(start, to.line + (to.ch === 0 ? 0 : 1));
    return start === end ? ` · L${start}` : ` · L${start}-L${end}`;
  } catch {
    return "";
  }
}
/** Resolve the actual current DOM range first, including rendered Live Preview widgets. */
export function captureNoteSelection(
  views: SelectionView[],
  document: Document,
): NoteSelection | null {
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    if (selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const text = selection.toString();
    if (!text.trim()) return null;
    for (const view of views) {
      if (!view.file || view.contentEl.ownerDocument !== document) continue;
      const body = bodyFor(view, range.startContainer);
      if (!body || body !== bodyFor(view, range.endContainer)) continue;
      if (
        Array.from(body.querySelectorAll(EXCLUDED)).some((el) =>
          range.intersectsNode(el),
        )
      )
        return null;
      const path = view.file.path;
      const snapshot = range.cloneRange();
      return {
        text,
        label: `Selection · ${path}${editorLines(view.editor, text)}`,
        sourcePath: path,
        document,
        body,
        valid: () =>
          view.file?.path === path &&
          body.isConnected &&
          snapshot.startContainer.isConnected &&
          snapshot.endContainer.isConnected &&
          body.contains(snapshot.startContainer) &&
          body.contains(snapshot.endContainer) &&
          snapshot.toString() === text,
      };
    }
    // Never fall back to a saved editor range when the user selected chat/UI/another source.
    return null;
  }
  // CodeMirror can retain an editor selection without a browser range. Only use it while that note has focus.
  for (const view of views) {
    const focused = document.activeElement;
    if (
      !view.file ||
      !focused ||
      !view.contentEl.contains(focused) ||
      !element(focused)?.closest(".markdown-source-view")
    )
      continue;
    const captured = captureEditorSelection(view.editor, view);
    if (captured) return captured;
  }
  return null;
}
/** Explicit editor callbacks provide authoritative source identity before any async view opening. */
export function captureEditorSelection(
  editor: SelectionEditor | undefined,
  info: {
    file: { path: string } | null;
    contentEl?: HTMLElement;
    containerEl?: HTMLElement;
  },
): NoteSelection | null {
  const path = info.file?.path;
  const text = editor?.getSelection();
  if (!path || !text?.trim() || !editor) return null;
  const root = info.contentEl ?? info.containerEl;
  const document = root?.ownerDocument ?? globalThis.document;
  const from = editor.getCursor?.("from"),
    to = editor.getCursor?.("to");
  return {
    text,
    label: `Selection · ${path}${editorLines(editor, text)}`,
    sourcePath: path,
    document,
    body: root ?? null,
    valid: () =>
      info.file?.path === path &&
      editor.getSelection() === text &&
      (!from || !to || !editor.getRange || editor.getRange(from, to) === text),
  };
}
/** A single attachment gesture may outlive focus collapse; it is never a global last-selection cache. */
export function selectionGesture(snapshot: NoteSelection | null) {
  let invalid = false,
    consumed = false;
  const doc = snapshot?.document;
  const changed = (event: Event) => {
    const target = element(event.target as Node);
    if (
      target?.closest(
        ".markdown-source-view,.markdown-preview-view,.markdown-reading-view",
      )
    )
      invalid = true;
  };
  const selectionChanged = () => {
    const current = doc?.getSelection();
    if (current && !current.isCollapsed && current.rangeCount) {
      const range = current.getRangeAt(0);
      if (
        current.toString() !== snapshot?.text ||
        !snapshot?.body?.contains(range.startContainer) ||
        !snapshot.body.contains(range.endContainer)
      )
        invalid = true;
    }
  };
  if (doc) {
    doc.addEventListener("pointerdown", changed, true);
    doc.addEventListener("keydown", changed, true);
    doc.addEventListener("selectionchange", selectionChanged);
  }
  const dispose = () => {
    doc?.removeEventListener("pointerdown", changed, true);
    doc?.removeEventListener("keydown", changed, true);
    doc?.removeEventListener("selectionchange", selectionChanged);
  };
  return {
    take: () => {
      if (consumed || invalid || !snapshot?.valid()) {
        dispose();
        consumed = true;
        return null;
      }
      consumed = true;
      dispose();
      return snapshot;
    },
    dispose,
  };
}
