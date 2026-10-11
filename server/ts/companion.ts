/**
 * Веб-компаньон: доступ к заметкам, задачам, «входящим» и плееру с телефона по
 * локальной сети.
 *
 * БЕЗОПАСНОСТЬ — главное требование. Основной API приложения (запуск файлов,
 * пароли, установка ПО, ключи) слушает только 127.0.0.1 и в сеть не выходит.
 * Компаньон — ОТДЕЛЬНЫЙ маленький сервер с белым списком маршрутов, который:
 *  - выключен по умолчанию и слушает порт только пока включён в настройках;
 *  - принимает запросы лишь из частных сетей (RFC 1918, link-local, loopback) —
 *    проброс порта на роутере не поможет;
 *  - сверяет заголовок Host с IP-адресом (защита от DNS rebinding);
 *  - требует токен устройства во всех маршрутах, кроме страницы и сопряжения;
 *  - выдаёт токен только по одноразовому 6-значному коду, который показывает само
 *    приложение (код живёт 5 минут, перебор ограничен по IP и в целом);
 *  - хранит только SHA-256 токенов; устройство можно отозвать в один клик;
 *  - никогда не отдаёт менеджер паролей, настройки, ключи и файловую систему.
 *
 * Токен передаётся заголовком Authorization (не cookie), поэтому CSRF-атака с чужой
 * страницы невозможна: браузер не подставит заголовок сам.
 */
import crypto from "crypto";
import express from "express";
import fs from "fs";
import type http from "http";
import os from "os";
import path from "path";
import multer from "multer";
import config from "./config";
import logger from "./logger";
import { APP_JS, INDEX_HTML, STYLE_CSS } from "./companionPage";
import * as photoTasks from "./photoTasks";

import type { CompanionStatus, PlayerCommand, PlayerState } from "./contracts/companion";

export type { CompanionStatus, PlayerCommand, PlayerState };

const { DIRS, FILES } = config;

export const DEFAULT_PORT = 4717;
export const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** Расширения, которые не принимаем даже во «входящие»: их легко запустить по ошибке. */
const BLOCKED_EXT = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe", "js", "jse", "wsf", "lnk",
  "jar", "dll", "reg", "hta", "cpl", "msc", "pif", "sh", "appx", "msix",
]);

/* ------------------------------ чистые проверки ----------------------------- */

/** ::ffff:192.168.1.5 → 192.168.1.5 */
export function normalizeIp(ip: string | undefined): string {
  return String(ip || "").replace(/^::ffff:/i, "");
}

/** Адрес из частной сети, link-local или loopback. Публичные адреса — нет. */
export function isPrivateAddress(raw: string | undefined): boolean {
  const ip = normalizeIp(raw);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const l = ip.toLowerCase();
  return l === "::1" || /^f[cd][0-9a-f]{2}:/.test(l) || /^fe[89ab][0-9a-f]:/.test(l);
}

/**
 * Host должен быть IP-литералом или localhost. Домен (в том числе тот, что
 * атакующий направил на ваш частный адрес — DNS rebinding) отвергается.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  const h = String(hostHeader || "").trim().toLowerCase();
  if (!h) return false;
  const name = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.replace(/:\d+$/, "");
  return name === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^[0-9a-f:]+$/.test(name);
}

/** Безопасное имя файла для «входящих»: без путей, управляющих символов и опасных расширений. */
export function safeFileName(original: string): { name: string; blocked: boolean } {
  let base = path.basename(String(original || "").replace(/\\/g, "/"));
  base = base
    .normalize("NFC")
     
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  if (!base) base = "file";
  const ext = path.extname(base).slice(1).toLowerCase();
  return { name: base, blocked: BLOCKED_EXT.has(ext) };
}

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** Сравнение хэшей за постоянное время. */
function hashEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* --------------------------------- состояние -------------------------------- */

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
}

interface Persisted {
  enabled: boolean;
  port: number;
  devices: Device[];
}

