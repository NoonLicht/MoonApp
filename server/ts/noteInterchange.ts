/**
 * Обмен заметками с Obsidian, Notion и Anki.
 *
 * Хранилище приложения — обычные .md с [[викиссылками]] и frontmatter, поэтому
 * Obsidian-хранилище импортируется почти как есть. Notion экспортирует Markdown
 * с 32-значным хэшем в именах и обычными ссылками на %-закодированные пути —
 * они превращаются в [[викиссылки]]. Для Anki из заметок вытаскиваются карточки
 * «вопрос :: ответ» и пропуски {{c1::…}} (TSV для импорта в Anki).
 *
 * Модуль чистый: ни файловой системы, ни vault — только текст и пути, чтобы его
 * можно было проверить тестами. Запись в vault делает route.
 */

const NOTION_HASH = /\s[0-9a-f]{32}(?=\.|$)/i;

/** «Моя страница 1a2b…32hex.md» → «Моя страница.md» (каждый сегмент пути). */
export function stripNotionHash(p: string): string {
  return p
    .split("/")
    .map((seg) => seg.replace(NOTION_HASH, ""))
    .join("/");
}

/** Убирает символы, недопустимые в именах файлов Windows, и точки/пробелы по краям. */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned || "Без названия";
}

/** Нормализует путь внутри архива в безопасный относительный путь vault (без «..»). */
export function safeRelPath(p: string): string | null {
  const parts = p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  return parts.map(safeName).join("/") || null;
}

/** Ссылки Notion `[Текст](Папка/Страница%20abc….md)` → `[[Страница]]`; внешние не трогает. */
export function convertNotionLinks(md: string): string {
  return md.replace(/(?<!!)\[([^\]]*)\]\(([^)]+?\.md)\)/g, (_m, text: string, href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return _m;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      /* оставляем как есть */
    }
    const base = stripNotionHash(decoded.split("/").pop() ?? decoded).replace(/\.md$/i, "");
    return `[[${base}]]`;
  });
}

/** Obsidian: убирает комментарии %%…%% и сохраняет всё остальное. */
export function convertObsidian(md: string): string {
  return md.replace(/%%[\s\S]*?%%/g, "");
}

/** Заголовок страницы Notion дублируется первой строкой `# Название` — оставляем, это норма. */
export function convertNotion(md: string): string {
  return convertNotionLinks(md);
}

export type ImportSource = "obsidian" | "notion";

export interface ImportEntry {
  /** Путь внутри архива. */
  name: string;
  content: Buffer;
}

export interface ImportPlan {
  notes: { path: string; content: string }[];
  skipped: { path: string; reason: string }[];
}

/** Строит план записи: какие .md и под какими путями попадут в vault. */
export function planImport(entries: ImportEntry[], source: ImportSource, folder = ""): ImportPlan {
  const plan: ImportPlan = { notes: [], skipped: [] };
  const used = new Set<string>();
  const prefix = folder ? (safeRelPath(folder) ?? "") : "";
  for (const e of entries) {
    const raw = e.name.replace(/\\/g, "/");
    if (raw.endsWith("/")) continue;
    if (/(^|\/)(\.obsidian|\.trash|__MACOSX)\//.test(raw) || /(^|\/)\.[^/]*$/.test(raw)) {
      plan.skipped.push({ path: raw, reason: "service" });
      continue;
    }
    if (!/\.md$/i.test(raw)) {
      plan.skipped.push({ path: raw, reason: "not-markdown" });
      continue;
    }
    const cleaned = source === "notion" ? stripNotionHash(raw) : raw;
    const rel = safeRelPath(cleaned);
    if (!rel) {
      plan.skipped.push({ path: raw, reason: "unsafe-path" });
      continue;
    }
    // Одинаковые имена после удаления хэшей Notion не должны затирать друг друга.
    let target = prefix ? `${prefix}/${rel}` : rel;
    for (let n = 2; used.has(target.toLowerCase()); n++) {
      target = target.replace(/(\.md)?$/i, ` (${n})$1`).replace(/ \(\d+\)( \(\d+\))/, "$1");
    }
    used.add(target.toLowerCase());
    const text = e.content.toString("utf8").replace(/^\uFEFF/, "");
    plan.notes.push({
      path: target,
      content: source === "notion" ? convertNotion(text) : convertObsidian(text),
    });
  }
  return plan;
}

/* ------------------------------- Экспорт ------------------------------- */

/** Для Notion: [[Цель|Подпись]] → [Подпись](Цель.md); остальной Markdown не меняется. */
export function wikiLinksToMarkdown(md: string): string {
  return md.replace(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const name = target.trim();
    return `[${(alias ?? name).trim()}](${encodeURI(name)}.md)`;
  });
}

/* --------------------------------- Anki --------------------------------- */

export interface AnkiCard {
  front: string;
  back: string;
  tag: string;
}

/** Убирает блоки кода, чтобы `::` в коде не превращался в карточки. */
function withoutCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}

/** Карточки из строк вида «Вопрос :: Ответ» (в том числе в списках). */
export function extractBasicCards(md: string, tag = ""): AnkiCard[] {
  const cards: AnkiCard[] = [];
  for (const line of withoutCode(md).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(.+?)\s::\s(.+)$/);
    if (!m) continue;
    const front = m[1].trim();
    const back = m[2].trim();
    if (front && back) cards.push({ front, back, tag });
  }
  return cards;
}

/** Пропуски Anki `{{c1::слово}}` — строки целиком. */
export function extractClozes(md: string, tag = ""): { text: string; tag: string }[] {
  const out: { text: string; tag: string }[] = [];
  for (const line of withoutCode(md).split(/\r?\n/)) {
    if (/\{\{c\d+::.+?\}\}/.test(line)) {
      out.push({ text: line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim(), tag });
    }
  }
  return out;
}

const tsvCell = (s: string): string => s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
const tagOf = (p: string): string => p.replace(/\.md$/i, "").replace(/[\s/\\]+/g, "_");

export function ankiTsv(
  notes: { path: string; content: string }[],
  type: "basic" | "cloze",
): { tsv: string; count: number } {
  const rows: string[] = [];
  for (const n of notes) {
    const tag = tagOf(n.path);
    if (type === "basic") {
      for (const c of extractBasicCards(n.content, tag)) {
        rows.push([tsvCell(c.front), tsvCell(c.back), c.tag].join("\t"));
      }
    } else {
      for (const c of extractClozes(n.content, tag)) rows.push([tsvCell(c.text), c.tag].join("\t"));
    }
  }
  const header =
    type === "basic"
      ? "#separator:tab\n#html:true\n#tags column:3\n"
      : "#separator:tab\n#html:true\n#tags column:2\n";
  return { tsv: header + rows.join("\n") + (rows.length ? "\n" : ""), count: rows.length };
}
