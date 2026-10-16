/**
 * Какие страницы включены. Состояние живёт на сервере (settings.pages.disabled), здесь —
 * его копия для интерфейса: док, палитра команд, стартовая страница и переходы по ссылкам
 * берут страницы отсюда, а не из полного списка PAGES.
 */
import { useSyncExternalStore } from "react";
import { api } from "@/api/client";
import type { FeaturesState } from "@/api/apiFeatures";
import { PAGES } from "@/app/navigation";
import type { PageMeta } from "@/app/navigation";

let state: FeaturesState | null = null;
let disabled: ReadonlySet<string> = new Set();
let version = 0;
let pagesCache: { v: number; list: readonly PageMeta[] } = { v: -1, list: PAGES };
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/** Принять состояние от сервера (после загрузки или изменения). */
export function applyFeatures(next: FeaturesState): void {
  state = next;
  disabled = new Set(next.disabled);
  emit();
}

/** Подтянуть состояние с сервера. Недоступный сервер = всё включено. */
export async function loadPageAccess(): Promise<void> {
  try {
    applyFeatures(await api.features());
  } catch {
    /* сервер ещё поднимается — страницы остаются включёнными */
  }
}

export const isPageEnabled = (id: string): boolean => !disabled.has(id);

/** Включённые страницы в порядке дока. */
export function enabledPages(): readonly PageMeta[] {
  if (pagesCache.v !== version) {
    pagesCache = { v: version, list: PAGES.filter((p) => !disabled.has(p.id)) };
  }
  return pagesCache.list;
}

export async function setProfile(profile: string): Promise<void> {
  applyFeatures(await api.featuresSet({ profile }));
}

export async function setPageEnabled(id: string, on: boolean): Promise<void> {
  const cur = new Set(disabled);
  if (on) cur.delete(id);
  else cur.add(id);
  applyFeatures(await api.featuresSet({ disabled: [...cur] }));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Для компонентов: перерисовывается при любом изменении набора страниц. */
export function usePageAccess(): {
  state: FeaturesState | null;
  pages: readonly PageMeta[];
  isEnabled: (id: string) => boolean;
} {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return { state, pages: enabledPages(), isEnabled: isPageEnabled };
}
