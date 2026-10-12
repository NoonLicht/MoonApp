/**
 * Проверка целостности скачиваемых движков (yt-dlp, sing-box, ffmpeg).
 *
 * Два источника правды:
 *   1) опубликованные контрольные суммы релиза (yt-dlp: SHA2-256SUMS, ffmpeg: *.sha256) —
 *      для «latest»-артефактов, у которых версия плавает;
 *   2) lock-файл scripts/engines.lock.json — для артефактов с закреплённой версией
 *      (sing-box). Первая загрузка записывает хэш («доверие при первом использовании»),
 *      дальше любое расхождение — ошибка. ENGINES_STRICT=1 запрещает и дописывание.
 */
import crypto from "crypto";

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Разбор файла вида «<sha256>  <имя>» (формат sha256sum). Имя может начинаться с «*». */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

/** Файл вида «<sha256>» или «<sha256>  имя» — берём первый хэш. */
export function parseSingleSum(text: string): string | null {
  const m = /\b([0-9a-fA-F]{64})\b/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

export function assertSha256(label: string, data: Buffer, expected: string): void {
  const actual = sha256(data);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `${label}: контрольная сумма не совпала (ожидалось ${expected}, получено ${actual})`,
    );
  }
}

export type Lock = Record<string, string>;

export interface LockResult {
  /** Хэш записан впервые — lock-файл нужно сохранить. */
  added: boolean;
}

/** Сверка со lock-файлом. Бросает при расхождении или (strict) при отсутствии записи. */
export function checkLock(lock: Lock, key: string, data: Buffer, strict: boolean): LockResult {
  const actual = sha256(data);
  const known = lock[key];
  if (known) {
    if (known !== actual) {
      throw new Error(
        `${key}: хэш не совпал с engines.lock.json (ожидалось ${known}, получено ${actual})`,
      );
    }
    return { added: false };
  }
  if (strict) throw new Error(`${key}: нет записи в engines.lock.json (ENGINES_STRICT=1)`);
  lock[key] = actual;
  return { added: true };
}
