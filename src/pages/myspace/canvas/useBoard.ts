import { useCallback, useRef, useState } from "react";
import type { Obj } from "@/pages/myspace/canvas/model";

const LIMIT = 100;

/**
 * Список объектов с историей. Мгновенные правки (перетаскивание) идут через live(),
 * а одна запись в истории делается в конце жеста через commit().
 */
export function useBoard() {
  const [objs, setState] = useState<Obj[]>([]);
  const ref = useRef<Obj[]>([]);
  const past = useRef<Obj[][]>([]);
  const future = useRef<Obj[][]>([]);
  /** origin — что вернёт отмена жеста и что попадёт в историю; base — от чего считаются мгновенные правки */
  const gesture = useRef<{ origin: Obj[]; base: Obj[] } | null>(null);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const [, bump] = useState(0);

  const write = (next: Obj[]) => {
    ref.current = next;
    setState(next);
  };

  const push = (snap: Obj[]) => {
    past.current.push(snap);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
  };

  /** Правка с записью в историю. С key подряд идущие правки (например, набор цифр) склеиваются. */
  const apply = useCallback((fn: (o: Obj[]) => Obj[], key?: string) => {
    const next = fn(ref.current);
    if (next === ref.current) return;
    const now = Date.now();
    const merge = key && lastKey.current?.key === key && now - lastKey.current.at < 700;
    if (!merge) push(ref.current);
    lastKey.current = key ? { key, at: now } : null;
    write(next);
  }, []);

  /** Правка без истории: загрузка, подгонка высоты текста, подгрузка превью. */
  const silent = useCallback((fn: (o: Obj[]) => Obj[]) => {
    const next = fn(ref.current);
    if (next !== ref.current) write(next);
  }, []);

  const begin = useCallback(() => {
    gesture.current = { origin: ref.current, base: ref.current };
  }, []);

  /** то, что уже сделано в жесте (например, добавлен объект), становится новой основой для live() */
  const rebase = useCallback(() => {
    if (gesture.current) gesture.current.base = ref.current;
  }, []);

  const live = useCallback((fn: (base: Obj[]) => Obj[]) => {
    const base = gesture.current?.base ?? ref.current;
    write(fn(base));
  }, []);

  const commit = useCallback(() => {
    const g = gesture.current;
    gesture.current = null;
    if (g && g.origin !== ref.current) push(g.origin);
  }, []);

  const cancel = useCallback(() => {
    const g = gesture.current;
    gesture.current = null;
    if (g) write(g.origin);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return false;
    future.current.push(ref.current);
    write(prev);
    lastKey.current = null;
    bump((n) => n + 1);
    return true;
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return false;
    past.current.push(ref.current);
    write(next);
    lastKey.current = null;
    bump((n) => n + 1);
    return true;
  }, []);

  const reset = useCallback((next: Obj[]) => {
    past.current = [];
    future.current = [];
    gesture.current = null;
    write(next);
    bump((n) => n + 1);
  }, []);

  return {
    objs,
    ref,
    apply,
    silent,
    begin,
    rebase,
    live,
    commit,
    cancel,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
