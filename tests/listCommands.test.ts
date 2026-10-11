// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listInputHandler, shiftTabCommand, tabCommand } from "@/pages/myspace/parts/listCommands";
import { NOTE_FONTS, getNoteView, setNoteFont, zoomNote, SCALE_MAX } from "@/pages/myspace/parts/noteView";

const make = (doc: string, from: number, to: number): EditorView =>
  new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.range(from, to) }),
    parent: document.body,
  });

describe("списки через выделение", () => {
  it("«-» поверх выделенных строк делает маркированный список, повтор снимает", () => {
    const doc = "Один\nДва\nТри";
    const v = make(doc, 0, doc.length);
    expect(listInputHandler(v, 0, doc.length, "-")).toBe(true);
    expect(v.state.doc.toString()).toBe("- Один\n- Два\n- Три");
    const s = v.state.selection.main;
    expect(listInputHandler(v, s.from, s.to, "-")).toBe(true);
    expect(v.state.doc.toString()).toBe("Один\nДва\nТри");
    v.destroy();
  });

  it("«1» делает нумерованный список и заменяет старые маркеры", () => {
    const doc = "- a\n\nb\n* c";
    const v = make(doc, 0, doc.length);
    listInputHandler(v, 0, doc.length, "1");
    expect(v.state.doc.toString()).toBe("1. a\n\n2. b\n3. c");
    v.destroy();
  });

  it("часть слова внутри строки не трогаем, обычный ввод остаётся обычным", () => {
    const v = make("слово и ещё", 0, 5);
    expect(listInputHandler(v, 0, 5, "-")).toBe(false);
    expect(v.state.doc.toString()).toBe("слово и ещё");
    expect(listInputHandler(v, 0, 5, "x")).toBe(false);
    v.destroy();
  });

  it("Tab на выделенном тексте — список; на пунктах — вложенность; Shift+Tab — обратно", () => {
    const doc = "Первый\nВторой";
    const v = make(doc, 0, doc.length);
    tabCommand(v);
    expect(v.state.doc.toString()).toBe("- Первый\n- Второй");
    tabCommand(v);
    expect(v.state.doc.toString()).toBe("  - Первый\n  - Второй");
    shiftTabCommand(v);
    expect(v.state.doc.toString()).toBe("- Первый\n- Второй");
    v.destroy();
  });

  it("Tab без выделения вне списка вставляет отступ", () => {
    const v = make("текст", 5, 5);
    tabCommand(v);
    expect(v.state.doc.toString()).toBe("текст  ");
    v.destroy();
  });
});

describe("шрифт и масштаб заметок", () => {
  it("масштаб ограничен и сбрасывается, шрифт выбирается из списка", () => {
    zoomNote(0);
    expect(getNoteView().scale).toBe(1);
    zoomNote(1);
    expect(getNoteView().scale).toBe(1.1);
    for (let i = 0; i < 40; i++) zoomNote(1);
    expect(getNoteView().scale).toBe(SCALE_MAX);
    zoomNote(0);
    setNoteFont(NOTE_FONTS[2].id);
    expect(getNoteView().font).toBe("serif");
    setNoteFont("нет-такого");
    expect(NOTE_FONTS.some((f) => f.id === getNoteView().font)).toBe(true);
    setNoteFont("mono");
  });
});
