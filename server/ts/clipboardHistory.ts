/**
 * История буфера обмена (текст). Логика — чистые функции над списком записей;
 * хранение — один JSON в каталоге storage (не входит в резервные копии).
 *
 * Приватность: функция выключена по умолчанию; в историю не попадает то, что
 * похоже на секрет (номер карты, длинный токен/ключ, приватный ключ, строка
 * без пробелов вида пароля). Закреплённые записи не удаляются автоматически,
 * остальные живут TTL_DAYS дней и не более MAX_ITEMS штук.
 */
import fs from "fs";
import path from "path";
import { luhn } from "./secretFinder";

export interface ClipEntry {
  id: string;
  text: string;
  at: number;
  pinned: boolean;
}

export const MAX_ITEMS = 100;
export const TTL_DAYS = 7;
export const MAX_CHARS = 20_000;

/** Похоже ли содержимое на секрет, который нельзя запоминать. */
export function looksSensitive(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return true;
  const digits = s.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return true;
  if (/\b(?:sk|pk|ghp|gho|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{16,}/.test(s)) return true;
  // одно «слово» без пробелов, 20+ символов, буквы+цифры (+спецсимволы) — токен/пароль
  if (!/\s/.test(s) && s.length >= 20 && s.length <= 200 && /[A-Za-z]/.test(s) && /\d/.test(s) && !/^https?:\/\//i.test(s))
    return true;
  return false;
}

/** Добавляет текст в историю; дубликаты поднимаются наверх, лишнее вытесняется. */
export function addEntry(
  list: ClipEntry[],
  text: string,
  now = Date.now(),
): { list: ClipEntry[]; added: boolean } {
  const t = String(text ?? "");
  if (!t.trim() || t.length > MAX_CHARS || looksSensitive(t)) return { list, added: false };
  const prev = list.find((e) => e.text === t);
  const rest = list.filter((e) => e.text !== t);
  const entry: ClipEntry = prev
    ? { ...prev, at: now }
    : { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t, at: now, pinned: false };
  return { list: prune([entry, ...rest], now), added: !prev };
}

/** Убирает просроченные открепленные записи и обрезает до MAX_ITEMS (закреплённые сохраняются). */
export function prune(list: ClipEntry[], now = Date.now()): ClipEntry[] {
  const ttl = TTL_DAYS * 86_400_000;
  const alive = list.filter((e) => e.pinned || now - e.at <= ttl);
  const out: ClipEntry[] = [];
  let free = MAX_ITEMS - alive.filter((e) => e.pinned).length;
  for (const e of alive) {
    if (e.pinned) out.push(e);
    else if (free > 0) {
      out.push(e);
      free--;
    }
  }
  return out;
}

export function search(list: ClipEntry[], q: string): ClipEntry[] {
  const needle = q.trim().toLowerCase();
  const items = needle ? list.filter((e) => e.text.toLowerCase().includes(needle)) : list;
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at);
}

export function setPinned(list: ClipEntry[], id: string, pinned: boolean): ClipEntry[] {
  return list.map((e) => (e.id === id ? { ...e, pinned } : e));
}

export function remove(list: ClipEntry[], id: string): ClipEntry[] {
  return list.filter((e) => e.id !== id);
}

/* -------------------------------- Хранение -------------------------------- */

let cache: ClipEntry[] | null = null;

function file(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "clipboard-history.json");
}

export function load(): ClipEntry[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    cache = Array.isArray(raw)
      ? raw.filter((e) => e && typeof e.text === "string" && typeof e.id === "string")
      : [];
  } catch {
    cache = [];
  }
  return cache!;
}

export function save(list: ClipEntry[]): void {
  cache = list;
  try {
    fs.writeFileSync(file(), JSON.stringify(list), "utf8");
  } catch {
    /* история — удобство, а не данные: потеря записи не критична */
  }
}

/** Запись из наблюдателя буфера: возвращает true, если текст добавлен. */
export function push(text: string): boolean {
  const r = addEntry(load(), text);
  if (r.list !== load()) save(r.list);
  return r.added;
}

export function clearUnpinned(): void {
  save(load().filter((e) => e.pinned));
}
