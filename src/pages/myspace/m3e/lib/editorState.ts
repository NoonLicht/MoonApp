import type { Item } from "@/pages/myspace/m3e/lib/tokens";

/* Общие типы и константы редактора M3E (вынесены из M3eEditor, чтобы подкомпоненты не импортировали его). */

/** a cancelled part shrinking away: long enough to be seen, short enough not to be waited for */
export const VANISH_MS = 180;
export const VANISH = { duration: VANISH_MS / 1000, ease: [0.3, 0, 0.8, 0.15] as const };

export type View = { x: number; y: number; z: number };
export type Snap = { groupId: string; index: number; pull: number };

/** alignment guide: the snapped position plus the line to draw */
export type Guide = { x?: number; y?: number; gx?: number; gy?: number };

export type DragState = {
  item: Item;
  /** the part as it was picked up, before any run it hovered lent it its size */
  base: Item;
  /** where the part was held when it was picked up; the magnet is worked out from these, so a
   *  run lending the part its size never moves the search out from under itself */
  baseOffX: number;
  baseOffY: number;
  guide: Guide | null;
  offX: number;
  offY: number;
  startX: number;
  startY: number;
  px: number;
  py: number;
  active: boolean;
  fromPalette: boolean;
  overBin: boolean;
  snap: Snap | null;
  settling: boolean;
  /** let go where it cannot land: the ghost shrinks away before the state is cleared */
  vanishing: boolean;
};
