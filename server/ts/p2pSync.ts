/**
 * P2P-синхронизация заметок между двумя устройствами в одной сети.
 * Здесь — чистая логика: подписи запросов, шифрование, безопасные пути и план
 * синхронизации по манифестам. Сеть и файлы — в p2pServer.ts.
 *
 * Защита: общий парный ключ (32 байта, показывается пользователю при включении);
 * каждый запрос подписан HMAC-SHA256 с временной меткой (окно 60 с), тела и
 * ответы зашифрованы AES-256-GCM ключом, производным от парного. Без ключа
 * сервер ничего не отдаёт и не принимает.
 */
import crypto from "crypto";

export interface FileMeta {
  /** Путь внутри хранилища, всегда с «/». */
  path: string;
  mtime: number;
  size: number;
  hash: string;
}

export const SIG_WINDOW_MS = 60_000;

/* ---------------------------------- Ключ ---------------------------------- */

export const newPairingKey = (): string => crypto.randomBytes(32).toString("hex");

const aesKey = (secret: string): Buffer => crypto.createHash("sha256").update(`moonapp-p2p-aes:${secret}`).digest();
const macKey = (secret: string): Buffer => crypto.createHash("sha256").update(`moonapp-p2p-mac:${secret}`).digest();

/* -------------------------------- Подписи -------------------------------- */

export const sha256 = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");

export function sign(secret: string, method: string, url: string, ts: number, body: Buffer | string = ""): string {
  return crypto
    .createHmac("sha256", macKey(secret))
    .update(`${method.toUpperCase()}\n${url}\n${ts}\n${sha256(body)}`)
    .digest("hex");
}

export function verify(
  secret: string,
  method: string,
  url: string,
  ts: number,
  body: Buffer | string,
  sig: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIG_WINDOW_MS) return false;
  const expect = Buffer.from(sign(secret, method, url, ts, body), "hex");
  let got: Buffer;
  try {
    got = Buffer.from(String(sig), "hex");
  } catch {
    return false;
  }
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

/* ------------------------------ Шифрование ------------------------------ */

/** iv(12) | tag(16) | шифртекст. */
export function seal(secret: string, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(secret), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function open(secret: string, sealed: Buffer): Buffer {
  if (sealed.length < 28) throw new Error("bad_payload");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", aesKey(secret), sealed.subarray(0, 12));
    d.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
  } catch {
    throw new Error("bad_payload");
  }
}

/* ----------------------------- Безопасные пути ----------------------------- */

/** Путь заметки: только .md, без «..», абсолютных и скрытых служебных частей. */
export function safeRelPath(p: unknown): string | null {
  const s = String(p ?? "").replace(/\\/g, "/");
  if (!s || s.startsWith("/") || /^[a-z]:/i.test(s) || s.length > 400) return null;
  const parts = s.split("/");
  if (parts.some((x) => !x || x === "." || x === ".." || x.startsWith(".") || /[\u0000-\u001f<>:"|?*]/.test(x)))
    return null;
  if (!/\.md$/i.test(s)) return null;
  return parts.join("/");
}

/** Имя копии при конфликте: «Заметка (конфликт 2026-03-05).md». */
export function conflictPath(rel: string, day: string, exists: (p: string) => boolean = () => false): string {
  const base = rel.replace(/\.md$/i, "");
  let out = `${base} (конфликт ${day}).md`;
  for (let n = 2; exists(out); n++) out = `${base} (конфликт ${day}) ${n}.md`;
  return out;
}

/* ------------------------------ План синхронизации ------------------------------ */

export interface SyncPlan {
  /** Забрать с удалённого устройства. */
  pull: string[];
  /** Отправить на удалённое устройство. */
  push: string[];
  /** Различаются у обоих: победитель — более свежая версия, проигравшая сохраняется копией. */
  conflicts: { path: string; winner: "local" | "remote" }[];
  same: number;
}

export function planSync(local: FileMeta[], remote: FileMeta[]): SyncPlan {
  const l = new Map(local.map((f) => [f.path, f]));
  const r = new Map(remote.map((f) => [f.path, f]));
  const plan: SyncPlan = { pull: [], push: [], conflicts: [], same: 0 };
  for (const [p, lf] of l) {
    const rf = r.get(p);
    if (!rf) plan.push.push(p);
    else if (rf.hash === lf.hash) plan.same++;
    else plan.conflicts.push({ path: p, winner: lf.mtime > rf.mtime ? "local" : "remote" });
  }
  for (const p of r.keys()) if (!l.has(p)) plan.pull.push(p);
  const byPath = (a: string, b: string): number => a.localeCompare(b);
  plan.pull.sort(byPath);
  plan.push.sort(byPath);
  plan.conflicts.sort((a, b) => byPath(a.path, b.path));
  return plan;
}