function readState(): Persisted {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.companion, "utf8"));
    return {
      enabled: !!raw.enabled,
      port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT,
      devices: Array.isArray(raw.devices) ? raw.devices : [],
    };
  } catch {
    return { enabled: false, port: DEFAULT_PORT, devices: [] };
  }
}
function writeState(s: Persisted): void {
  fs.writeFileSync(FILES.companion, JSON.stringify(s, null, 2), "utf8");
}

/* -------------------------------- сопряжение -------------------------------- */

interface Pairing {
  code: string;
  expiresAt: number;
  failures: number;
}
let pairing: Pairing | null = null;
const ipFailures = new Map<string, { count: number; resetAt: number }>();
const MAX_IP_FAILURES = 5;
const MAX_CODE_FAILURES = 10;

/** Новый одноразовый код (старый перестаёт действовать). */
export function newPairingCode(now = Date.now()): { code: string; expiresAt: number } {
  pairing = {
    code: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"),
    expiresAt: now + PAIRING_TTL_MS,
    failures: 0,
  };
  return { code: pairing.code, expiresAt: pairing.expiresAt };
}

export function currentPairing(now = Date.now()): { code: string; expiresAt: number } | null {
  if (!pairing || pairing.expiresAt <= now) return null;
  return { code: pairing.code, expiresAt: pairing.expiresAt };
}

export class PairError extends Error {
  constructor(
    public status: number,
    code: string,
  ) {
    super(code);
  }
}

/**
 * Обмен кода на токен устройства. Ошибки намеренно однотипны (403 bad_code), чтобы
 * не подсказывать, истёк код или неверен; перебор режется по IP и по самому коду.
 */
export function pair(code: unknown, name: unknown, ip: string, now = Date.now()): { token: string; device: Device } {
  const fl = ipFailures.get(ip);
  if (fl && fl.resetAt > now && fl.count >= MAX_IP_FAILURES) throw new PairError(429, "too_many_attempts");
  const fail = (): never => {
    const cur = ipFailures.get(ip);
    ipFailures.set(
      ip,
      cur && cur.resetAt > now ? { count: cur.count + 1, resetAt: cur.resetAt } : { count: 1, resetAt: now + 60_000 },
    );
    if (pairing && ++pairing.failures >= MAX_CODE_FAILURES) pairing = null; // код сгорает
    throw new PairError(403, "bad_code");
  };
  if (!pairing || pairing.expiresAt <= now) return fail();
  const given = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given) || !hashEquals(sha256(given), sha256(pairing.code))) return fail();

  const token = crypto.randomBytes(32).toString("hex");
  const device: Device = {
    id: crypto.randomUUID(),
    name: String(name || "").trim().slice(0, 40) || "Device",
    tokenHash: sha256(token),
    createdAt: now,
    lastSeen: now,
  };
  const st = readState();
  st.devices.push(device);
  writeState(st);
  pairing = null; // одноразовый
  ipFailures.delete(ip);
  logger.info("companion.paired", { id: device.id, name: device.name });
  return { token, device };
}

/** Устройство по токену из заголовка; null — токен неизвестен. */
export function authenticate(token: string | undefined, now = Date.now()): Device | null {
  if (!token || token.length < 32 || token.length > 200) return null;
  const h = sha256(token);
  const st = readState();
  let found: Device | null = null;
  // Проходим по ВСЕМ устройствам без раннего выхода — время ответа не зависит от позиции.
  for (const d of st.devices) if (hashEquals(d.tokenHash, h)) found = d;
  if (found && now - found.lastSeen > 60_000) {
    found.lastSeen = now;
    writeState(st);
  }
  return found;
}

export function revokeDevice(id: string): boolean {
  const st = readState();
  const n = st.devices.length;
  st.devices = st.devices.filter((d) => d.id !== id);
  if (st.devices.length === n) return false;
  writeState(st);
  logger.info("companion.revoked", { id });
  return true;
}

/* ---------------------------------- плеер ---------------------------------- */

