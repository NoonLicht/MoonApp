import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { SheetRequest, SheetState, SheetStatus } from "@/api/apiSheet";

export interface SheetDoc {
  id: string;
  name: string;
  state: SheetState;
}

export type Params = Record<string, unknown>;

/**
 * Открытые книги страницы «Таблицы» и все действия над ними.
 * Вызовы к серверу идут строго по очереди: каждое действие возвращает свежее состояние,
 * и порядок «ввод → выделение → ввод» не должен перемешаться.
 */
export function useSheetDocs() {
  const [status, setStatus] = useState<SheetStatus | null>(null);
  const [docs, setDocs] = useState<SheetDoc[]>([]);
  const [activeId, setActiveId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const docsRef = useRef<SheetDoc[]>([]);
  docsRef.current = docs;
  /** Последнее состояние каждой книги: обновляется сразу, а не после отрисовки (нужно для ввода «на лету»). */
  const latest = useRef(new Map<string, SheetState>());
  /** Что ядро просило показать (диалог, правка ячейки…): обработчик ставит страница. */
  const onRequests = useRef<(reqs: SheetRequest[], docId: string) => void>(() => undefined);

  useEffect(() => {
    let alive = true;
    api
      .sheetStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus({ available: false, bin: null, searched: [], sessions: 0 }));
    return () => {
      alive = false;
    };
  }, []);

  // Закрываем сеансы ядра при уходе со страницы (процесс держит книгу в памяти).
  useEffect(
    () => () => {
      for (const d of docsRef.current) void api.sheetClose(d.id).catch(() => undefined);
    },
    [],
  );

  const active = docs.find((d) => d.id === activeId) ?? null;

  const patch = useCallback((id: string, state: SheetState) => {
    latest.current.set(id, state);
    setDocs((list) => list.map((d) => (d.id === id ? { ...d, state } : d)));
    if (state.requests?.length) onRequests.current(state.requests, id);
  }, []);

  /** Поставить действие в очередь; ошибка показывается и не рвёт очередь. */
  const enqueue = useCallback(<T>(job: () => Promise<T>): Promise<T | undefined> => {
    const next = chain.current.then(job).catch((e: Error) => {
      setError(String(e.message || e));
      return undefined;
    });
    chain.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T | undefined>;
  }, []);

  const add = useCallback((id: string, name: string, state: SheetState) => {
    latest.current.set(id, state);
    setDocs((list) => [...list, { id, name, state }]);
    setActiveId(id);
    if (state.requests?.length) onRequests.current(state.requests, id);
  }, []);

  const create = useCallback(
    async (sample: string, name: string) => {
      setBusy(true);
      setError("");
      try {
        const r = await api.sheetNew(sample);
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
    async (file: File, password?: string) => {
      setBusy(true);
      setError("");
      try {
        const r = await api.sheetOpen(file, password);
        add(r.id, r.name || file.name, r.state);
        return true;
      } catch (e) {
        setError(String((e as Error).message));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [add],
  );

  const close = useCallback(
    async (id: string) => {
      await api.sheetClose(id).catch(() => undefined);
      setDocs((list) => {
        const rest = list.filter((d) => d.id !== id);
        if (id === activeId) setActiveId(rest[rest.length - 1]?.id ?? "");
        return rest;
      });
    },
    [activeId],
  );

  /**
   * Команда ядра → её результат (состояние обновляется само).
   * `quiet` — запрос данных: просьбы ядра к интерфейсу (открыть диалог) игнорируются.
   */
  const run = useCallback(
    (command: string, params: Params = {}, quiet = false) => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(async () => {
        const r = await api.sheetRun(id, command, params);
        patch(id, quiet ? { ...r.state, requests: [] } : r.state);
        return r.result;
      });
    },
    [activeId, enqueue, patch],
  );

  /** Данные от ядра (значения диапазона, структура книги…) без обновления состояния. */
  const query = useCallback(
    <T = unknown>(method: string, params: unknown = {}): Promise<T | undefined> => {
      const id = activeId;
      if (!id) return Promise.resolve(undefined);
      return enqueue(() => api.sheetQuery(id, method, params) as Promise<T>);
    },
    [activeId, enqueue],
  );

  /** Все поставленные в очередь действия выполнены (состояние уже свежее). */
  const idle = useCallback(() => chain.current.then(() => undefined), []);
  const getState = useCallback((id: string) => latest.current.get(id), []);

  const refresh = useCallback(() => {
    const id = activeId;
    if (!id) return Promise.resolve(undefined);
    return enqueue(async () => {
      const st = await api.sheetState(id);
      patch(id, st);
      return st;
    });
  }, [activeId, enqueue, patch]);

  const exportAs = useCallback(
    async (format: string, name?: string, sheets?: "active" | "all") => {
      const id = activeId;
      if (!id) return undefined;
      return enqueue(() => api.sheetExport(id, format, name ?? active?.name ?? "book", sheets));
    },
    [activeId, active?.name, enqueue],
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
    onRequests,
    create,
    openFile,
    close,
    run,
    query,
    refresh,
    idle,
    getState,
    exportAs,
  };
}

export type SheetDocs = ReturnType<typeof useSheetDocs>;
