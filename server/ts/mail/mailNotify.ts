/**
 * Уведомления о новых письмах и значок непрочитанных (оверлей на панели задач Windows /
 * счётчик на macOS и Linux). Сервер крутится внутри процесса Electron, поэтому используем
 * его API напрямую; вне Electron (тесты, standalone) всё молча пропускается.
 */
import zlib from "zlib";
import { getSettings } from "./mailSettings";

interface ElectronLike {
  Notification?: {
    isSupported(): boolean;
    new (o: { title: string; body: string; silent?: boolean }): { show(): void; on(e: string, cb: () => void): void };
  };
  BrowserWindow?: {
    getAllWindows(): {
      setOverlayIcon?(img: unknown, description: string): void;
      show(): void;
      focus(): void;
      restore(): void;
      isMinimized(): boolean;
      webContents: { send(ch: string, ...a: unknown[]): void };
    }[];
  };
  app?: { setBadgeCount?(n: number): boolean; dock?: { setBadge(s: string): void } };
  nativeImage?: { createFromBuffer(b: Buffer): unknown; createEmpty(): unknown };
}

function electron(): ElectronLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const e = require("electron") as ElectronLike;
    return e && typeof e === "object" && e.app ? e : null;
  } catch {
    return null;
  }
}

/** 3×5-пиксельные цифры для значка. */
const FONT: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** PNG 32×32: красный круг с числом непрочитанных (до 99+). */
export function badgePng(count: number): Buffer {
  const S = 32;
  const px = Buffer.alloc(S * S * 4);
  const text = count > 99 ? "99+" : String(count);
  const scale = text.length >= 3 ? 3 : text.length === 2 ? 4 : 6;
  const w = text.length * 3 * scale + (text.length - 1) * scale;
  const h = 5 * scale;
  const ox = Math.floor((S - w) / 2);
  const oy = Math.floor((S - h) / 2);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      const inCircle = dx * dx + dy * dy <= 15.5 * 15.5;
      let white = false;
      if (inCircle && x >= ox && y >= oy && y < oy + h) {
        const rel = x - ox;
        const idx = Math.floor(rel / (4 * scale));
        const inGlyph = rel % (4 * scale) < 3 * scale;
        if (idx < text.length && inGlyph) {
          const gx = Math.floor((rel % (4 * scale)) / scale);
          const gy = Math.floor((y - oy) / scale);
          white = FONT[text[idx]]?.[gy]?.[gx] === "1";
        }
      }
      const i = (y * S + x) * 4;
      if (inCircle) {
        px[i] = white ? 255 : 220;
        px[i + 1] = white ? 255 : 38;
        px[i + 2] = white ? 255 : 38;
        px[i + 3] = 255;
      }
    }
  }
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let lastBadge = -1;

export function setBadge(count: number): void {
  if (count === lastBadge) return;
  lastBadge = count;
  const e = electron();
  if (!e) return;
  const on = getSettings().notify.badge;
  const n = on ? count : 0;
  try {
    e.app?.setBadgeCount?.(n);
    e.app?.dock?.setBadge(n ? String(n) : "");
    if (process.platform === "win32" && e.BrowserWindow && e.nativeImage) {
      const img = n > 0 ? e.nativeImage.createFromBuffer(badgePng(n)) : e.nativeImage.createEmpty();
      for (const w of e.BrowserWindow.getAllWindows()) w.setOverlayIcon?.(img, n > 0 ? `${n}` : "");
    }
  } catch {
    /* значок необязателен */
  }
}

function inQuiet(): boolean {
  const q = getSettings().notify;
  if (!q.quietEnabled) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(q.quietFrom);
  const b = toMin(q.quietTo);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

export interface NewMailInfo {
  account: string;
  accountLabel: string;
  from: string;
  subject: string;
  snippet: string;
  id: string;
}

export function notifyNew(items: NewMailInfo[]): void {
  const s = getSettings().notify;
  if (!s.enabled || !items.length || inQuiet()) return;
  const list = items.filter((i) => !s.muted.includes(i.account));
  if (!list.length) return;
  const e = electron();
  if (!e?.Notification || !e.Notification.isSupported()) return;
  try {
    const one = list.length === 1 ? list[0] : null;
    const NotificationCtor = e.Notification as unknown as new (o: {
      title: string;
      body: string;
      silent?: boolean;
    }) => { show(): void; on(ev: string, cb: () => void): void };
    const n = new NotificationCtor({
      title: one ? one.from || one.subject : `Новых писем: ${list.length}`,
      body: one
        ? s.preview
          ? `${one.subject}\n${one.snippet}`.trim().slice(0, 240)
          : one.accountLabel
        : list
            .slice(0, 4)
            .map((i) => `${i.from}: ${i.subject}`)
            .join("\n"),
      silent: !s.sound,
    });
    n.on("click", () => {
      const w = e.BrowserWindow?.getAllWindows()[0];
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      w.webContents.send("mail:open", one?.id ?? "");
    });
    n.show();
  } catch {
    /* уведомления недоступны */
  }
}