const CMDS = new Set(["play", "pause", "toggle", "seek", "volume", "mute"]);
let playerState: PlayerState | null = null;
let queue: PlayerCommand[] = [];
let cmdSeq = 0;

export function setPlayerState(s: Partial<PlayerState> | null, now = Date.now()): void {
  playerState = s
    ? {
        title: String(s.title ?? "").slice(0, 200),
        paused: !!s.paused,
        position: Number(s.position) || 0,
        duration: Number(s.duration) || 0,
        volume: Math.max(0, Math.min(1, Number(s.volume ?? 1))),
        muted: !!s.muted,
        at: now,
      }
    : null;
}
/** Состояние старше 10 с считается устаревшим: плеер на ПК закрыт. */
export function getPlayerState(now = Date.now()): PlayerState | null {
  return playerState && now - playerState.at < 10_000 ? playerState : null;
}
export function enqueueCommand(cmd: unknown, value?: unknown): PlayerCommand {
  if (typeof cmd !== "string" || !CMDS.has(cmd)) throw new Error("bad_command");
  const v = Number(value);
  const c: PlayerCommand = {
    id: ++cmdSeq,
    cmd: cmd as PlayerCommand["cmd"],
    value: Number.isFinite(v) ? Math.max(-3600, Math.min(3600, v)) : undefined,
  };
  queue.push(c);
  if (queue.length > 50) queue = queue.slice(-50);
  return c;
}
export function takeCommands(): PlayerCommand[] {
  const out = queue;
  queue = [];
  return out;
}

/* ---------------------------- данные приложения ---------------------------- */

