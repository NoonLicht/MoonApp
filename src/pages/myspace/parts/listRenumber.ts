import { EditorState, Transaction, type ChangeSpec, type Extension, type Text } from "@codemirror/state";

/**
 * Автонумерация нумерованных списков Markdown: удалили пункт из середины или вставили новый —
 * номера ниже (и вложенные списки) пересчитываются сами. Номер первого пункта списка не трогаем:
 * список может начинаться не с 1.
 */

const ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+)/;
const BULLET = /^([ \t]*)[-*+][ \t]+/;
const FENCE = /^\s*(```|~~~)/;

/** Ширина отступа строки (таб — как 4 пробела). */
function indentOf(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === "\t" ? 4 : 1;
  return n;
}

/** Строка относится к списку: пункт (нумерованный/маркированный) либо продолжение с отступом. */
function listish(text: string): boolean {
  return ORDERED.test(text) || BULLET.test(text) || /^(?: {2,}|\t)\S/.test(text);
}

/** Строки внутри ``` / ~~~ блока (по номеру строки, считая от начала документа). */
function fencedUntil(doc: Text, lineNo: number): boolean {
  let open = false;
  for (let i = 1; i < lineNo; i++) if (FENCE.test(doc.line(i).text)) open = !open;
  return open;
}

/**
 * Правки номеров для списков, затронутых строками [fromLine, toLine] (включительно).
 * Возвращает минимальные замены только самих цифр.
 */
export function renumberEdits(doc: Text, fromLine: number, toLine: number): ChangeSpec[] {
  const edits: ChangeSpec[] = [];
  const done = new Set<number>();
  const lo = Math.max(1, fromLine - 1);
  const hi = Math.min(doc.lines, toLine + 1);
  for (let ln = lo; ln <= hi; ln++) {
    if (done.has(ln) || !listish(doc.line(ln).text)) continue;
    // границы списка вокруг строки
    let a = ln;
    while (a > 1 && listish(doc.line(a - 1).text)) a--;
    let b = ln;
    while (b < doc.lines && listish(doc.line(b + 1).text)) b++;
    for (let i = a; i <= b; i++) done.add(i);
    if (fencedUntil(doc, a)) continue;
    const stack: { indent: number; next: number }[] = [];
    let inFence = false;
    for (let i = a; i <= b; i++) {
      const line = doc.line(i);
      if (FENCE.test(line.text)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const om = ORDERED.exec(line.text);
      if (om) {
        const ind = indentOf(om[1]);
        while (stack.length && stack[stack.length - 1].indent > ind) stack.pop();
        let top = stack[stack.length - 1];
        if (!top || top.indent < ind) {
          top = { indent: ind, next: Number(om[2]) };
          stack.push(top);
        }
        const want = top.next;
        top.next = want + 1;
        if (want !== Number(om[2])) {
          const from = line.from + om[1].length;
          edits.push({ from, to: from + om[2].length, insert: String(want) });
        }
        continue;
      }
      const bm = BULLET.exec(line.text);
      if (bm) {
        // маркированный пункт на том же уровне обрывает нумерованный список
        const ind = indentOf(bm[1]);
        while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
      }
    }
  }
  return edits;
}

/** Расширение CodeMirror: после правок пользователя пересчитывает номера затронутых списков. */
export const autoRenumberLists: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const ue = tr.annotation(Transaction.userEvent);
  // только ввод/удаление/перенос пользователя: внешние замены документа и undo/redo не трогаем
  if (!ue || !/^(input|delete|move)/.test(ue)) return tr;
  const doc = tr.newDoc;
  let from = Infinity;
  let to = 0;
  tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => {
    from = Math.min(from, doc.lineAt(Math.min(fb, doc.length)).number);
    to = Math.max(to, doc.lineAt(Math.min(tb, doc.length)).number);
  });
  if (!isFinite(from) || to - from > 2000) return tr;
  const edits = renumberEdits(doc, from, to);
  if (!edits.length) return tr;
  return [tr, { changes: edits, sequential: true }];
});
