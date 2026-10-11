/**
 * Контекст для ИИ-чата из файла, папки или сайта (чистая логика).
 *
 *  - isPublicUrl: можно ли загружать адрес (только http/https, не локальные
 *    и не частные сети — чтобы вкладка чата не стала способом обходить сеть);
 *  - pickPassages: из текстов выбираются отрывки, ближе всего к вопросу;
 *  - buildContext: итоговый блок с источниками, укладывающийся в лимит символов.
 */
import { tokenize, stem } from "./hybridRank";

export interface SourceDoc {
  title: string;
  text: string;
}

export interface Passage {
  title: string;
  text: string;
  score: number;
}

/** Адрес можно загружать: http(s) и не локальный/частный хост. */
export function isPublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return false;
  if (h.includes(":")) {
    // IPv6: loopback, unique-local, link-local, mapped IPv4
    return !(h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:"));
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

/** Режет текст на абзацы-отрывки по ~maxLen символов. */
export function splitPassages(text: string, maxLen = 700): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}|\r\n\r\n/)) {
    let p = para.replace(/\s+/g, " ").trim();
    while (p.length > maxLen) {
      let cut = p.lastIndexOf(". ", maxLen);
      if (cut < maxLen / 2) cut = p.lastIndexOf(" ", maxLen);
      if (cut <= 0) cut = maxLen;
      out.push(p.slice(0, cut + 1).trim());
      p = p.slice(cut + 1).trim();
    }
    if (p.length >= 20) out.push(p);
  }
  return out;
}

/** Отрывки с наибольшим пересечением со словами вопроса; без вопроса — начало документов. */
export function pickPassages(docs: SourceDoc[], question: string, limit = 8): Passage[] {
  const q = new Set(tokenize(question).filter((t) => t.length > 2).map(stem));
  const all: Passage[] = [];
  for (const d of docs) {
    splitPassages(d.text).forEach((text, i) => {
      let score = 0;
      if (q.size) {
        const seen = new Set(tokenize(text).map(stem));
        for (const w of q) if (seen.has(w)) score++;
        score /= q.size;
      } else score = 1 / (1 + i);
      all.push({ title: d.title, text, score });
    });
  }
  return all
    .filter((p) => !q.size || p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Блок контекста: нумерованные источники, не длиннее maxChars. */
export function buildContext(passages: Passage[], maxChars = 6000): string {
  const lines: string[] = [];
  let used = 0;
  for (const p of passages) {
    const line = `[${p.title}] ${p.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length
    ? `Используй следующие материалы пользователя как контекст (источник указан в скобках):\n\n${lines.join("\n\n")}`
    : "";
}
