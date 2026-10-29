import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  captureNoteSelection,
  captureEditorSelection,
  selectionGesture,
  type SelectionView,
} from "../src/selection";
function fixture(mode: "source" | "reading" = "source") {
  const window = new Window();
  const document = window.document as unknown as Document;
  const root = document.body.appendChild(document.createElement("div"));
  root.innerHTML =
    mode === "source"
      ? '<div class="markdown-source-view"><div class="cm-content" tabindex="0"><p>ASTER-592 belongs to Mira.</p><div class="cm-html-embed"><blockquote>VIOLET-627 belongs to Jun.</blockquote></div></div></div>'
      : '<div class="markdown-preview-view"><div class="markdown-preview-sizer"><div class="inline-title">Not note text</div><div class="metadata-container">Property value</div><p>Rendered exact passage.</p></div></div>';
  const view: SelectionView = { file: { path: "Notes/A.md" }, contentEl: root };
  return { window, document, root, view };
}
function select(
  document: Document,
  node: Node,
  start = 0,
  end = node.textContent!.length,
) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
test("Live Preview rendered HTML range wins over absent/stale editor selection and preserves exact text", () => {
  const f = fixture();
  f.view.editor = { getSelection: () => "Unselected COPPER-184" };
  const node = f.root.querySelector("blockquote")!.firstChild!;
  select(f.document, node, 0, 10);
  const captured = captureNoteSelection([f.view], f.document)!;
  assert.equal(captured.text, "VIOLET-627");
  assert.equal(captured.label, "Selection · Notes/A.md");
  assert.equal(captured.sourcePath, "Notes/A.md");
  assert.equal(captured.valid(), true);
});
test("reading view accepts note body but rejects inline title, metadata, chat, and cross-note selections", () => {
  const f = fixture("reading");
  select(f.document, f.root.querySelector("p")!.firstChild!);
  assert.equal(
    captureNoteSelection([f.view], f.document)!.text,
    "Rendered exact passage.",
  );
  for (const selector of [".inline-title", ".metadata-container"]) {
    select(f.document, f.root.querySelector(selector)!.firstChild!);
    assert.equal(captureNoteSelection([f.view], f.document), null);
  }
  const chat = f.document.body.appendChild(f.document.createElement("div"));
  chat.textContent = "Chat response";
  select(f.document, chat.firstChild!);
  assert.equal(captureNoteSelection([f.view], f.document), null);
  const range = f.document.createRange();
  range.setStart(f.root.querySelector("p")!.firstChild!, 0);
  range.setEnd(chat.firstChild!, 4);
  f.document.getSelection()!.removeAllRanges();
  f.document.getSelection()!.addRange(range);
  assert.equal(captureNoteSelection([f.view], f.document), null);
});
test("editor fallback requires actual note focus and reliable positions; chat focus never reuses a retained range", () => {
  const f = fixture();
  let text = "Exact source\nSecond line";
  f.view.editor = {
    getSelection: () => text,
    getCursor: (side) =>
      side === "from" ? { line: 1, ch: 0 } : { line: 2, ch: 11 },
    getRange: () => text,
  };
  (f.root.querySelector(".cm-content") as HTMLElement).focus();
  const snapshot = captureNoteSelection([f.view], f.document)!;
  assert.equal(snapshot.text, text);
  assert.match(snapshot.label, /L2-L3/);
  const input = f.document.body.appendChild(
    f.document.createElement("textarea"),
  );
  input.focus();
  assert.equal(captureNoteSelection([f.view], f.document), null);
  text = "";
  assert.equal(snapshot.valid(), false);
});
test("one gesture survives expected UI focus collapse but invalidates note interaction, source changes, and changed selection", () => {
  const f = fixture();
  const node = f.root.querySelector("p")!.firstChild!;
  select(f.document, node, 0, 9);
  const snapshot = captureNoteSelection([f.view], f.document)!;
  const gesture = selectionGesture(snapshot);
  const input = f.document.body.appendChild(
    f.document.createElement("textarea"),
  );
  input.focus();
  f.document.getSelection()!.removeAllRanges();
  f.document.dispatchEvent(
    new f.window.Event("selectionchange") as unknown as Event,
  );
  assert.equal(gesture.take()?.text, "ASTER-592");
  assert.equal(gesture.take(), null);
  select(f.document, node, 0, 9);
  const changed = selectionGesture(captureNoteSelection([f.view], f.document));
  node.parentElement!.dispatchEvent(
    new f.window.Event("pointerdown", { bubbles: true }) as unknown as Event,
  );
  f.document.getSelection()!.removeAllRanges();
  assert.equal(changed.take(), null);
  select(f.document, node, 0, 9);
  const edited = captureNoteSelection([f.view], f.document)!;
  f.view.file = { path: "Notes/B.md" };
  assert.equal(edited.valid(), false);
  f.view.file = { path: "Notes/A.md" };
  const reselection = selectionGesture(
    captureNoteSelection([f.view], f.document),
  );
  select(f.document, node, 10, 17);
  f.document.dispatchEvent(
    new f.window.Event("selectionchange") as unknown as Event,
  );
  assert.equal(reselection.take(), null);
});
test("explicit editor callback snapshots source label before async focus/file lookup changes without a whole-note fallback", () => {
  const f = fixture();
  const editor = {
    getSelection: () => "Exact excerpt",
    getCursor: (side: "from" | "to") =>
      side === "from" ? { line: 4, ch: 2 } : { line: 4, ch: 15 },
    getRange: () => "Exact excerpt",
  };
  const info = { file: { path: "Original.md" }, contentEl: f.root };
  const snapshot = captureEditorSelection(editor, info)!;
  assert.equal(snapshot.text, "Exact excerpt");
  assert.match(snapshot.label, /Original.md · L5/);
  info.file = { path: "Other.md" };
  assert.equal(snapshot.label, "Selection · Original.md · L5");
  assert.equal(snapshot.valid(), false);
  assert.equal(captureEditorSelection({ getSelection: () => "" }, info), null);
});
