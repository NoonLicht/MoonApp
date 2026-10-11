import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { moveObjs, fitGroups, withChildren } from "@/pages/myspace/canvas/board";
import type { AlignKind, Pt, Obj } from "@/pages/myspace/canvas/model";
import type { HandleId } from "@/pages/myspace/canvas/SelectionLayer";
import type { Tool } from "@/pages/myspace/canvas/ToolDock";
import type { InspectorActions } from "@/pages/myspace/canvas/Inspector";
import type { MenuItem } from "@/pages/myspace/canvas/ContextMenu";
import type { useBoard } from "@/pages/myspace/canvas/useBoard";

export const LS = {
  file: "holst.file",
  wheel: "holst.wheelZoom",
  grid: "holst.grid",
  snap: "holst.snap",
};
export const lsGet = (k: string, d: string): string => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
export const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* без запоминания */
  }
};

export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
};

export type Gesture =
  | { kind: "pan"; vx: number; vy: number; cx: number; cy: number }
  | {
      kind: "move";
      ids: Set<string>;
      start: Pt;
      moved: boolean;
      only: string | null;
      shift: boolean;
      cloned: boolean;
    }
  | { kind: "resize"; handle: HandleId; start: Pt; ids: string[] }
  | { kind: "rotate"; start: number; c: Pt; ids: string[]; base: number }
  | { kind: "marquee"; start: Pt; base: string[] }
  | { kind: "create"; tool: Tool; start: Pt; id: string | null; shift: boolean }
  | { kind: "pen"; pts: Pt[] }
  | { kind: "link"; id: string; end: "from" | "to"; start: Pt; moved: boolean }
  | null;

/** Всё, что нужно клавиатурным сочетаниям холста от страницы. */
export interface CanvasKeyDeps {
  spaceHeld: MutableRefObject<boolean>;
  wrapRef: RefObject<HTMLDivElement | null>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  selRef: MutableRefObject<string[]>;
  actions: InspectorActions;
  board: ReturnType<typeof useBoard>;
  setSel: (ids: string[]) => void;
  byIdRef: MutableRefObject<Map<string, Obj>>;
  setZoom: (z: number) => void;
  zoomAt: (factor: number, cx?: number, cy?: number) => void;
  setSnap: Dispatch<SetStateAction<boolean>>;
  snap: boolean;
  setGrid: Dispatch<SetStateAction<boolean>>;
  grid: boolean;
  copySel: (cut?: boolean) => void;
  duplicate: (dx?: number, dy?: number) => void;
  removeSel: () => void;
  gesture: MutableRefObject<Gesture>;
  setPenPts: Dispatch<SetStateAction<Pt[] | null>>;
  setTool: (tl: Tool) => void;
  setCtx: Dispatch<SetStateAction<{ x: number; y: number; items: MenuItem[] } | null>>;
  setEditing: Dispatch<SetStateAction<string | null>>;
  fitAll: () => void;
  fitSelection: () => void;
  fileInput: RefObject<HTMLInputElement | null>;
}

