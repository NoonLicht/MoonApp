import type { ExecResult } from "@/lib/assistant/types";

/**
 * Связь страницы с одной рамкой WordCraft (веб-сборка, wasm): запросы к редактору и его события.
 * Протокол — postMessage, с обеих сторон `wc: 1` (см. native/office-web: native/office-web/README.md).
 */
export interface WcSelection {
  collapsed: boolean;
  focus: { path: number[] } | null;
  text: string;
}

export interface WcState {
  selection: WcSelection;
  pages: number;
  words: number;
  dirty: boolean;
  rev: number;
  fileName: string | null;
  canUndo: boolean;
}

interface Pending {
  resolve: (v: { result: unknown; bytes?: Uint8Array }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Сколько ждать ответа редактора (выгрузка большого документа — самый долгий запрос). */
const TIMEOUT_MS = 60_000;

export class WcLink {
  win: Window | null = null;
  ready = false;
  state: WcState | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private onReady: Array<() => void> = [];

  constructor(
    private events: {
      changed: () => void;
      download: (name: string, bytes: Uint8Array) => void;
    },
  ) {}

  /** Сообщение от рамки (источник проверяет вызывающий). */
  handle(m: Record<string, unknown>): void {
    if (m.evt === "ready") {
      this.ready = true;
      for (const f of this.onReady.splice(0)) f();
    } else if (m.evt === "state") {
      try {
        this.state = JSON.parse(String(m.state)) as WcState;
        this.events.changed();
      } catch {
        /* битое состояние пропускаем: придёт следующее */
      }
    } else if (m.evt === "download") {
      this.events.download(String(m.name), m.bytes as Uint8Array);
    } else if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve({ result: m.result, bytes: m.bytes as Uint8Array | undefined });
      else p.reject(new Error(String(m.error || "error")));
    }
  }

  whenReady(f: () => void): void {
    if (this.ready) f();
    else this.onReady.push(f);
  }

  /** Закрыть связь: ждущие запросы получают ошибку. */
  dispose(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("closed"));
    }
    this.pending.clear();
    this.onReady = [];
  }

  private send(op: string, fields: Record<string, unknown>, transfer?: Transferable[]) {
    return new Promise<{ result: unknown; bytes?: Uint8Array }>((resolve, reject) => {
      if (!this.win) return reject(new Error("no_frame"));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      // Рамка той же страницы, поэтому адрес получателя — наш собственный (вне браузера, в тестах, адреса нет).
      const origin = typeof window === "undefined" ? "*" : window.location.origin;
      this.win.postMessage({ wc: 1, id, op, ...fields }, origin, transfer);
    });
  }

  /** Команда редактора (любая команда ядра или `ui.*`); ошибка команды — исключение. */
  async run(command: string, params: unknown = {}): Promise<unknown> {
    return (await this.send("run", { params: { command, params } })).result;
  }

  /** Команда с итогом в виде `{ok, result|error}` — так её ждёт помощник. */
  async exec(command: string, params: unknown = {}): Promise<ExecResult> {
    try {
      return { ok: true, result: await this.run(command, params) };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) };
    }
  }

  async refresh(): Promise<WcState> {
    const r = await this.send("state", {});
    this.state = r.result as WcState;
    return this.state;
  }

  /** Документ как файл .docx. */
  async exportDocx(name = "document.docx"): Promise<Uint8Array> {
    const r = await this.send("export", { params: { name } });
    if (!r.bytes) throw new Error("no_bytes");
    return r.bytes;
  }

  /** Открыть файл в документе рамки (рамка должна быть пустой: иначе она спросит про сохранение). */
  async open(name: string, bytes: ArrayBuffer): Promise<void> {
    await this.send("open", { name, bytes }, [bytes]);
  }

  /** Документ сохранён у нас: убрать отметку «есть несохранённые изменения». */
  async markClean(): Promise<void> {
    await this.send("clean", { params: {} });
  }
}
