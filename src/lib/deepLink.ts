/**
 * Переход «в нужное место» из любого поиска: страница + объект на ней.
 * App слушает событие и переключает страницу; сама страница забирает цель
 * через useDeepLink (сразу при монтировании и по событию).
 */
import { useEffect, useRef } from "react";
import type { PageId } from "@/app/navigation";
import type { SemSource } from "@/api/apiSemantic";

export interface DeepTarget {
  page: PageId;
  /** Вид внутри страницы (например, "canvas" у My Space). */
  view?: string;
  /** Идентификатор объекта: путь заметки, id чата и т.д. */
  ref?: string;
  /** Метка внутри объекта (мс лекции). */
  at?: number;
}

const EVENT = "moon:open";
let pending: DeepTarget | null = null;

export function openTarget(t: DeepTarget): void {
  pending = t;
  window.dispatchEvent(new CustomEvent<DeepTarget>(EVENT, { detail: t }));
}

/** Страница, на которую ведёт источник семантического индекса. */
export function targetFor(source: SemSource, ref: string, at?: number): DeepTarget {
  switch (source) {
    case "note":
      return { page: "myspace", view: "notes", ref };
    case "bookmark":
      return { page: "myspace", view: "bookmarks", ref };
    case "task":
      return { page: "myspace", view: "tasks", ref };
    case "canvas":
      return { page: "myspace", view: "canvas", ref };
    case "chat":
      return { page: "aichat", ref };
    case "lecture":
      return { page: "lecture", ref, at };
    case "quick":
      return { page: "lecture", view: "quick", ref };
    case "budget":
      return { page: "budget", ref };
    case "movie":
      return { page: "movies", ref };
    case "book":
      return { page: "books", ref };
    case "m3e":
      return { page: "myspace", view: "m3e", ref };
    case "archive":
      return { page: "archive", ref };
  }
}

/** Значок вида объекта (для ссылок в заметках и карточек на Canvas). */
export const SOURCE_ICON: Record<SemSource, string> = {
  note: "📝",
  bookmark: "🔖",
  task: "✅",
  canvas: "🎨",
  chat: "💬",
  lecture: "🎓",
  quick: "🎙️",
  budget: "💰",
  movie: "🎬",
  book: "📚",
  m3e: "🧩",
  archive: "🗄️",
};

/** Ссылка внутри приложения для markdown: [📝 Название](moon://note/путь). */
export function moonHref(kind: SemSource, ref: string): string {
  return `moon://${kind}/${encodeURIComponent(ref)}`;
}
export function parseMoonHref(href: string): { kind: SemSource; ref: string } | null {
  const m = /^moon:\/\/([a-z0-9]+)\/(.*)$/i.exec(href);
  if (!m) return null;
  try {
    return { kind: m[1] as SemSource, ref: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}
/** Открыть moon://-ссылку: переход на страницу и к объекту. */
export function openMoonHref(href: string): boolean {
  const p = parseMoonHref(href);
  if (!p) return false;
  openTarget(targetFor(p.kind, p.ref));
  return true;
}

export const SOURCE_LABEL: Record<SemSource, string> = {
  note: "Заметка",
  bookmark: "Закладка",
  task: "Задача",
  canvas: "Canvas",
  chat: "Чат ИИ",
  lecture: "Лекция",
  quick: "Быстрая заметка",
  budget: "Бюджет",
  movie: "Фильм",
  book: "Книга",
  m3e: "Макет M3E",
  archive: "Веб-архив",
};

/** Подписка страницы на переход: handler вызывается и для цели, пришедшей до монтирования. */
export function useDeepLink(page: PageId, handler: (t: DeepTarget) => boolean | void): void {
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    if (pending && pending.page === page) {
      const t = pending;
      // false — цель предназначена вложенному компоненту (он ещё не смонтирован): оставляем её.
      if (h.current(t) !== false) pending = null;
    }
    const on = (e: Event) => {
      const t = (e as CustomEvent<DeepTarget>).detail;
      if (t.page !== page) return;
      if (h.current(t) !== false) pending = null;
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [page]);
}

/** App: переключать страницу по событию. */
export function onOpenTarget(cb: (page: PageId) => void): () => void {
  const on = (e: Event) => cb((e as CustomEvent<DeepTarget>).detail.page);
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}
