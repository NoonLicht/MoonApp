/**
 * Разбиение документов на переводимые куски. Чистые функции без модели — их
 * проверяют тесты. Идея везде одна: превратить документ в список «частей»,
 * где часть либо переводится (`tr: true`), либо переносится как есть
 * (разметка, тайминги, пробелы между абзацами). После перевода части склеиваются.
 */

export interface Part {
  text: string;
  /** true — переводим, false — копируем без изменений. */
  tr: boolean;
}

const HAS_LETTER = /\p{L}/u;
export const hasLetters = (s: string): boolean => HAS_LETTER.test(s);

/** Предел длины одного куска, символов: ~400–600 токенов, далеко от окна 1024. */
export const MAX_CHARS = 1400;

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** Абзац длиннее предела: режем по границам предложений, жадно набирая до MAX_CHARS. */
function splitParagraph(p: string, max: number): string[] {
  if (p.length <= max) return [p];
  const sentences = p.split(/(?<=[.!?…。！？]["')\]»”]?)\s+/u);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (cur) out.push(cur);
      cur = "";
      out.push(...hardSplit(s, max));
      continue;
    }
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Обычный текст: абзацы переводятся, пустые строки между ними сохраняются. */
export function splitPlain(text: string, max = MAX_CHARS): Part[] {
  const parts: Part[] = [];
  const pieces = text.split(/(\n[ \t]*\n+)/);
  for (const piece of pieces) {
    if (/^\n[ \t]*\n+$/.test(piece) || !hasLetters(piece)) {
      if (piece) parts.push({ text: piece, tr: false });
      continue;
    }
    // Пробелы по краям абзаца не отдаём модели, но возвращаем на место.
    const lead = /^\s*/.exec(piece)?.[0] ?? "";
    const trail = /\s*$/.exec(piece.slice(lead.length))?.[0] ?? "";
    const core = piece.slice(lead.length, piece.length - trail.length);
    if (lead) parts.push({ text: lead, tr: false });
    const chunks = splitParagraph(core, max);
    chunks.forEach((c, i) => {
      parts.push({ text: c, tr: true });
      if (i < chunks.length - 1) parts.push({ text: " ", tr: false });
    });
    if (trail) parts.push({ text: trail, tr: false });
  }
  return parts;
}

/** Строки с их терминаторами: конкатенация результата точно равна исходнику. */
const linesKeep = (text: string): string[] => text.split(/(?<=\n)/);

/** Markdown: блоки кода (``` / ~~~) и их содержимое не переводятся. */
export function splitMarkdown(text: string, max = MAX_CHARS): Part[] {
  const parts: Part[] = [];
  let buf = "";
  let fence: string | null = null;
  const flush = (): void => {
    if (buf) parts.push(...splitPlain(buf, max));
    buf = "";
  };
  for (const line of linesKeep(text)) {
    const m = /^s*(```|~~~)/.exec(line);
    if (fence === null && m) {
      flush();
      fence = m[1];
      parts.push({ text: line, tr: false });
    } else if (fence !== null) {
      parts.push({ text: line, tr: false });
      if (m && m[1] === fence) fence = null;
    } else buf += line;
  }
  flush();
  return parts;
}

/** Субтитры SRT/VTT: номера и тайминги остаются, переводится только текст реплик. */
export function splitSubtitles(text: string): Part[] {
  const parts: Part[] = [];
  let cue = "";
  const flush = (): void => {
    if (!cue) return;
    const lead = /^\s*/.exec(cue)?.[0] ?? "";
    const trail = /\s*$/.exec(cue.slice(lead.length))?.[0] ?? "";
    const core = cue.slice(lead.length, cue.length - trail.length);
    if (lead) parts.push({ text: lead, tr: false });
    if (core) parts.push({ text: core, tr: hasLetters(core) });
    if (trail) parts.push({ text: trail, tr: false });
    cue = "";
  };
  for (const line of linesKeep(text)) {
    const t = line.trim();
    const meta =
      t === "" ||
      /^\d+$/.test(t) ||
      /-->/.test(t) ||
      /^WEBVTT/.test(t) ||
      /^(NOTE|STYLE|REGION)/.test(t);
    if (meta) {
      flush();
      parts.push({ text: line, tr: false });
    } else cue += line;
  }
  flush();
  return parts;
}

/** HTML/XHTML: переводятся только текстовые узлы вне script/style/тегов. */
export function splitHtml(html: string, max = MAX_CHARS): Part[] {
  const parts: Part[] = [];
  const tokens = html.split(
    /(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]+>)/i,
  );
  for (const t of tokens) {
    if (!t) continue;
    if (t.startsWith("<") || !hasLetters(t)) {
      parts.push({ text: t, tr: false });
      continue;
    }
    const lead = /^\s*/.exec(t)?.[0] ?? "";
    const trail = /\s*$/.exec(t.slice(lead.length))?.[0] ?? "";
    const core = t.slice(lead.length, t.length - trail.length);
    if (lead) parts.push({ text: lead, tr: false });
    const chunks = splitParagraph(core.replace(/\s+/g, " "), max);
    chunks.forEach((c, i) => {
      parts.push({ text: c, tr: true });
      if (i < chunks.length - 1) parts.push({ text: " ", tr: false });
    });
    if (trail) parts.push({ text: trail, tr: false });
  }
  return parts;
}

export const xmlUnescape = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface DocxPara {
  /** Весь исходный XML абзаца. */
  xml: string;
  text: string;
}

/** Абзацы DOCX-части: текст — склейка всех w:t. */
export function docxParagraphs(xml: string): DocxPara[] {
  const out: DocxPara[] = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const text = [...m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((r) => xmlUnescape(r[1]))
      .join("");
    out.push({ xml: m[0], text });
  }
  return out;
}

/** Подставляет перевод в первый w:t абзаца, остальные очищает (форматирование абзаца сохраняется). */
export function docxReplace(paraXml: string, translated: string): string {
  let first = true;
  return paraXml.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_m, attrs: string | undefined) => {
    if (first) {
      first = false;
      const a = attrs && /xml:space/.test(attrs) ? attrs : ` xml:space="preserve"${attrs ?? ""}`;
      return `<w:t${a}>${xmlEscape(translated)}</w:t>`;
    }
    return `<w:t${attrs ?? ""}></w:t>`;
  });
}

export const joinParts = (parts: Part[], translated: Map<number, string>): string =>
  parts.map((p, i) => (p.tr ? (translated.get(i) ?? p.text) : p.text)).join("");
