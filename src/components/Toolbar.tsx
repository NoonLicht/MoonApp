import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";

// Позволяет каждой странице отдавать свой тулбар в верхнюю панель.
export const ToolbarContext = createContext<(node: ReactNode) => void>(() => {});

export function usePageToolbar(node: ReactNode, deps: readonly unknown[]): void {
  const setToolbar = useContext(ToolbarContext);
  useEffect(() => {
    setToolbar(node);
    return () => setToolbar(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
