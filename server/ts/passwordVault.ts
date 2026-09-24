/**
 * Менеджер паролей: отдельное хранилище storage/password-vault.json,
 * не путать с server/ts/security.ts (там — ключи API-провайдеров).
 * Каждая запись — произвольный логин/пароль/заметка пользователя,
 * пароль шифруется теми же примитивами (safeStorage/AES-256-GCM), что и
 * секреты провайдеров — переиспользуем encryptSecret/decryptSecret.
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";
import { encryptSecret, decryptSecret } from "./security";

const { FILES } = config;

export interface PasswordEntryPublic {
  id: string;
  title: string;
  username: string;
  url: string;
  notes: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PasswordEntryFull extends PasswordEntryPublic {
  password: string;
}

interface StoredEntry extends PasswordEntryPublic {
  passwordEnc: string;
}

function readAll(): StoredEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.passwordVault, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(entries: StoredEntry[]): void {
  fs.writeFileSync(FILES.passwordVault, JSON.stringify(entries, null, 2), "utf8");
}

/** Список без паролей — для отображения таблицы. */
export function list(): PasswordEntryPublic[] {
  return readAll().map(({ passwordEnc, ...rest }) => rest);
}

/** Одна запись с расшифрованным паролем — только по явному запросу (кнопка "показать"/"копировать"). */
export function reveal(id: string): PasswordEntryFull | null {
  const e = readAll().find((x) => x.id === id);
  if (!e) return null;
  try {
    const { passwordEnc, ...rest } = e;
    return { ...rest, password: decryptSecret(passwordEnc) };
  } catch (err) {
    logger.error("passwordVault.reveal_failed", { id, error: (err as Error).message });
    return null;
  }
}

export function create(input: {
  title: string;
  username?: string;
  password: string;
  url?: string;
  notes?: string;
  tags?: string[];
}): PasswordEntryPublic {
  const now = Date.now();
  const entry: StoredEntry = {
    id: crypto.randomUUID(),
    title: String(input.title || "").trim() || "Без названия",
    username: String(input.username || ""),
    url: String(input.url || ""),
    notes: String(input.notes || ""),
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    createdAt: now,
    updatedAt: now,
    passwordEnc: encryptSecret(String(input.password || "")),
  };
  const all = readAll();
  all.push(entry);
  writeAll(all);
  logger.info("passwordVault.create", { id: entry.id });
  const { passwordEnc, ...pub } = entry;
  return pub;
}

export function update(
  id: string,
  input: Partial<{
    title: string;
    username: string;
    password: string;
    url: string;
    notes: string;
    tags: string[];
  }>,
): PasswordEntryPublic | null {
  const all = readAll();
  const idx = all.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const cur = all[idx];
  const next: StoredEntry = {
    ...cur,
    title: input.title !== undefined ? String(input.title) : cur.title,
    username: input.username !== undefined ? String(input.username) : cur.username,
    url: input.url !== undefined ? String(input.url) : cur.url,
    notes: input.notes !== undefined ? String(input.notes) : cur.notes,
    tags: input.tags !== undefined ? input.tags.map(String) : cur.tags,
    passwordEnc: input.password !== undefined ? encryptSecret(input.password) : cur.passwordEnc,
    updatedAt: Date.now(),
  };
  all[idx] = next;
  writeAll(all);
  logger.info("passwordVault.update", { id });
  const { passwordEnc, ...pub } = next;
  return pub;
}

export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  logger.info("passwordVault.remove", { id });
  return true;
}

/** Криптографически случайный пароль (не Math.random). */
export function generatePassword(opts: {
  length?: number;
  digits?: boolean;
  symbols?: boolean;
  upper?: boolean;
}): string {
  const length = Math.min(128, Math.max(4, opts.length || 20));
  let charset = "abcdefghijklmnopqrstuvwxyz";
  if (opts.upper !== false) charset += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (opts.digits !== false) charset += "0123456789";
  if (opts.symbols) charset += "!@#$%^&*()-_=+[]{}";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += charset[bytes[i] % charset.length];
  return out;
}