interface TaskRow {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  [k: string]: unknown;
}
const tasksFile = (): string => path.join(DIRS.vault, "tasks.json");
function readTasks(): TaskRow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(tasksFile(), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
const writeTasks = (t: TaskRow[]): void => fs.writeFileSync(tasksFile(), JSON.stringify(t, null, 2), "utf8");

export const inboxDir = (): string => {
  const d = path.join(DIRS.storage, "companion", "inbox");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export function listInbox(): { name: string; size: number; at: number }[] {
  return fs
    .readdirSync(inboxDir())
    .map((name) => {
      const st = fs.statSync(path.join(inboxDir(), name));
      return { name, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

/* ------------------------------- HTTP-сервер -------------------------------- */

const bearer = (req: express.Request): string | undefined => {
  const h = req.get("authorization") || "";
  return /^Bearer /i.test(h) ? h.slice(7).trim() : undefined;
};

export function createCompanionApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // 1) Только частные сети и только IP-литерал в Host.
  app.use((req, res, next) => {
    if (!isPrivateAddress(req.socket.remoteAddress) || !isAllowedHost(req.get("host"))) {
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    next();
  });

  // 2) Статика страницы.
  app.get("/", (_req, res) => res.type("html").send(INDEX_HTML));
  app.get("/app.js", (_req, res) => res.type("application/javascript").send(APP_JS));
  app.get("/style.css", (_req, res) => res.type("text/css").send(STYLE_CSS));

  const api = express.Router();
  api.use(express.json({ limit: "100kb" }));

  api.post("/pair", (req, res) => {
    try {
      const r = pair(req.body?.code, req.body?.name, normalizeIp(req.socket.remoteAddress));
      res.json({ token: r.token, name: r.device.name });
    } catch (e) {
      const pe = e as PairError;
      res.status(pe.status || 400).json({ error: pe.message });
    }
  });

  // 3) Всё остальное — только с токеном устройства.
  api.use((req, res, next) => {
    const dev = authenticate(bearer(req));
    if (!dev) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    (req as express.Request & { device?: Device }).device = dev;
    next();
  });

  api.get("/me", (req, res) => res.json({ name: (req as express.Request & { device?: Device }).device?.name }));

  /* заметки */
  api.get("/notes", (req, res) => {
     
    const { stmts } = require("./db") as typeof import("./db");
    const q = String(req.query.q || "").trim();
    const rows = (q ? stmts.noteSearch.all(q) : stmts.noteAll.all()) as unknown as {
      id: number; title: string; content: string; updated_at: string; folder: string;
    }[];
    res.json(
      rows
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 200)
        .map((n) => ({ id: n.id, title: n.title, folder: n.folder, updated_at: n.updated_at, preview: String(n.content).slice(0, 140) })),
    );
  });
  api.get("/notes/:id", (req, res) => {
     
    const { stmts } = require("./db") as typeof import("./db");
    const n = stmts.noteGet.get(Number(req.params.id)) as unknown as { id: number; title: string; content: string } | undefined;
    if (!n) return res.status(404).json({ error: "not_found" });
    res.json({ id: n.id, title: n.title, content: n.content });
  });
  api.post("/notes/:id/append", (req, res) => {
     
    const { stmts } = require("./db") as typeof import("./db");
    const id = Number(req.params.id);
    const text = String(req.body?.text ?? "").slice(0, 20000);
    const n = stmts.noteGet.get(id) as unknown as { title: string; content: string; tags: string; folder: string } | undefined;
    if (!n) return res.status(404).json({ error: "not_found" });
    if (!text.trim()) return res.status(400).json({ error: "empty" });
    stmts.noteUpdate.run(n.title, `${n.content.replace(/\s+$/, "")}\n\n${text}`, n.tags, n.folder, id);
    res.json({ ok: true });
  });
  api.post("/notes", (req, res) => {
     
    const { stmts } = require("./db") as typeof import("./db");
    const title = String(req.body?.title ?? "").trim().slice(0, 120);
    const content = String(req.body?.content ?? "").slice(0, 50000);
    if (!title && !content.trim()) return res.status(400).json({ error: "empty" });
    const r = stmts.noteInsert.run(title || content.slice(0, 40), content, "", "") as unknown as { lastInsertRowid?: number; id?: number };
    res.status(201).json({ ok: true, id: r.lastInsertRowid ?? r.id });
  });

  /* задачи */
  api.get("/tasks", (_req, res) => {
    res.json(
      readTasks()
        .slice(-300)
        .reverse()
        .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate })),
    );
  });
  api.post("/tasks", (req, res) => {
    const title = String(req.body?.title ?? "").trim().slice(0, 300);
    if (!title) return res.status(400).json({ error: "empty" });
    const now = new Date().toISOString();
    const task = {
      id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
      title, description: "", status: "todo", priority: "medium", estimatedTime: 0, actualTime: 0,
      recurrence: "none", dueDate: null, reminderDateTime: null, checklist: [], attachments: [], urls: [],
      tags: ["phone"], projectId: "", folder: "", location: "", dependencies: [], backlinks: [],
      created_at: now, updated_at: now,
    };
    const all = readTasks();
    all.push(task);
    writeTasks(all);
    res.status(201).json({ id: task.id });
  });
  api.post("/tasks/:id/toggle", (req, res) => {
    const all = readTasks();
    const t = all.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "not_found" });
    t.status = t.status === "completed" ? "todo" : "completed";
    t.updated_at = new Date().toISOString();
    writeTasks(all);
    res.json({ id: t.id, status: t.status });
  });

  /* входящие: текст/ссылка и файлы */
  api.post("/inbox/text", (req, res) => {
     
    const { stmts } = require("./db") as typeof import("./db");
    const text = String(req.body?.text ?? "").trim().slice(0, 20000);
    if (!text) return res.status(400).json({ error: "empty" });
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    stmts.noteInsert.run(`Inbox ${stamp}`, text, "inbox", "Inbox");
    res.status(201).json({ ok: true });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, inboxDir()),
      filename: (_req, file, cb) => {
        const { name } = safeFileName(Buffer.from(file.originalname, "latin1").toString("utf8"));
        cb(null, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const { blocked } = safeFileName(Buffer.from(file.originalname, "latin1").toString("utf8"));
      if (blocked) return cb(new Error("blocked_type"));
      cb(null, true);
    },
  });
  api.post("/inbox/file", (req, res) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const m = (err as Error).message;
        return res.status(m === "blocked_type" ? 415 : 400).json({ error: m === "blocked_type" ? m : "upload_failed" });
      }
      if (!req.file) return res.status(400).json({ error: "no_file" });
      logger.info("companion.file", { name: req.file.filename, size: req.file.size });
      res.status(201).json({ ok: true, name: req.file.filename });
    });
  });

  /* сканер документов: телефон снимает, ПК распознаёт и собирает PDF */
  const scanUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  });
  api.post("/scan/pdf", scanUpload.array("files", 20), async (req, res) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) return res.status(400).json({ error: "no_file" });
      const r = await photoTasks.scanToPdf(
        files.map((f) => ({ data: f.buffer, mime: f.mimetype })),
        { title: String(req.body?.title ?? "") },
      );
      logger.info("companion.scan_pdf", { pages: r.pages });
      res.status(201).json({ ok: true, file: r.file, pages: r.pages });
    } catch (e) {
      const m = (e as Error).message;
      res.status(m === "unsupported_image" ? 415 : 500).json({ error: m });
    }
  });
  api.post("/scan/tasks", scanUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "no_file" });
      const r = await photoTasks.photoToTasks(req.file.buffer, { name: req.file.originalname, mime: req.file.mimetype });
      logger.info("companion.scan_tasks", { tasks: r.tasks });
      res.status(201).json({ ok: true, tasks: r.tasks, note: r.note });
    } catch (e) {
      const m = (e as Error).message;
      res.status(m === "unsupported_image" ? 415 : 500).json({ error: m });
    }
  });

  /* плеер */
  api.get("/player", (_req, res) => res.json({ state: getPlayerState() }));
  api.post("/player/cmd", (req, res) => {
    try {
      res.json(enqueueCommand(req.body?.cmd, req.body?.value));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.use("/api", api);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}

/* ------------------------------ запуск/остановка ----------------------------- */

let server: http.Server | null = null;
let listenPort = 0;

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal && isPrivateAddress(a.address)) out.push(a.address);
  }
  return out;
}

