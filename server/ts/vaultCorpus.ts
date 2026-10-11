/**
 * Общий сбор текстов из хранилища для аналитических фишек: заметки (.md) с
 * датами, закладки, лекции, реплики пользователя в чатах. Только чтение.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import { stmts } from "./db";
import * as bookmarks from "./bookmarks";

export interface CorpusDoc {
  source: "note" | "bookmark" | "lecture" | "chat";
  ref: string;
  title: string;
  text: string;
  /** Создание (или изменение, если дату создания узнать нельзя), мс. */
  at: number;
  /** Последнее изменение, мс. */
  updatedAt: number;
}

const MAX_FILES = 3000;
const MAX_CHARS = 20_000;

/** Заметки из vault; скрытые папки (.history и т. п.) пропускаются. */
export function collectNotes(root = config.DIRS.vaultNotes, maxChars = MAX_CHARS): CorpusDoc[] {
  const out: CorpusDoc[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, r);
      else if (/\.md$/i.test(e.name)) {
        try {
          const st = fs.statSync(full);
          out.push({
            source: "note",
            ref: r,
            title: e.name.replace(/\.md$/i, ""),
            text: fs.readFileSync(full, "utf8").slice(0, maxChars),
            at: st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs,
            updatedAt: st.mtimeMs,
          });
        } catch {
          /* файл исчез между обходом и чтением */
        }
      }
    }
  };
  walk(root, "");
  return out;
}

export function collectBookmarks(): CorpusDoc[] {
  try {
    return bookmarks.list().map((b) => ({
      source: "bookmark" as const,
      ref: b.url,
      title: b.title,
      text: `${b.title}\n${(b as { notes?: string }).notes ?? ""}`,
      at: b.createdAt,
      updatedAt: b.createdAt,
    }));
  } catch {
    return [];
  }
}

export function collectLectures(): CorpusDoc[] {
  const out: CorpusDoc[] = [];
  try {
    for (const l of stmts.lectureAll.all() as unknown as {
      id: number;
      title: string;
      started_at: string;
      notes: string;
    }[]) {
      const at = Date.parse(String(l.started_at));
      if (!Number.isFinite(at)) continue;
      const chunks = stmts.chunkFor.all(l.id) as unknown as { text: string }[];
      const text = `${l.title}\n${l.notes ?? ""}\n${chunks.map((c) => c.text).join(" ")}`.slice(0, MAX_CHARS);
      out.push({ source: "lecture", ref: String(l.id), title: l.title, text, at, updatedAt: at });
    }
  } catch {
    /* лекций нет */
  }
  return out;
}

/** Реплики пользователя в чатах, по диалогам. */
export function collectChats(): CorpusDoc[] {
  const out: CorpusDoc[] = [];
  try {
    const convs = new Map<number, { title: string; texts: string[]; first: number; last: number }>();
    const titles = new Map<number, string>();
    for (const c of stmts.convAll.all() as unknown as { id: number; title: string }[])
      titles.set(c.id, c.title);
    for (const c of titles.keys()) {
      for (const m of stmts.msgFor.all(c) as unknown as { role: string; text: string; created_at: string }[]) {
        if (m.role !== "user") continue;
        const at = Date.parse(String(m.created_at));
        const cur = convs.get(c) ?? { title: titles.get(c) ?? "", texts: [], first: Infinity, last: 0 };
        cur.texts.push(String(m.text ?? ""));
        if (Number.isFinite(at)) {
          cur.first = Math.min(cur.first, at);
          cur.last = Math.max(cur.last, at);
        }
        convs.set(c, cur);
      }
    }
    for (const [id, c] of convs) {
      if (!Number.isFinite(c.first)) continue;
      out.push({
        source: "chat",
        ref: String(id),
        title: c.title,
        text: c.texts.join("\n").slice(0, MAX_CHARS),
        at: c.first,
        updatedAt: c.last,
      });
    }
  } catch {
    /* чатов нет */
  }
  return out;
}

export function collectAll(): CorpusDoc[] {
  return [...collectNotes(), ...collectBookmarks(), ...collectLectures(), ...collectChats()];
}
