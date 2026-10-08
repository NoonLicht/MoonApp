/**
 * Формулы в заметках как в Obsidian: `$…$` в строке и `$$…$$` блоком, LaTeX рисуется KaTeX.
 * Правила разбора повторяют Obsidian: после открывающего `$` и перед закрывающим нет пробела,
 * за закрывающим нет цифры (чтобы «$5 и $10» не стало формулой), `\$` — просто доллар.
 */
import katex from "katex";
import "katex/dist/katex.min.css";

/** TeX → HTML. Ошибка разбора не роняет заметку: формула показывается красным исходником. */
export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode: display,
      throwOnError: false,
      errorColor: "#e5484d",
      strict: "ignore",
      trust: false,
      output: "html",
    });
  } catch {
    const esc = tex.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<span class="katex-error" style="color:#e5484d">${esc}</span>`;
  }
}

export interface MathRange {
  from: number;
  to: number;
  tex: string;
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** Формулы `$…$` внутри одной строки; индексы — в этой строке. */
export function findInlineMath(text: string): MathRange[] {
  const out: MathRange[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c !== "$") {
      i++;
      continue;
    }
    if (text[i + 1] === "$") {
      // «$$…$$» в середине строки — формула-блок, которую рисует редактор отдельно.
      const end = text.indexOf("$$", i + 2);
      i = end < 0 ? i + 2 : end + 2;
      continue;
    }
    if (isSpace(text[i + 1])) {
      i++;
      continue;
    }
    let j = i + 1;
    let found = -1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === "$") {
        if (!isSpace(text[j - 1]) && !/\d/.test(text[j + 1] ?? "")) found = j;
        break;
      }
      j++;
    }
    if (found < 0) {
      i++;
      continue;
    }
    out.push({ from: i, to: found + 1, tex: text.slice(i + 1, found) });
    i = found + 1;
  }
  return out;
}

export interface MathBlock {
  /** Первая и последняя строки блока (0-based индексы в массиве lines). */
  start: number;
  end: number;
  tex: string;
}

/**
 * Блок `$$ … $$`: открывающие `$$` в начале строки; закрывающие — в этой же или одной из
 * следующих строк. Остальное содержимое строк с `$$` (текст до/после) не допускается.
 */
export function findMathBlock(lines: string[], at: number): MathBlock | null {
  const first = lines[at].trim();
  if (!first.startsWith("$$")) return null;
  const rest = first.slice(2);
  const sameLine = rest.indexOf("$$");
  if (sameLine >= 0) {
    if (rest.slice(sameLine + 2).trim()) return null;
    const tex = rest.slice(0, sameLine);
    return tex.trim() ? { start: at, end: at, tex } : null;
  }
  const body: string[] = [rest];
  for (let k = at + 1; k < lines.length && k < at + 200; k++) {
    const t = lines[k];
    const close = t.indexOf("$$");
    if (close >= 0) {
      if (t.slice(close + 2).trim()) return null;
      body.push(t.slice(0, close));
      const tex = body.join("\n");
      return tex.trim() ? { start: at, end: k, tex } : null;
    }
    body.push(t);
  }
  return null;
}