export async function start(port?: number): Promise<number> {
  if (server) return listenPort;
  const st = readState();
  const p = port ?? st.port;
  await new Promise<void>((resolve, reject) => {
    const s = createCompanionApp().listen(p, "0.0.0.0");
    s.once("listening", () => {
      server = s;
      listenPort = (s.address() as { port: number }).port;
      resolve();
    });
    s.once("error", reject);
  });
  logger.info("companion.start", { port: listenPort });
  return listenPort;
}

export async function stop(): Promise<void> {
  const s = server;
  server = null;
  listenPort = 0;
  pairing = null;
  playerState = null;
  queue = [];
  if (!s) return;
  await new Promise<void>((r) => {
    s.close(() => r());
    s.closeAllConnections?.();
  });
  logger.info("companion.stop");
}

export function status(): CompanionStatus {
  const st = readState();
  const port = listenPort || st.port;
  return {
    enabled: st.enabled,
    running: !!server,
    port,
    urls: lanAddresses().map((ip) => `http://${ip}:${port}/`),
    pairing: currentPairing(),
    devices: st.devices.map(({ tokenHash: _h, ...d }) => d),
    inboxDir: inboxDir(),
    inbox: listInbox().slice(0, 30),
  };
}

export async function setEnabled(enabled: boolean, port?: number): Promise<CompanionStatus> {
  const st = readState();
  if (port && Number.isInteger(port) && port >= 1024 && port < 65536) st.port = port;
  st.enabled = enabled;
  writeState(st);
  if (server && (!enabled || (port && port !== listenPort))) await stop();
  if (enabled) {
    await start(st.port);
    if (!currentPairing()) newPairingCode();
  }
  return status();
}

/** Запуск при старте приложения, если компаньон был включён. Ошибки не мешают старту. */
export function autoStart(): void {
  if (!readState().enabled) return;
  start().then(
    () => newPairingCode(),
    (e) => logger.warn("companion.autostart_failed", { error: (e as Error).message }),
  );
}
