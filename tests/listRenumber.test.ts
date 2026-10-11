import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { autoRenumberLists, renumberEdits } from "@/pages/myspace/parts/listRenumber";

const apply = (doc: string, make: (s: EditorState) => Parameters<EditorState["update"]>[0]): string => {
  const s = EditorState.create({ doc, extensions: [autoRenumberLists] });
  return s.update(make(s)).state.doc.toString();
};

describe("автонумерация списков", () => {
  it("удаление пункта из середины сдвигает номера ниже", () => {
    const doc = "1. один\n2. два\n3. три\n4. четыре";
    const out = apply(doc, () => ({
      changes: { from: 8, to: 15 }, // убрали «2. два\n»
      userEvent: "delete.selection",
    }));
    expect(out).toBe("1. один\n2. три\n3. четыре");
  });

  it("новый пункт в середине сдвигает следующие", () => {
    const doc = "1. один\n2. два\n3. три";
    const out = apply(doc, () => ({
      changes: { from: 8, insert: "2. новый\n" },
      userEvent: "input.type",
    }));
    expect(out).toBe("1. один\n2. новый\n3. два\n4. три");
  });

  it("не трогает документ при внешней замене (без userEvent) и undo", () => {
    const doc = "1. a\n5. b";
    expect(apply(doc, () => ({ changes: { from: 0, insert: "x" } }))).toBe("x1. a\n5. b");
    expect(apply(doc, () => ({ changes: { from: 0, insert: "x" }, userEvent: "undo" }))).toBe("x1. a\n5. b");
  });

  it("вложенные списки нумеруются независимо, маркированные пункты не ломаются", () => {
    const edits = renumberEdits(
      EditorState.create({ doc: "1. a\n   1. x\n   3. y\n2. b\n- m\n- n" }).doc,
      1,
      6,
    );
    const text = "1. a\n   1. x\n   3. y\n2. b\n- m\n- n";
    // единственная правка — «3.» → «2.» во вложенном списке
    expect(edits).toHaveLength(1);
    const e = edits[0] as { from: number; to: number; insert: string };
    expect(text.slice(e.from, e.to)).toBe("3");
    expect(e.insert).toBe("2");
  });

  it("не переписывает номера внутри блока кода и сохраняет стартовый номер", () => {
    const doc = "```\n1. a\n3. b\n```\n\n5. старт\n7. дальше";
    const out = apply(doc, () => ({ changes: { from: doc.length, insert: "!" }, userEvent: "input.type" }));
    expect(out).toBe("```\n1. a\n3. b\n```\n\n5. старт\n6. дальше!");
  });
});
