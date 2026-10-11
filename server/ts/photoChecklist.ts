/**
 * Живой чек-лист из физического мира: текст, распознанный (OCR) с фото доски
 * или тетради, превращается в список задач. Разбор отделён от распознавания:
 * принимает строки и отдаёт пункты с признаками «сделано» и «важно».
 *
 * Тетрадный/доскинный OCR шумный, поэтому строки-мусор (мало букв, много
 * знаков) отбрасываются, а пользователь потом может поправить список.
 */

export interface ChecklistItem {
  text: string;
  done: boolean;
  important: boolean;
}

export interface Checklist {
  title: string;
  items: ChecklistItem[];
  /** Сколько строк отброшено как шум. */
  dropped: number;
}

const BOX_OPEN = /^\s*(?:[-*•·▪◦○□☐]|\[\s?\]|\(\s?\)|\d{1,2}[.)])\s*/;
const BOX_DONE = /^\s*(?:\[[xXхХ✓✔vV]\]|\([xXхХ✓✔]\)|[☑✓✔✅])\s*/;

/** Доля букв в строке: ниже порога — это шум OCR (рамки, линии, помарки). */
function letterRatio(s: string): number {
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  return s.length ? letters / s.length : 0;
}

export function cleanLine(line: string): string {
  return line
    .replace(/[|\\_~]{1,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseChecklist(ocrText: string, o: { maxItems?: number } = {}): Checklist {
  const raw = String(ocrText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items: ChecklistItem[] = [];
  let title = "";
  let dropped = 0;

  for (const original of raw) {
    let line = original;
    let done = false;
    let marked = false;
    if (BOX_DONE.test(line)) {
      done = true;
      marked = true;
      line = line.replace(BOX_DONE, "");
    } else if (BOX_OPEN.test(line)) {
      marked = true;
      line = line.replace(BOX_OPEN, "");
    }
    line = cleanLine(line);
    const important = /!{1,}\s*$|^!{1,}\s*|\bважно\b|\burgent\b/i.test(line);
    line = line.replace(/!+\s*$/, "").replace(/^!+\s*/, "").trim();

    if (line.length < 3 || letterRatio(line) < 0.5) {
      dropped++;
      continue;
    }
    // Первая строка без маркера, короткая и без точки — заголовок списка.
    if (!title && !marked && items.length === 0 && line.length <= 60 && !/[.;]$/.test(line)) {
      title = line.replace(/[:：]\s*$/, "");
      continue;
    }
    items.push({ text: line.charAt(0).toUpperCase() + line.slice(1), done, important });
    if (items.length >= (o.maxItems ?? 60)) break;
  }
  return { title, items, dropped };
}

/** Заметка Markdown: картинка-источник и чек-лист. */
export function checklistNote(c: Checklist, p: { imageUrl: string; when: string }): string {
  const head = c.title || p.when;
  const lines = c.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}${i.important ? " ❗" : ""}`);
  return `# ${head}\n\n![Фото](${p.imageUrl})\n\n${lines.join("\n")}\n\n_Распознано с фото ${p.when}._\n`;
}

/** Безопасное имя заметки из заголовка и даты. */
export function noteName(title: string, when: string): string {
  const base = (title || "Из фото").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
  return `Из фото/${base} ${when.replace(/[: ]/g, "-")}.md`;
}
