import type { Doc, Frame, Group } from "@/pages/myspace/m3e/lib/tokens";
import { isProject } from "@/pages/myspace/m3e/lib/project";

/** Документ страницы как он хранится на сервере: пустая строка — страница ещё не открывалась. */
export type StoredDoc = Partial<Doc> | null;

export function parseDoc(text: string): StoredDoc {
  if (!text.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Partial<Doc>) : null;
  } catch {
    return null;
  }
}

/** Содержимое файла проекта .json → текст документа, либо null, если это не проект. */
export function projectText(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isProject(v) ? JSON.stringify(v) : null;
  } catch {
    return null;
  }
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** Чистая страница: один пустой экран телефона. */
export function blankDoc(homeName: string): string {
  const frame: Frame = { id: uid(), name: homeName, x: 0, y: 0 };
  const doc: Partial<Doc> = {
    groups: [] as Group[],
    frames: [frame],
    paletteKey: "purple",
    frame: "phone",
    title: "",
    brief: "",
  };
  return JSON.stringify(doc);
}

/** «5 мин назад» и подобное, строками из словаря. */
export function relativeTime(
  at: number,
  now: number,
  t: (key: string, p?: Record<string, unknown>) => string,
): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t("myspace.m3e.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return t("myspace.m3e.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("myspace.m3e.hoursAgo", { n: h });
  return t("myspace.m3e.daysAgo", { n: Math.round(h / 24) });
}

/** Скачать текст как файл проекта. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Имя файла проекта по названию страницы. */
export function fileNameFor(title: string): string {
  const clean = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? `m3e-canvas ${clean}.json` : "m3e-canvas.json";
}
