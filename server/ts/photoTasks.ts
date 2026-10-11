/**
 * Конвейер «фото → текст → задачи/заметка/PDF». Используется и окном
 * приложения, и сканером телефона (компаньон): одна логика на оба входа.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "./config";
import * as ocr from "./ocr";
import * as vault from "./myspace-vault";
import * as vaultAssets from "./vaultAssets";
import * as pc from "./photoChecklist";
import { buildPdf, sniff } from "./scanPdf";

const { DIRS } = config;

export const scansDir = (): string => {
  const d = path.join(DIRS.storage, "scans");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const stamp = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export interface PhotoResult {
  imageUrl: string;
  text: string;
  confidence: number;
  checklist: pc.Checklist;
  note: string;
  tasks: number;
}

function tasksFile(): string {
  return path.join(DIRS.vault, "tasks.json");
}

function appendTasks(items: Record<string, unknown>[]): void {
  let all: unknown[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(tasksFile(), "utf8"));
    if (Array.isArray(raw)) all = raw;
  } catch {
    /* файла ещё нет */
  }
  fs.writeFileSync(tasksFile(), JSON.stringify([...all, ...items], null, 2), "utf8");
}

/** Фото → заметка с картинкой и чек-листом + задачи со ссылкой на кадр. */
export async function photoToTasks(
  image: Buffer,
  o: { name?: string; mime?: string; createTasks?: boolean } = {},
): Promise<PhotoResult> {
  if (!sniff(image) && !/^image\//.test(o.mime ?? "")) throw new Error("unsupported_image");
  const saved = vaultAssets.saveAsset(image, o.name ?? "photo.jpg", o.mime);
  const imageUrl = `/api/myspace/assets/${saved.id}`;
  const rec = await ocr.recognize(image);
  const list = pc.parseChecklist(rec.text);
  const when = stamp();
  const note = pc.noteName(list.title, when);
  const md = pc.checklistNote(list, { imageUrl, when });
  const w = vault.writeFile(note, md, { source: "photo", capturedAt: new Date().toISOString() });
  if (!w.ok) throw new Error(w.error || "write_failed");

  let tasks = 0;
  if (o.createTasks !== false && list.items.length) {
    const now = new Date().toISOString();
    const rows = list.items.map((it) => ({
      id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
      title: it.text,
      description: `Из фото: [[${note.replace(/\.md$/, "")}]]`,
      status: it.done ? "completed" : "todo",
      priority: it.important ? "high" : "medium",
      estimatedTime: 0,
      actualTime: 0,
      recurrence: "none",
      dueDate: null,
      reminderDateTime: null,
      checklist: [],
      attachments: [],
      urls: [imageUrl],
      tags: ["photo"],
      projectId: "",
      folder: "",
      location: "",
      dependencies: [],
      backlinks: [],
      created_at: now,
      updated_at: now,
    }));
    appendTasks(rows);
    tasks = rows.length;
  }
  return { imageUrl, text: rec.text, confidence: rec.confidence, checklist: list, note, tasks };
}

export interface ScanResult {
  file: string;
  pages: number;
  chars: number;
  note: string | null;
}

/** Страницы-снимки → PDF в storage/scans (+ распознанный текст заметкой по желанию). */
export async function scanToPdf(
  pages: { data: Buffer; mime: string }[],
  o: { title?: string; withText?: boolean } = {},
): Promise<ScanResult> {
  let text = "";
  if (o.withText !== false) {
    const parts: string[] = [];
    for (const p of pages) {
      try {
        parts.push((await ocr.recognize(p.data)).text.trim());
      } catch {
        /* страница без текста не должна ломать скан */
      }
    }
    text = parts.filter(Boolean).join("\n\n");
  }
  const title = (o.title || `Скан ${stamp()}`).trim();
  const pdf = await buildPdf(pages, { title, text });
  const file = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)} ${crypto.randomBytes(2).toString("hex")}.pdf`;
  fs.writeFileSync(path.join(scansDir(), file), pdf);
  let note: string | null = null;
  if (text.trim()) {
    note = `Сканы/${file.replace(/\.pdf$/i, "")}.md`;
    const r = vault.writeFile(note, `# ${title}\n\nPDF: ${file}\n\n${text}\n`, { source: "scan" });
    if (!r.ok) note = null;
  }
  return { file, pages: pages.length, chars: text.length, note };
}

export function listScans(): { name: string; size: number; at: number }[] {
  try {
    return fs
      .readdirSync(scansDir())
      .filter((n) => /\.pdf$/i.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(scansDir(), name));
        return { name, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}
