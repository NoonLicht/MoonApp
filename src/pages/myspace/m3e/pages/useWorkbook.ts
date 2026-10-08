import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { M3ePageMeta, M3eTrashMeta, M3eWorkbook } from "@/api/apiM3e";
import type { Doc } from "@/pages/myspace/m3e/lib/tokens";
import { blankDoc, parseDoc, type StoredDoc } from "@/pages/myspace/m3e/pages/docUtil";

/** Страница, открытая в редакторе. `focus` — экран, к которому надо прилететь при открытии. */
export interface ActivePage {
  id: string;
  doc: StoredDoc;
  focus: string | null;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_DELAY_MS = 700;

const countOf = (doc: Partial<Doc>) => ({
  screens: Array.isArray(doc.frames) ? doc.frames.length : 0,
  parts: Array.isArray(doc.groups)
    ? doc.groups.reduce((n, g) => n + (g?.items?.length ?? 0), 0)
    : 0,
});

/**
 * Набор страниц «M3E Canvas»: список, открытая страница и сохранение.
 * Документы лежат на сервере (storage/m3e); здесь же кеш их текста, чтобы переключение
 * на уже виденную страницу было мгновенным, а обзор и поиск не ходили за каждым документом заново.
 */
export function useWorkbook(homeName: string) {
  const [wb, setWb] = useState<M3eWorkbook | null>(null);
  const [active, setActive] = useState<ActivePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");

  const docs = useRef(new Map<string, string>());
  const pending = useRef<{ id: string; text: string } | null>(null);
  const timer = useRef<number | null>(null);
  const token = useRef(0);
  const alive = useRef(true);
  const activeRef = useRef<ActivePage | null>(null);
  activeRef.current = active;
  const wbRef = useRef<M3eWorkbook | null>(null);
  wbRef.current = wb;

  /** Записать отложенные правки немедленно. */
  const flush = useCallback(async (keepalive = false) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (alive.current) setSave("saving");
    try {
      const meta = await api.m3eWrite(p.id, p.text, keepalive);
      if (!alive.current) return;
      setWb((w) =>
        w ? { ...w, pages: w.pages.map((x) => (x.id === meta.id ? { ...x, ...meta } : x)) } : w,
      );
      setSave(pending.current ? "saving" : "saved");
    } catch {
      if (alive.current) setSave("error");
      // не потеряем правки: вернём в очередь, если за это время не появились новее
      if (!pending.current) pending.current = p;
    }
  }, []);

  const readDoc = useCallback(async (id: string): Promise<string> => {
    const hit = docs.current.get(id);
    if (hit !== undefined) return hit;
    const text = await api.m3eRead(id);
    docs.current.set(id, text);
    return text;
  }, []);

  const open = useCallback(
    async (id: string, focus: string | null = null) => {
      const mine = ++token.current;
      await flush();
      setError(null);
      try {
        if (activeRef.current?.id !== id) setBusy(true);
        const text = await readDoc(id);
        if (!alive.current || mine !== token.current) return;
        setActive({ id, doc: parseDoc(text), focus });
        setWb((w) => (w ? { ...w, activeId: id } : w));
        void api.m3ePatch({ activeId: id }).catch(() => undefined);
      } catch (e) {
        if (alive.current && mine === token.current) setError((e as Error).message);
      } finally {
        if (alive.current && mine === token.current) setBusy(false);
      }
    },
    [flush, readDoc],
  );

