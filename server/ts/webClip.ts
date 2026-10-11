/**
 * Веб-клиппер: расширение браузера открывает ссылку `moonapp://clip?...`,
 * ОС передаёт её приложению, здесь она превращается в заметку.
 *
 * Ссылка приходит из внешнего мира, поэтому всё жёстко ограничено: только
 * http/https-источник, управляющие символы вырезаются, длины ограничены, а
 * заметка всегда создаётся в отдельной папке «Веб-клипы» (существующие заметки
 * не затрагиваются).
 */

export const CLIP_DIR = "Веб-клипы";
const MAX_TITLE = 200;
const MAX_TEXT = 12_000;

export interface WebClip {
  title: string;
  url: string;
  text: string;
}

const strip = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

/** Разбор ссылки moonapp://clip?title=&url=&text=; null — не наш формат или чужой источник. */
export function parseClipUrl(raw: string): WebClip | null {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "moonapp:" || u.hostname.toLowerCase() !== "clip") return null;
  const url = u.searchParams.get("url") ?? "";
  try {
    const src = new URL(url);
    if (src.protocol !== "http:" && src.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const title = strip(u.searchParams.get("title") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const text = strip(u.searchParams.get("text") ?? "").trim().slice(0, MAX_TEXT);
  if (!title && !text) return null;
  return { title: title || url, url, text };
}

const fileSafe = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Клип";

/** Заметка из клипа: путь внутри хранилища и Markdown. */
export function buildNote(clip: WebClip, now = new Date(), exists: (p: string) => boolean = () => false): {
  path: string;
  content: string;
} {
  const day = now.toISOString().slice(0, 10);
  const base = `${CLIP_DIR}/${fileSafe(clip.title)}`;
  let path = `${base}.md`;
  for (let n = 2; exists(path); n++) path = `${base} ${n}.md`;
  const quote = clip.text
    ? clip.text
        .split(/\r?\n/)
        .map((l) => `> ${l}`)
        .join("\n")
    : "";
  const content = [
    `# ${clip.title.replace(/\n/g, " ")}`,
    "",
    `Источник: <${clip.url}>`,
    `Сохранено: ${day}`,
    quote ? `\n${quote}` : "",
    "",
  ].join("\n");
  return { path, content };
}
