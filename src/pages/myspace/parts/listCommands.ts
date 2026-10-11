import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";

/**
 * Быстрые списки в редакторе заметок:
 *  - выделить строки и нажать «-» (или «*», «+») — они становятся маркированным списком, «1» — нумерованным;
 *    повторное нажатие на уже оформленных строках снимает список;
 *  - Tab на выделенном тексте — превращает его в список, на пунктах списка — вложенность (Shift+Tab — обратно).
 */

const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])[ \t]+/;
const ORDERED = /^(\s*)\d{1,9}[.)][ \t]+/;
const BULLET = /^(\s*)[-*+][ \t]+/;

type Kind = "bullet" | "ordered";

/** Номера строк, которые затрагивает выделение (хвостовая строка, где выделение лишь начинается, не считается). */
function selectedLines(state: EditorState): number[] {
  const r = state.selection.main;
  const first = state.doc.lineAt(r.from).number;
  const tail = state.doc.lineAt(r.to);
  let last = tail.number;
  if (r.to > r.from && r.to === tail.from && last > first) last--;
  const out: number[] = [];
  for (let n = first; n <= last; n++) out.push(n);
  return out;
}

/** Выделение «настоящее»: несколько строк или одна строка целиком (частичное выделение слова не трогаем). */
export function isLineSelection(state: EditorState): boolean {
  const r = state.selection.main;
  if (r.empty) return false;
  const lines = selectedLines(state);
  if (lines.length > 1) return true;
  const line = state.doc.line(lines[0]);
  const lead = /^\s*/.exec(line.text)?.[0].length ?? 0;
  return r.from <= line.from + lead && r.to >= line.to;
}

/** Маркированный/нумерованный список из выделенных строк (или снятие, если все уже такие). */
export function toggleList(view: EditorView, kind: Kind): boolean {
  const { state } = view;
  const nums = selectedLines(state).filter((n) => state.doc.line(n).text.trim());
  if (!nums.length) return false;
  const same = (text: string): boolean => (kind === "bullet" ? BULLET.test(text) : ORDERED.test(text));
  const remove = nums.every((n) => same(state.doc.line(n).text));
  const changes: ChangeSpec[] = [];
  let counter = 1;
  for (const n of nums) {
    const line = state.doc.line(n);
    const m = ITEM.exec(line.text);
    const indent = /^\s*/.exec(line.text)?.[0] ?? "";
    const body = m ? line.text.slice(m[0].length) : line.text.slice(indent.length);
    const marker = remove ? "" : kind === "bullet" ? "- " : `${counter++}. `;
    changes.push({ from: line.from, to: line.to, insert: indent + marker + body });
  }
  const first = state.doc.line(nums[0]);
  const last = state.doc.line(nums[nums.length - 1]);
  const mapped = state.changes(changes);
  view.dispatch({
    changes,
    selection: EditorSelection.range(first.from, mapped.mapPos(last.to, 1)),
    userEvent: "input.type",
    scrollIntoView: true,
  });
  return true;
}

/** Tab: превратить выделенное в список; на пунктах списка — сдвинуть вглубь. */
export const tabCommand: Command = (view) => {
  const { state } = view;
  const nums = selectedLines(state);
  const texts = nums.map((n) => state.doc.line(n).text);
  const filled = texts.filter((t) => t.trim());
  const inList = filled.length > 0 && filled.every((t) => ITEM.test(t));
  if (!state.selection.main.empty && filled.length && !inList) return toggleList(view, "bullet");
  if (inList) {
    const changes = nums.map((n) => {
      const line = state.doc.line(n);
      return { from: line.from, insert: ORDERED.test(line.text) ? "   " : "  " };
    });
    view.dispatch({ changes, userEvent: "input.indent" });
    return true;
  }
  // Вне списка и без выделения — два пробела (таб-символ в начале строки в Markdown даёт блок кода).
  view.dispatch(state.replaceSelection("  "), { userEvent: "input.type" });
  return true;
};

/** Shift+Tab: убрать один уровень вложенности у выделенных строк. */
export const shiftTabCommand: Command = (view) => {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  for (const n of selectedLines(state)) {
    const line = state.doc.line(n);
    const m = /^( {1,3}|\t)/.exec(line.text);
    if (m) changes.push({ from: line.from, to: line.from + m[0].length });
  }
  if (!changes.length) return true;
  view.dispatch({ changes, userEvent: "delete.dedent" });
  return true;
};

/**
 * Ввод «-»/«*»/«+»/«1» поверх выделенных строк вместо замены текста — делаем из них список.
 * Подключается как EditorView.inputHandler.
 */
export const listInputHandler = (view: EditorView, from: number, to: number, text: string): boolean => {
  if (from === to || text.length !== 1) return false;
  const kind: Kind | null = text === "-" || text === "*" || text === "+" ? "bullet" : text === "1" ? "ordered" : null;
  if (!kind) return false;
  const sel = view.state.selection.main;
  if (sel.from !== from || sel.to !== to || !isLineSelection(view.state)) return false;
  return toggleList(view, kind);
};
