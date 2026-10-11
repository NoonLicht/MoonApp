/**
 * Пункты контекстного меню Проводника Windows (только для текущего пользователя,
 * HKCU — права администратора не нужны):
 *
 *  - файл .txt/.md/.markdown → «MoonApp: добавить в заметки»;
 *  - папка → «MoonApp: сделать снимок папки».
 *
 * Пункт запускает приложение с аргументами `--moonapp-action=<действие> <путь>`;
 * уже работающий экземпляр получает их через second-instance (см. electron/main).
 *
 * Та же установка регистрирует протокол `moonapp://` (HKCU): через него расширение
 * браузера отправляет страницы в заметки (см. webClip.ts). Браузер перед открытием
 * протокола спрашивает подтверждение у пользователя.
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";

export type MenuAction = "add-note" | "folder-snapshot" | "web-clip";

export const ACTION_FLAG = "--moonapp-action=";
const NOTE_EXT = [".txt", ".md", ".markdown"];

interface RegEntry {
  key: string;
  label: string;
  command: string;
}

const quote = (s: string): string => `"${s.replace(/"/g, "")}"`;

/** Записи реестра: ключ shell-команды, подпись и команда запуска. */
export function regEntries(exePath: string, labels: { note: string; folder: string }): RegEntry[] {
  const exe = quote(exePath);
  const out: RegEntry[] = NOTE_EXT.map((ext) => ({
    key: `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\MoonAppAddNote`,
    label: labels.note,
    command: `${exe} ${ACTION_FLAG}add-note "%1"`,
  }));
  out.push({
    key: "HKCU\\Software\\Classes\\Directory\\shell\\MoonAppSnapshot",
    label: labels.folder,
    command: `${exe} ${ACTION_FLAG}folder-snapshot "%1"`,
  });
  return out;
}

/** Достаёт действие и путь из argv запуска; null — аргументов приложения нет. */
export function parseArgv(argv: string[]): { action: MenuAction; target: string } | null {
  const clip = argv.find((a) => /^moonapp:\/\/clip\?/i.test(a));
  if (clip) return { action: "web-clip", target: clip };
  const i = argv.findIndex((a) => a.startsWith(ACTION_FLAG));
  if (i < 0) return null;
  const action = argv[i].slice(ACTION_FLAG.length);
  const target = argv[i + 1];
  if ((action !== "add-note" && action !== "folder-snapshot") || !target) return null;
  return { action, target };
}

const reg = (args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    execFile("reg", args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || stderr || "") }),
    );
  });

/** Установлен ли пункт меню для папок (по нему судим обо всём наборе). */
export async function isInstalled(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const r = await reg(["query", "HKCU\\Software\\Classes\\Directory\\shell\\MoonAppSnapshot", "/ve"]);
  return r.ok;
}

export async function install(exePath: string, labels: { note: string; folder: string }): Promise<void> {
  if (process.platform !== "win32") throw new Error("windows_only");
  if (/^electron(\.exe)?$/i.test(path.basename(exePath))) throw new Error("dev_build");
  const proto = "HKCU\\Software\\Classes\\moonapp";
  const protoSteps: string[][] = [
    ["add", proto, "/ve", "/d", "URL:MoonApp Protocol", "/f"],
    ["add", proto, "/v", "URL Protocol", "/d", "", "/f"],
    ["add", `${proto}\\shell\\open\\command`, "/ve", "/d", `${quote(exePath)} "%1"`, "/f"],
  ];
  for (const s of protoSteps) {
    const r = await reg(s);
    if (!r.ok) throw new Error(r.out.trim() || "reg_failed");
  }
  for (const e of regEntries(exePath, labels)) {
    const steps: string[][] = [
      ["add", e.key, "/ve", "/d", e.label, "/f"],
      ["add", `${e.key}\\command`, "/ve", "/d", e.command, "/f"],
    ];
    for (const s of steps) {
      const r = await reg(s);
      if (!r.ok) throw new Error(r.out.trim() || "reg_failed");
    }
  }
}

export async function uninstall(): Promise<void> {
  if (process.platform !== "win32") throw new Error("windows_only");
  for (const e of regEntries("x", { note: "", folder: "" })) await reg(["delete", e.key, "/f"]);
  await reg(["delete", "HKCU\\Software\\Classes\\moonapp", "/f"]);
}

/* ------------------------------ Действия ------------------------------ */

const baseName = (p: string): string => path.basename(p).replace(/\.[^.]+$/, "") || "Заметка";

/** Заметка из текстового файла: возвращает путь созданной заметки в хранилище. */
export function addNoteFromFile(filePath: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vault = require("./myspace-vault") as typeof import("./myspace-vault");
  if (!NOTE_EXT.includes(path.extname(filePath).toLowerCase())) throw new Error("not_a_text_file");
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error("bad_file");
  const text = fs.readFileSync(filePath, "utf8");
  let rel = `Импорт/${baseName(filePath)}.md`;
  for (let n = 2; vault.readFile(rel); n++) rel = `Импорт/${baseName(filePath)} ${n}.md`;
  const r = vault.writeFile(rel, text);
  if (!r.ok) throw new Error(r.error || "write_failed");
  return rel;
}

export function snapshotFolder(folder: string): { id: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fv = require("./folderVersions") as typeof import("./folderVersions");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require("./config") as { DIRS: { storage: string } };
  return fv.snapshotFolder(path.join(config.DIRS.storage, "folder-versions"), folder, { label: "из меню Проводника" });
}

/** Заметка из веб-клипа (ссылка moonapp://clip?…): путь созданной заметки. */
export function addWebClip(link: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vault = require("./myspace-vault") as typeof import("./myspace-vault");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wc = require("./webClip") as typeof import("./webClip");
  const clip = wc.parseClipUrl(link);
  if (!clip) throw new Error("bad_clip");
  const note = wc.buildNote(clip, new Date(), (p) => !!vault.readFile(p));
  const r = vault.writeFile(note.path, note.content);
  if (!r.ok) throw new Error(r.error || "write_failed");
  return note.path;
}

export function runAction(action: MenuAction, target: string): { action: MenuAction; result: string } {
  if (action === "web-clip") return { action, result: addWebClip(target) };
  if (action === "add-note") return { action, result: addNoteFromFile(target) };
  return { action, result: snapshotFolder(target).id };
}
