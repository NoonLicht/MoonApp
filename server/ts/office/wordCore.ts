/**
 * Ядро текстового редактора (WordCraft, MIT/Apache-2.0) как сайдкар.
 *
 * Интерфейс страницы «Документы» — наш, на React; движок документа (модель, вёрстка, команды,
 * растеризация страниц, чтение и запись docx/odt/rtf/…) — готовый Rust-бинарник `wordcore`
 * (native/wordcore), который по строке JSON в stdin отвечает строкой JSON в stdout.
 * Один процесс = один открытый документ (у ядра один сеанс на процесс).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";

const EXE = process.platform === "win32" ? "wordcore.exe" : "wordcore";
const MAX_SESSIONS = 6;
const CALL_TIMEOUT_MS = 60_000;

export const OFFICE_DIR = path.join(config.DIRS.storage, "office");

/** Где ищем бинарник: переменная окружения → storage → ресурсы приложения → локальная сборка. */
export function binCandidates(): string[] {
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath || "";
  return [
    process.env.MOONAPP_WORDCORE || "",
    path.join(OFFICE_DIR, EXE),
    res ? path.join(res, "wordcore", EXE) : "",
    path.join(__dirname, "..", "native", "wordcore", "target", "release", EXE),
    path.join(__dirname, "..", "..", "native", "wordcore", "target", "release", EXE),
  ].filter(Boolean);
}

export function binPath(): string | null {
  return binCandidates().find((p) => fs.existsSync(p)) || null;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

class CoreProc {
  readonly child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  alive = true;

  constructor(bin: string) {
    this.child = spawn(bin, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.onData(d));
    this.child.stderr.on("data", (d: Buffer) =>
      logger.warn("word.core.stderr", { text: String(d).slice(0, 300) }),
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

export interface WordSession {
  id: string;
  name: string;
  /** Путь файла, с которым открыт документ (пусто — новый). */
  path: string;
  proc: CoreProc;
  openedAt: number;
}

const sessions = new Map<string, WordSession>();

export function status(): {
  available: boolean;
  bin: string | null;
  searched: string[];
  sessions: number;
} {
  const bin = binPath();
  return { available: !!bin, bin, searched: binCandidates(), sessions: sessions.size };
}

export const list = (): { id: string; name: string; path: string }[] =>
  [...sessions.values()].map((s) => ({ id: s.id, name: s.name, path: s.path }));

export const get = (id: string): WordSession | undefined => sessions.get(id);

const TEMPLATES = ["blank", "sample", "letter", "resume", "report"];

/** Открыть новый сеанс: пустой документ/шаблон либо файл с диска. */
export async function open(o: {
  file?: string;
  template?: string;
  name?: string;
}): Promise<{ id: string; state: unknown }> {
  const bin = binPath();
  if (!bin) throw new Error("core_not_installed");
  if (sessions.size >= MAX_SESSIONS) throw new Error("too_many_documents");
  const proc = new CoreProc(bin);
  const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  try {
    if (o.file) {
      await proc.call("engine.execute", { command: "file.open", params: { path: o.file } });
    } else if (o.template && TEMPLATES.includes(o.template) && o.template !== "blank") {
      await proc.call("engine.execute", { command: "file.new", params: { template: o.template } });
    }
    const state = await proc.call("view.state");
    sessions.set(id, {
      id,
      name: o.name || (o.file ? path.basename(o.file) : "Документ"),
      path: o.file || "",
      proc,
      openedAt: Date.now(),
    });
    logger.action("word.open", { id, file: !!o.file, template: o.template || "blank" });
    return { id, state };
  } catch (e) {
    proc.kill();
    throw e;
  }
}

export async function call(id: string, method: string, params: unknown = {}): Promise<unknown> {
  const s = sessions.get(id);
  if (!s) throw new Error("session_not_found");
  return s.proc.call(method, params);
}

export function close(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  s.proc.kill();
  return true;
}

export function closeAll(): void {
  for (const id of [...sessions.keys()]) close(id);
}

process.once("exit", closeAll);
