/**
 * Общий каркас сайдкаров офисных ядер (Rust-бинарники WordCraft и GridCraft): запуск процесса,
 * JSON-строки в stdin/stdout, таймауты и реестр сеансов. Один процесс = один открытый документ.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";

export const OFFICE_DIR = path.join(config.DIRS.storage, "office");
const CALL_TIMEOUT_MS = 60_000;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

export class CoreProc {
  readonly child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  alive = true;

  constructor(bin: string, private readonly label: string) {
    this.child = spawn(bin, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.onData(d));
    this.child.stderr.on("data", (d: Buffer) =>
      logger.warn(`${this.label}.core.stderr`, { text: String(d).slice(0, 300) }),
    );
    const dead = (why: string): void => {
      if (!this.alive) return;
      this.alive = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      this.pending.clear();
    };
    this.child.on("error", (e) => dead(`core_spawn_failed: ${e.message}`));
    this.child.on("close", () => dead("core_exited"));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = msg.id != null ? this.pending.get(msg.id) : undefined;
      if (!p || msg.id == null) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error || "core_error")));
    }
  }

  call(method: string, params: unknown = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error("core_exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("core_timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (e) => {
        if (e) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
    });
  }

  kill(): void {
    this.alive = false;
    try {
      this.child.stdin.write('{"method":"quit"}\n');
    } catch {
      /* уже закрыт */
    }
    setTimeout(() => this.child.kill(), 300).unref?.();
  }
}

export interface CoreSession {
  id: string;
  name: string;
  /** Путь файла, с которым открыт документ (пусто — новый). */
  path: string;
  proc: CoreProc;
  openedAt: number;
}

export interface HostOptions {
  /** Короткое имя для логов и кодов: "word", "sheet". */
  label: string;
  /** Имя бинарника без расширения: "wordcore", "gridcore". */
  exe: string;
  /** Переменная окружения с путём к бинарнику. */
  envVar: string;
  maxSessions: number;
}

export interface Host {
  binCandidates(): string[];
  binPath(): string | null;
  status(): { available: boolean; bin: string | null; searched: string[]; sessions: number };
  list(): { id: string; name: string; path: string }[];
  get(id: string): CoreSession | undefined;
  /** Запустить процесс, выполнить `init` (открыть файл, создать документ) и зарегистрировать сеанс. */
  start<T>(
    o: { name: string; path: string; action: Record<string, unknown> },
    init: (proc: CoreProc) => Promise<T>,
  ): Promise<{ id: string; state: T }>;
  call(id: string, method: string, params?: unknown): Promise<unknown>;
  close(id: string): boolean;
  closeAll(): void;
}

export function createHost(o: HostOptions): Host {
  const exe = process.platform === "win32" ? `${o.exe}.exe` : o.exe;
  const sessions = new Map<string, CoreSession>();

  /** Где ищем бинарник: переменная окружения → storage → ресурсы приложения → локальная сборка. */
  const binCandidates = (): string[] => {
    const res = (process as unknown as { resourcesPath?: string }).resourcesPath || "";
    return [
      process.env[o.envVar] || "",
      path.join(OFFICE_DIR, exe),
      res ? path.join(res, o.exe, exe) : "",
      path.join(__dirname, "..", "native", o.exe, "target", "release", exe),
      path.join(__dirname, "..", "..", "native", o.exe, "target", "release", exe),
    ].filter(Boolean);
  };
  const binPath = (): string | null => binCandidates().find((p) => fs.existsSync(p)) || null;

  const close = (id: string): boolean => {
    const s = sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
    s.proc.kill();
    return true;
  };
  const closeAll = (): void => {
    for (const id of [...sessions.keys()]) close(id);
  };
  process.once("exit", closeAll);

  return {
    binCandidates,
    binPath,
    status: () => {
      const bin = binPath();
      return { available: !!bin, bin, searched: binCandidates(), sessions: sessions.size };
    },
    list: () => [...sessions.values()].map((s) => ({ id: s.id, name: s.name, path: s.path })),
    get: (id) => sessions.get(id),
    async start(meta, init) {
      const bin = binPath();
      if (!bin) throw new Error("core_not_installed");
      if (sessions.size >= o.maxSessions) throw new Error("too_many_documents");
      const proc = new CoreProc(bin, o.label);
      const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      try {
        const state = await init(proc);
        sessions.set(id, { id, name: meta.name, path: meta.path, proc, openedAt: Date.now() });
        logger.action(`${o.label}.open`, { id, ...meta.action });
        return { id, state };
      } catch (e) {
        proc.kill();
        throw e;
      }
    },
    async call(id, method, params = {}) {
      const s = sessions.get(id);
      if (!s) throw new Error("session_not_found");
      return s.proc.call(method, params);
    },
    close,
    closeAll,
  };
}
