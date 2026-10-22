import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Автосохранение документов Word/Excel: копия каждого изменённого документа лежит в IndexedDB
 * браузера и переживает закрытие страницы, поэтому «Восстановить» находит её при следующем входе.
 */
export type AutosaveKind = "word" | "sheet" | "deck" | "pdf" | "photoedit";

export interface AutosaveEntry {
  key: string;
  kind: AutosaveKind;
  name: string;
  ext: string;
  savedAt: number;
  blob: Blob;
}

const DB = "moonapp-autosave";
const STORE = "docs";
const PERIOD_MS = 4000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, job: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = job(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

export const autosaveStore = {
  put: (e: AutosaveEntry) => tx("readwrite", (s) => s.put(e)),
  remove: (key: string) => tx("readwrite", (s) => s.delete(key)),
  list: async (kind: AutosaveKind): Promise<AutosaveEntry[]> => {
    const all = await tx<AutosaveEntry[]>("readonly", (s) => s.getAll());
    return all.filter((e) => e.kind === kind).sort((a, b) => b.savedAt - a.savedAt);
  },
};

const flagKey = (kind: AutosaveKind): string => `moonapp.autosave.${kind}`;

function readFlag(kind: AutosaveKind): boolean {
  try {
    return localStorage.getItem(flagKey(kind)) !== "0";
  } catch {
    return true;
  }
}

export interface AutosaveItem {
  id: string;
  name: string;
  dirty: boolean;
  /** Любое значение, которое меняется вместе с содержимым (обычно объект состояния). */
  version: unknown;
}

interface Options {
  kind: AutosaveKind;
  ext: string;
  items: AutosaveItem[];
  /** Выгрузка документа в файл (docx / xlsx). */
  exportBlob: (id: string, name: string) => Promise<Blob | undefined>;
  /** Открыть восстановленный файл как новый документ. */
  openFile: (file: File) => Promise<unknown>;
}

export function useDocAutosave({ kind, ext, items, exportBlob, openFile }: Options) {
  const [enabled, setEnabledState] = useState(() => readFlag(kind));
  const [recovered, setRecovered] = useState<AutosaveEntry[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const exportRef = useRef(exportBlob);
  exportRef.current = exportBlob;
  const saved = useRef(new Map<string, unknown>());
  const seen = useRef(new Set<string>());
  const session = useRef(Date.now().toString(36));

  const keyOf = useCallback((id: string) => `${kind}:${session.current}:${id}`, [kind]);

  const refreshList = useCallback(() => {
    autosaveStore
      .list(kind)
      .then(setRecovered)
      .catch(() => setRecovered([]));
  }, [kind]);

  // Что осталось от прошлых сеансов (записи текущего сеанса не показываем).
  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // Документ закрыли кнопкой — его копия больше не нужна.
  useEffect(() => {
    const now = new Set(items.map((d) => d.id));
    for (const id of seen.current) {
      if (!now.has(id)) {
        void autosaveStore.remove(keyOf(id)).catch(() => undefined);
        saved.current.delete(id);
      }
    }
    seen.current = now;
  }, [items, keyOf]);

  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        for (const d of itemsRef.current) {
          if (!d.dirty || saved.current.get(d.id) === d.version) continue;
          const blob = await exportRef.current(d.id, d.name);
          if (!blob) continue;
          await autosaveStore.put({ key: keyOf(d.id), kind, name: d.name, ext, savedAt: Date.now(), blob });
          saved.current.set(d.id, d.version);
        }
      } catch {
        /* хранилище недоступно (приватное окно) — просто пропускаем цикл */
      } finally {
        busy = false;
      }
    }, PERIOD_MS);
    return () => clearInterval(timer);
  }, [enabled, kind, ext, keyOf]);

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on);
      try {
        localStorage.setItem(flagKey(kind), on ? "1" : "0");
      } catch {
        /* без хранилища настройка живёт до перезагрузки */
      }
    },
    [kind],
  );

  const restore = useCallback(
    async (e: AutosaveEntry) => {
      await openFile(new File([e.blob], `${e.name.replace(/\.[^.]+$/, "")}.${e.ext}`));
      await autosaveStore.remove(e.key).catch(() => undefined);
      refreshList();
    },
    [openFile, refreshList],
  );

  const discard = useCallback(
    async (e: AutosaveEntry) => {
      await autosaveStore.remove(e.key).catch(() => undefined);
      refreshList();
    },
    [refreshList],
  );

  return {
    enabled,
    setEnabled,
    recovered: recovered.filter((e) => !e.key.startsWith(`${kind}:${session.current}:`)),
    restore,
    discard,
  };
}

export type DocAutosave = ReturnType<typeof useDocAutosave>;
