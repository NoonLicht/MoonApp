import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { WordState, WordStatus } from "@/api/apiWord";
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
  }, []);

  const create = useCallback(
    async (template: string, name: string) => {
      setBusy(true);
      setError("");
      try {
        const r = await api.wordNew(template);
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
  const run = useCallback(
    (command: string, params: Record<string, unknown> = {}) => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(id, async () => {
        const r = await api.wordRun(id, command, params);
        patch(id, r.state);
        return r.result;
      });
    },
    [activeId, enqueue, patch],
  );

  const exportAs = useCallback(
    async (format: string) => {
      if (!active) return;
      setBusy(true);
      try {
        const blob = await enqueue(active.id, () => api.wordExport(active.id, format, active.name));
        if (blob) saveBlob(blob, `${active.name.replace(/\.[^.]+$/, "")}.${format}`);
      } finally {
        setBusy(false);
      }
    },
    [active, enqueue],
  );

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
    exportAs,
  };
}

export type WordDocs = ReturnType<typeof useWordDocs>;
