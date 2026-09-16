import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Верхняя панель собирается из «слотов» страниц.
 *
 * Почему слоты, а не одна ячейка: страницы больше не размонтируются при
 * переключении (см. keep-alive в App.tsx), поэтому каждая страница пишет свой
 * узел в собственный слот, а панель показывает слот АКТИВНОЙ страницы. Так
 * порядок срабатывания эффектов не может «перетереть» чужим тулбаром.
 */
export type ToolbarWriter = (id: string, node: ReactNode | null) => void;
export const ToolbarContext = createContext<ToolbarWriter>(() => {});

/** Окружение конкретной страницы: её id и признак «сейчас видима». */
export interface PageHostState {
  id: string;
  active: boolean;
}
export const PageHostContext = createContext<PageHostState>({ id: "", active: true });

/** Признак «есть незавершённая работа» — такие страницы не выгружаются из памяти. */
export type BusyReporter = (id: string, busy: boolean) => void;
export const PageBusyContext = createContext<BusyReporter>(() => {});

/** true, когда страница видима: по нему страницы паузят опросы/анимации. */
export function usePageActive(): boolean {
  return useContext(PageHostContext).active;
}

/** Сообщить приложению, что на странице идёт задача (нельзя выгружать). */
export function usePageBusy(busy: boolean): void {
  const report = useContext(PageBusyContext);
  const { id } = useContext(PageHostContext);
  useEffect(() => {
    if (!id) return;
    report(id, busy);
  }, [id, busy, report]);
}

/** Отдать узел в верхний тулбар. Пишем только пока страница активна. */
export function usePageToolbar(node: ReactNode, deps: readonly unknown[]): void {
  const write = useContext(ToolbarContext);
  const { id, active } = useContext(PageHostContext);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  useEffect(() => {
    if (!id || !active) return;
    write(id, nodeRef.current);
    // Очистки нет намеренно: слот переживает деактивацию, а чистить его
    // (на любой смене deps) означало бы мигание панели.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, active, ...deps]);
}