/** Горячие клавиши холста: инструменты, правка, масштаб, пробел-панорама. */
export function useCanvasKeyboard(deps: CanvasKeyDeps) {
  const { spaceHeld, wrapRef, setHelpOpen, selRef, actions, board, setSel, byIdRef, setZoom, zoomAt, setSnap, snap, setGrid, grid, copySel, duplicate, removeSel, gesture, setPenPts, setTool, setCtx, setEditing, fitAll, fitSelection, fileInput } = deps;

  const kb = useRef<(e: KeyboardEvent) => void>(() => undefined);
  kb.current = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const meta = e.ctrlKey || e.metaKey;
    /* буквы и знаки берём по физической клавише: на русской и других раскладках e.key другой */
    const k = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    const sym =
      e.code === "BracketRight"
        ? "]"
        : e.code === "BracketLeft"
          ? "["
          : e.code === "Equal" || e.code === "NumpadAdd"
            ? "+"
            : e.code === "Minus" || e.code === "NumpadSubtract"
              ? "-"
              : e.key;
    if (e.code === "Space" && !e.repeat) {
      spaceHeld.current = true;
      wrapRef.current?.classList.add("hc-space");
      e.preventDefault();
      return;
    }
    if (e.key === "?" || e.key === "F1" || (e.shiftKey && e.code === "Slash")) {
      e.preventDefault();
      setHelpOpen(true);
      return;
    }
    if (e.altKey && !meta && selRef.current.length) {
      const al: Record<string, AlignKind> = {
        KeyA: "left",
        KeyD: "right",
        KeyW: "top",
        KeyS: "bottom",
        KeyH: "hcenter",
        KeyV: "vcenter",
      };
      if (al[e.code]) {
        e.preventDefault();
        actions.align(al[e.code]);
        return;
      }
    }
    if (e.key === "Tab" && board.ref.current.length) {
      e.preventDefault();
      const list = board.ref.current.filter((o) => !o.parent && !o.hidden && !o.locked);
      if (list.length) {
        const at = list.findIndex((o) => o.id === selRef.current[selRef.current.length - 1]);
        const next = (at + (e.shiftKey ? -1 : 1) + list.length) % list.length;
        setSel([list[next].id]);
      }
      return;
    }
    if (meta && (k === "b" || k === "i") && selRef.current.length) {
      e.preventDefault();
      const first = byIdRef.current.get(selRef.current[0]);
      if (k === "b") actions.patch({ fw: (first?.fw ?? 500) >= 700 ? 500 : 700 });
      else actions.patch({ italic: !first?.italic });
      return;
    }
    if (meta && k === "0") {
      e.preventDefault();
      setZoom(1);
      return;
    }
    if (meta && (sym === "+" || sym === "-")) {
      e.preventDefault();
      zoomAt(sym === "-" ? 0.8 : 1.25);
      return;
    }
    if (meta && (e.key === "'" || e.code === "Quote")) {
      e.preventDefault();
      if (e.shiftKey) {
        setSnap(!snap);
        lsSet(LS.snap, snap ? "0" : "1");
      } else {
        setGrid(!grid);
        lsSet(LS.grid, grid ? "0" : "1");
      }
      return;
    }
    if (meta && k === "h" && e.shiftKey) {
      e.preventDefault();
      actions.hide();
      return;
    }
    if (meta && k === "z") {
      e.preventDefault();
      if (e.shiftKey) board.redo();
      else board.undo();
      setSel(selRef.current.filter((id) => board.ref.current.some((o) => o.id === id)));
      return;
    }
    if (meta && k === "y") {
      e.preventDefault();
      board.redo();
      return;
    }
    if (meta && k === "a") {
      e.preventDefault();
      setSel(board.ref.current.filter((o) => !o.parent && !o.hidden && !o.locked).map((o) => o.id));
      return;
    }
    if (meta && k === "c") {
      copySel();
      return;
    }
    if (meta && k === "x") {
      e.preventDefault();
      copySel(true);
      return;
    }
    if (meta && k === "d") {
      e.preventDefault();
      duplicate();
      return;
    }
    if (meta && k === "g") {
      e.preventDefault();
      if (e.shiftKey) actions.ungroup();
      else actions.group();
      return;
    }
    if (meta && k === "l" && e.shiftKey) {
      e.preventDefault();
      actions.lock();
      return;
    }
    if (meta && (sym === "]" || sym === "[")) {
      e.preventDefault();
      actions.order(
        sym === "]" ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward",
      );
      return;
    }
    if (meta) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeSel();
      return;
    }
    if (e.key === "Escape") {
      if (gesture.current) {
        board.cancel();
        gesture.current = null;
        setPenPts(null);
      } else if (selRef.current.length) setSel([]);
      else setTool("select");
      setCtx(null);
      return;
    }
    if (e.key === "Enter" && selRef.current.length === 1) {
      const o = byIdRef.current.get(selRef.current[0]);
      if (o && !o.locked && ["shape", "sticky", "text", "task", "frame"].includes(o.type)) {
        e.preventDefault();
        setEditing(o.id);
      }
      return;
    }
    if (e.key.startsWith("Arrow") && selRef.current.length) {
      e.preventDefault();
      const s = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -s : e.key === "ArrowRight" ? s : 0;
      const dy = e.key === "ArrowUp" ? -s : e.key === "ArrowDown" ? s : 0;
      const ids = withChildren(
        board.ref.current,
        selRef.current.filter((id) => !byIdRef.current.get(id)?.locked),
      );
      board.apply((o) => fitGroups(moveObjs(o, ids, dx, dy)), "nudge");
      return;
    }
    if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) {
      e.preventDefault();
      fitAll();
      return;
    }
    if (e.shiftKey && (e.key === "@" || e.code === "Digit2")) {
      e.preventDefault();
      fitSelection();
      return;
    }
    if (sym === "+") return zoomAt(1.25);
    if (sym === "-") return zoomAt(0.8);
    const map: Record<string, Tool> = {
      v: "select",
      h: "hand",
      s: "sticky",
      t: "text",
      r: "shape",
      l: "line",
      f: "frame",
      p: "pen",
      k: "task",
      e: "sticker",
    };
    if (map[k] && !e.altKey) {
      setTool(map[k]);
      return;
    }
    if (k === "i") fileInput.current?.click();
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => kb.current(e);
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld.current = false;
        wrapRef.current?.classList.remove("hc-space");
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
}
