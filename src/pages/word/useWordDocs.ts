import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { WordRequest, WordState, WordStatus } from "@/api/apiWord";
import type { ExecResult } from "@/lib/assistant/types";
import { saveBlob } from "@/lib/download";

export interface WordDoc {
  id: string;
  name: string;
  state: WordState;
}

/** Имена клавиш браузера → имена в раскладке ядра. */
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
};

export const coreKey = (k: string): string => KEY_NAMES[k] ?? k;

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/**
 * Открытые документы страницы «Документы» и все действия над ними.
 * Вызовы к серверу идут строго по очереди: каждое действие возвращает свежее состояние,
 * и порядок «ввод → клик → ввод» не должен перемешаться.
 */
export function useWordDocs() {
  const [status, setStatus] = useState<WordStatus | null>(null);
  const [docs, setDocs] = useState<WordDoc[]>([]);
  const [activeId, setActiveId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const docsRef = useRef<WordDoc[]>([]);
  docsRef.current = docs;
  /** Что ядро просило показать (диалог, прокрутка…): обработчик ставит страница. */
  const onRequests = useRef<(reqs: WordRequest[], docId: string) => void>(() => undefined);
  /** Текст, который мы сами положили в системный буфер: тогда вставка идёт из буфера ядра (с форматированием). */
  const ownClip = useRef("");

  useEffect(() => {
    let alive = true;
    api
      .wordStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus({ available: false, bin: null, searched: [], sessions: 0 }));
    return () => {
      alive = false;
    };
  }, []);

  // Закрываем сеансы ядра при уходе со страницы (процесс держит документ в памяти).
  useEffect(
    () => () => {
      for (const d of docsRef.current) void api.wordClose(d.id).catch(() => undefined);
    },
    [],
  );

  const active = docs.find((d) => d.id === activeId) ?? null;

  const patch = useCallback((id: string, state: WordState) => {
    setDocs((list) => list.map((d) => (d.id === id ? { ...d, state } : d)));
    if (state.requests?.length) onRequests.current(state.requests, id);
  }, []);

  /** Поставить действие над документом в очередь; ошибка показывается и не рвёт очередь. */
  const enqueue = useCallback(<T>(id: string, job: () => Promise<T>): Promise<T | undefined> => {
    const next = chain.current.then(job).catch((e: Error) => {
      setError(String(e.message || e));
      return undefined;
    });
    chain.current = next.then(
      () => undefined,
      () => undefined,
    );
    void id;
    return next as Promise<T | undefined>;
  }, []);

  const add = useCallback((id: string, name: string, state: WordState) => {
    setDocs((list) => [...list, { id, name, state }]);
    setActiveId(id);
    if (state.requests?.length) onRequests.current(state.requests, id);
  }, []);

  const create = useCallback(
    async (template: string, name: string, locale?: { region?: string; lang?: string }) => {
      setBusy(true);
      setError("");
      try {
        const r = await api.wordNew(template, locale);
        add(r.id, name, r.state);
      } catch (e) {
        setError(String((e as Error).message));
      } finally {
        setBusy(false);
      }
    },
    [add],
  );

  const openFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError("");
      try {
        const r = await api.wordOpen(file);
        add(r.id, r.name || file.name, r.state);
      } catch (e) {
        setError(String((e as Error).message));
      } finally {
        setBusy(false);
      }
    },
    [add],
  );

  const close = useCallback(
    async (id: string) => {
      await api.wordClose(id).catch(() => undefined);
      setDocs((list) => {
        const rest = list.filter((d) => d.id !== id);
        if (id === activeId) setActiveId(rest[rest.length - 1]?.id ?? "");
        return rest;
      });
    },
    [activeId],
  );

  const wrap = useCallback(
    (fn: (id: string) => Promise<WordState>) => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(id, async () => {
        const st = await fn(id);
        patch(id, st);
        return st;
      });
    },
    [activeId, enqueue, patch],
  );

  const type = useCallback((text: string) => wrap((id) => api.wordType(id, text)), [wrap]);
  const key = useCallback(
    (k: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
      wrap((id) => api.wordKey(id, { key: coreKey(k), ...mods })),
    [wrap],
  );
  const click = useCallback(
    (page: number, x: number, y: number, extend = false, count = 1) =>
      wrap((id) => api.wordClick(id, { page, x, y, extend, count })),
    [wrap],
  );
  /**
   * Команда ядра → её результат (состояние обновляется само).
   * `quiet` — запрос данных: просьбы ядра к интерфейсу (открыть диалог, панель) игнорируются.
   */
  const run = useCallback(
    (command: string, params: Record<string, unknown> = {}, quiet = false) => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(id, async () => {
        const r = await api.wordRun(id, command, params);
        patch(id, quiet ? { ...r.state, requests: [] } : r.state);
        return r.result;
      });
    },
    [activeId, enqueue, patch],
  );
  /** Как `run`, но ошибка ядра возвращается текстом (для помощника), а не уходит в общий баннер. */
  const exec = useCallback(
    (command: string, params: Record<string, unknown> = {}): Promise<ExecResult> => {
      const id = activeId;
      if (!id) return Promise.resolve({ ok: false, error: "no_document" });
      const next = chain.current.then(async (): Promise<ExecResult> => {
        try {
          const r = await api.wordRun(id, command, params);
          patch(id, { ...r.state, requests: [] });
          return { ok: true, result: r.result };
        } catch (e) {
          return { ok: false, error: String((e as Error).message || e) };
        }
      });
      chain.current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    [activeId, patch],
  );
  /** Данные от ядра (структура документа и т. п.) без обновления состояния. */
  const query = useCallback(
    <T = unknown>(method: string, params: unknown = {}): Promise<T | undefined> => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(id, () => api.wordQuery(id, method, params) as Promise<T>);
    },
    [activeId, enqueue],
  );

  const copyToSystem = useCallback(async (id: string): Promise<void> => {
    const clip = await api.wordClip(id);
    ownClip.current = clip.text;
    try {
      if (clip.html && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([clip.text], { type: "text/plain" }),
            "text/html": new Blob([clip.html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(clip.text);
      }
    } catch {
      /* системный буфер недоступен: вставка внутри документа всё равно работает */
    }
  }, []);

  /** Копировать/вырезать выделенное: ядро запоминает фрагмент с форматированием, текст и HTML — в системный буфер. */
  const copy = useCallback(
    (cut = false) => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(id, async () => {
        const r = await api.wordRun(id, cut ? "edit.cut" : "edit.copy", {});
        patch(id, r.state);
        await copyToSystem(id);
      });
    },
    [activeId, enqueue, patch, copyToSystem],
  );

  /** Вставить из системного буфера: картинка → рисунок; свой же фрагмент → с форматированием; иначе HTML/текст. */
  const paste = useCallback(
    (as: "default" | "text" | "merge" = "default", data?: DataTransfer | null) => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(id, async () => {
        let text = "";
        let html = "";
        let picture = "";
        // Событие paste отдаёт содержимое буфера без запроса разрешения у браузера.
        const file = data ? [...data.files].find((f) => f.type.startsWith("image/")) : undefined;
        if (data && (file || data.types.length)) {
          if (file) picture = await toBase64(file);
          html = data.getData("text/html");
          text = data.getData("text/plain");
        } else
          try {
            const items = await navigator.clipboard.read();
            for (const it of items) {
              const img = it.types.find((t) => t.startsWith("image/"));
              if (img) picture = await toBase64(await it.getType(img));
              if (it.types.includes("text/html"))
                html = await (await it.getType("text/html")).text();
              if (it.types.includes("text/plain"))
                text = await (await it.getType("text/plain")).text();
            }
          } catch {
            try {
              text = await navigator.clipboard.readText();
            } catch {
              /* нет доступа к буферу */
            }
          }
        let r;
        if (picture && !text && !html) {
          r = await api.wordRun(id, "edit.pasteSpecial", { as: "picture", picture });
        } else if (as === "text") {
          r = await api.wordRun(id, "edit.pasteText", { text });
        } else if (text && text === ownClip.current && as === "default") {
          r = await api.wordRun(id, "edit.paste", {});
        } else if (as === "merge") {
          r = await api.wordRun(id, "edit.pasteMerge", { text, html });
        } else if (text || html) {
          r = await api.wordRun(id, "edit.paste", { text, html });
        } else {
          r = await api.wordRun(id, "edit.paste", {});
        }
        patch(id, r.state);
      });
    },
    [activeId, enqueue, patch],
  );

  /** Скачать документ в формате (docx, pdf, odt, rtf, html, md, txt). */
  const exportAs = useCallback(
    async (format: string, name?: string) => {
      if (!active) return;
      setBusy(true);
      try {
        const base = (name ?? active.name).replace(/\.[^.]+$/, "");
        const blob = await enqueue(active.id, () => api.wordExport(active.id, format, base));
        if (blob) saveBlob(blob, `${base}.${format}`);
      } finally {
        setBusy(false);
      }
    },
    [active, enqueue],
  );

  const rename = useCallback((id: string, name: string) => {
    setDocs((list) => list.map((d) => (d.id === id ? { ...d, name } : d)));
  }, []);

  return {
    status,
    docs,
    active,
    activeId,
    setActiveId,
    error,
    setError,
    busy,
    create,
    openFile,
    close,
    type,
    key,
    click,
    run,
    exec,
    query,
    copy,
    paste,
    exportAs,
    rename,
    onRequests,
  };
}

export type WordDocs = ReturnType<typeof useWordDocs>;
