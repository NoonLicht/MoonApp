import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";

// Позволяет каждой странице отдавать свой тулбар в верхнюю панель.
export const ToolbarContext = createContext<(node: ReactNode) => void>(() => {});

export function usePageToolbar(node: ReactNode, deps: readonly unknown[]): void {
  const setToolbar = useContext(ToolbarContext);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  useEffect(() => {
    setToolbar(nodeRef.current);
    return () => setToolbar(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
