import { useEffect, useState } from "react";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";

export interface FnInfo {
  name: string;
  category: string;
  signature: string;
  description: string;
}

let CACHE: FnInfo[] | null = null;
let LOADING: Promise<FnInfo[]> | null = null;

/** Все функции листа (имя, категория, подпись, описание): грузятся один раз. */
export function useFunctions(docs: SheetDocs): FnInfo[] {
  const [list, setList] = useState<FnInfo[]>(CACHE ?? []);
  const id = docs.activeId;
  useEffect(() => {
    if (CACHE || !id) return;
    LOADING ??= (docs.run("formulas.functions", {}, true) as Promise<FnInfo[] | undefined>).then((r) => {
      CACHE = Array.isArray(r) ? r : [];
      return CACHE;
    });
    let alive = true;
    void LOADING.then((r) => alive && setList(r));
    return () => {
      alive = false;
    };
    // docs.run зависит от активной книги; список функций один на всё приложение
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return list;
}

/**
 * Что вводится в формуле: имя функции под курсором (для подсказки), номер аргумента и
 * недописанное слово (для автодополнения).
 */
export function formulaContext(
  text: string,
  caret: number,
): { word: string; wordStart: number; fn: string | null; arg: number } {
  const before = text.slice(0, caret);
  const m = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before);
  const word = m ? m[0] : "";
  const wordStart = caret - word.length;
  // Внутренняя незакрытая скобка и запятые после неё.
  let depth = 0;
  let inStr = false;
  const stack: { name: string; arg: number }[] = [];
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "(") {
      const nm = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(before.slice(0, i));
      stack.push({ name: nm ? nm[1] : "", arg: 0 });
      depth++;
    } else if (ch === ")") {
      stack.pop();
      depth--;
    } else if ((ch === "," || ch === ";") && stack.length) stack[stack.length - 1].arg++;
  }
  void depth;
  const top = stack[stack.length - 1];
  return { word, wordStart, fn: top?.name ? top.name.toUpperCase() : null, arg: top?.arg ?? 0 };
}

/** Цвета для разных ссылок в формуле (как в Excel). */
export const REF_COLORS = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#9E480E", "#997300"];

const REF_RE = /(?<![A-Za-z0-9_.!'])(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?(?![A-Za-z0-9_(])/g;

/** Ссылки на ячейки в тексте формулы: позиция, текст. */
export function findRefs(text: string): { start: number; end: number; text: string }[] {
  if (!text.startsWith("=")) return [];
  const out: { start: number; end: number; text: string }[] = [];
  let inStr = false;
  let seg = "";
  let segStart = 0;
  const flush = (): void => {
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(seg))) out.push({ start: segStart + m.index, end: segStart + m.index + m[0].length, text: m[0] });
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (!inStr) flush();
      inStr = !inStr;
      seg = "";
      segStart = i + 1;
      continue;
    }
    if (!inStr) seg += text[i];
  }
  flush();
  return out;
}
