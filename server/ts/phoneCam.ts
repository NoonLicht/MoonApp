/**
 * Телефон как веб-камера: кадры JPEG приходят с телефона (страница компаньона,
 * getUserMedia по HTTPS), здесь хранится последний кадр и считается скорость.
 * Дальше кадры раздаются как MJPEG-поток (для OBS «Источник — браузер»,
 * Zoom через OBS Virtual Camera и т. п.) и как отдельные снимки.
 *
 * Только память: на диск попадает лишь явно сохранённый снимок.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "./config";

const { DIRS } = config;

/** Максимальный размер одного кадра (телефон шлёт 20–150 КБ). */
export const MAX_FRAME = 2 * 1024 * 1024;
/** Если кадров нет дольше этого времени — камера считается выключенной. */
export const ACTIVE_MS = 3000;

export interface CamInfo {
  active: boolean;
  device: string;
  fps: number;
  width: number;
  height: number;
  frames: number;
  lastAt: number;
  kbPerFrame: number;
}

interface Frame {
  jpeg: Buffer;
  at: number;
  w: number;
  h: number;
}

let current: Frame | null = null;
let device = "";
let frames = 0;
const recent: number[] = []; // времена последних кадров, мс
const listeners = new Set<(jpeg: Buffer) => void>();

/** Размеры JPEG из SOF-маркера; null, если это не JPEG. */
export function jpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const size = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + size;
  }
  return null;
}

/** Принять кадр. Бросает "bad_frame", если это не JPEG, и "too_big" при превышении размера. */
export function pushFrame(jpeg: Buffer, deviceName: string, now = Date.now()): void {
  if (jpeg.length > MAX_FRAME) throw new Error("too_big");
  const size = jpegSize(jpeg);
  if (!size) throw new Error("bad_frame");
  current = { jpeg, at: now, w: size.w, h: size.h };
  device = deviceName.slice(0, 60);
  frames++;
  recent.push(now);
  while (recent.length > 60 || (recent.length && now - recent[0] > 5000)) recent.shift();
  listeners.forEach((fn) => {
    try {
      fn(jpeg);
    } catch {
      /* слушатель отвалился — остальным кадр всё равно нужен */
    }
  });
}

export function latest(): { jpeg: Buffer; at: number } | null {
  return current ? { jpeg: current.jpeg, at: current.at } : null;
}

export function info(now = Date.now()): CamInfo {
  const f = current;
  const active = !!f && now - f.at < ACTIVE_MS;
  let fps = 0;
  if (active && recent.length > 1) {
    const span = (recent[recent.length - 1] - recent[0]) / 1000;
    fps = span > 0 ? Math.round(((recent.length - 1) / span) * 10) / 10 : 0;
  }
  return {
    active,
    device: active ? device : "",
    fps,
    width: f?.w ?? 0,
    height: f?.h ?? 0,
    frames,
    lastAt: f?.at ?? 0,
    kbPerFrame: f ? Math.round(f.jpeg.length / 1024) : 0,
  };
}

export function subscribe(fn: (jpeg: Buffer) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Сбросить состояние (камера остановлена или приложение выключило компаньон). */
export function reset(): void {
  current = null;
  device = "";
  recent.length = 0;
}

/* ------------------------- ключ для потока MJPEG ------------------------- */

const keyFile = (): string => {
  const dir = path.join(DIRS.storage, "companion");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "cam-key.txt");
};

/** Секрет в адресе потока: адрес вставляют в OBS, где заголовков нет. */
export function streamKey(): string {
  try {
    const k = fs.readFileSync(keyFile(), "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(k)) return k;
  } catch {
    /* ключа ещё нет */
  }
  return regenerateKey();
}

export function regenerateKey(): string {
  const k = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(keyFile(), k, { encoding: "utf8", mode: 0o600 });
  return k;
}

export function keyMatches(given: unknown): boolean {
  if (typeof given !== "string" || given.length !== 32) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(streamKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------ снимок ------------------------------ */

export function photosDir(): string {
  const d = path.join(DIRS.storage, "companion", "camera");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Сохраняет последний кадр в storage/companion/camera. Возвращает имя файла. */
export function saveSnapshot(now = new Date()): string | null {
  if (!current) return null;
  const p = (n: number): string => String(n).padStart(2, "0");
  const name = `cam-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.jpg`;
  fs.writeFileSync(path.join(photosDir(), name), current.jpeg);
  return name;
}

/** Заголовок части multipart для MJPEG. */
export const BOUNDARY = "moonappframe";
export function mjpegPart(jpeg: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
    jpeg,
    Buffer.from("\r\n"),
  ]);
}