  const reload = useCallback(async () => {
    setError(null);
    try {
      let list = await api.m3eList();
      if (list.pages.length === 0) {
        await api.m3eCreate("");
        list = await api.m3eList();
      }
      if (!alive.current) return;
      setWb(list);
      const id =
        list.activeId && list.pages.some((p) => p.id === list.activeId)
          ? list.activeId
          : list.pages[0].id;
      await open(id);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [open]);

  useEffect(() => {
    alive.current = true;
    void reload();
    const onHide = () => void flush(true);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      void flush(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Редактор прислал новое состояние открытой страницы. */
  const onDocChange = useCallback(
    (id: string, doc: Partial<Doc>) => {
      const text = JSON.stringify(doc);
      if (docs.current.get(id) === text) return;
      docs.current.set(id, text);
      pending.current = { id, text };
      const c = countOf(doc);
      const title = typeof doc.title === "string" ? doc.title.trim().slice(0, 120) : "";
      setWb((w) =>
        w
          ? {
              ...w,
              pages: w.pages.map((x) =>
                x.id === id
                  ? { ...x, title, screens: c.screens, parts: c.parts, updatedAt: Date.now() }
                  : x,
              ),
            }
          : w,
      );
      setSave("saving");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  const applyList = useCallback((list: M3eWorkbook) => setWb(list), []);

  const create = useCallback(
    async (text: string, after?: string) => {
      await flush();
      const meta = await api.m3eCreate(text, after ?? activeRef.current?.id);
      docs.current.set(meta.id, text);
      const list = await api.m3eList();
      if (!alive.current) return meta;
      setWb(list);
      await open(meta.id);
      return meta;
    },
    [flush, open],
  );

  const createBlank = useCallback(() => create(blankDoc(homeName)), [create, homeName]);

  const duplicate = useCallback(
    async (id: string, title: string) => {
      await flush();
      const meta = await api.m3eDuplicate(id, title);
      docs.current.delete(meta.id);
      setWb(await api.m3eList());
      await open(meta.id);
      return meta;
    },
    [flush, open],
  );

  const remove = useCallback(
    async (id: string): Promise<M3eTrashMeta | null> => {
      await flush();
      const meta = wbRef.current?.pages.find((p) => p.id === id);
      const list = await api.m3eDelete(id);
      docs.current.delete(id);
      if (!alive.current) return null;
      if (list.pages.length === 0) {
        await api.m3eCreate(blankDoc(homeName));
        const fresh = await api.m3eList();
        setWb(fresh);
        await open(fresh.activeId ?? fresh.pages[0].id);
      } else {
        setWb(list);
        if (activeRef.current?.id === id) await open(list.activeId ?? list.pages[0].id);
      }
      return meta ? { ...meta, deletedAt: Date.now() } : null;
    },
    [flush, open, homeName],
  );

  const restore = useCallback(
    async (id: string) => {
      const list = await api.m3eRestore(id);
      setWb(list);
      if (list.activeId) await open(list.activeId);
    },
    [open],
  );

  const purge = useCallback(async (id: string) => setWb(await api.m3ePurge(id)), []);

  const reorder = useCallback((order: string[]) => {
    setWb((w) => {
      if (!w) return w;
      const byId = new Map(w.pages.map((p) => [p.id, p]));
      const next = order.map((id) => byId.get(id)).filter((p): p is M3ePageMeta => !!p);
      return { ...w, pages: next };
    });
    void api.m3ePatch({ order }).catch(() => undefined);
  }, []);

  const patchPage = useCallback((id: string, p: { pinned?: boolean; color?: string | null }) => {
    setWb((w) =>
      w
        ? {
            ...w,
            pages: w.pages.map((x) =>
              x.id !== id
                ? x
                : {
                    ...x,
                    pinned: p.pinned === undefined ? x.pinned : p.pinned || undefined,
                    color: p.color === undefined ? x.color : p.color || undefined,
                  },
            ),
          }
        : w,
    );
    void api.m3ePatch({ pages: { [id]: p } }).catch(() => undefined);
  }, []);

  /** Переименовать страницу, которая сейчас не открыта в редакторе: правим название прямо в документе. */
  const retitleClosed = useCallback(
    async (id: string, title: string) => {
      const text = await readDoc(id);
      const doc = parseDoc(text) ?? (JSON.parse(blankDoc(homeName)) as Partial<Doc>);
      const next = JSON.stringify({ ...doc, title });
      docs.current.set(id, next);
      const meta = await api.m3eWrite(id, next);
      setWb((w) =>
        w ? { ...w, pages: w.pages.map((x) => (x.id === id ? { ...x, ...meta } : x)) } : w,
      );
    },
    [readDoc, homeName],
  );

  return {
    wb,
    active,
    error,
    busy,
    save,
    docs,
    readDoc,
    open,
    reload,
    flush,
    onDocChange,
    applyList,
    create,
    createBlank,
    duplicate,
    remove,
    restore,
    purge,
    reorder,
    patchPage,
    retitleClosed,
  };
}
