/**
 * Модель редактора M3E: константы, типы жестов и снимков, миграции документа, сидовые
 * данные. Вынесено из M3eEditor.tsx — файла на 5000 строк; здесь нет React и JSX.
 */
import { ASSET_BASE } from "@/pages/myspace/m3e/lib/assets";
import {
  hasPickerFields,
  migrateCarousel,
  migrateFabMenu,
  migratePicker,
  isSheetBox,
  migrateSheetBox,
  Doc,
  Frame,
  frameRect,
  frameSizeOf,
  Group,
  Item,
  Kind,
  KIND_SPEC,
  makeItem,
  NAV_BAR_H,
  PHONE_H,
  PHONE_MARGIN,
  PHONE_W,
  SETTLE_MS,
  uid,
  railExpansionSide,
} from "@/pages/myspace/m3e/lib/tokens";
import {
  Lang,
  SEED_TEXT,
  getLang,
  t,
  translateDefaultFrameName,
  translateDefaultText,
} from "@/pages/myspace/m3e/lib/i18n";
import type { Guide } from "@/pages/myspace/m3e/lib/editorState";

/** the screens while a model drafts: primary, tertiary and primary container, drifting */
export const BASE_PATH = ASSET_BASE;

/** the dragged part's own travel: a little lag reads as weight */
export const CARRY = {
  type: "spring" as const,
  stiffness: 620,
  damping: 38,
  mass: 0.7,
};
/** the gap opening and the run's counter-shift; identical configs so they cancel */
export const OPEN = {
  type: "spring" as const,
  stiffness: 700,
  damping: 42,
  mass: 0.55,
};
export const INSTANT = { duration: 0 };
/** a hole opening or closing: the run's offset travels on the same curve the hole's own width does */
export const GAP_TWEEN = { duration: SETTLE_MS / 1000, ease: [0.2, 0, 0, 1] as const };

export const MIN_Z = 0.25;
export const MAX_Z = 3;
/** the room a screen keeps from the canvas edges when the camera glides to it: the floating
 *  toolbar's row at the top, a margin elsewhere */
export const GLIDE_TOP = 84;
export const GLIDE_PAD = 40;
export const HISTORY_MAX = 100;
/** the design a draft or a link replaced, until the author keeps or undoes it */
export const BEFORE_KEY = "m3e:doc:before";
export const UI_KEY = "m3e:ui";

export const GUIDE_PX = 7;

/** Material's 4dp grid: a coordinate rounded to it, measured from the screen's corner */
export const GRID = 4;
export const onGrid = (v: number, origin: number) =>
  origin + Math.round((v - origin) / GRID) * GRID;
export const FRAME_MARGIN = PHONE_MARGIN;

export type Gesture =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | {
      kind: "marquee";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      moved: boolean;
    }
  | {
      kind: "frame";
      id: string;
      sx: number;
      sy: number;
      fx: number;
      fy: number;
      groups: { id: string; x: number; y: number }[];
      moved: boolean;
    }
  | {
      kind: "group";
      id: string;
      sx: number;
      sy: number;
      gx: number;
      gy: number;
      moved: boolean;
      overBin: boolean;
      guide?: Guide | null;
    };

/** everything in a document apart from its screens and parts */
export type DocMeta = Omit<Doc, "groups" | "frames">;
/** an undo step: the screens and parts, plus the rest of the document for steps that replaced it all */
export type Snapshot = { groups: Group[]; frames: Frame[]; meta?: DocMeta };

/** The parts a lone one of can be resized on the canvas itself: the controls that carry a size,
 *  and the indicators, whose width is the thing an author reaches for most. */
export const HANDLED = new Set<Kind>([
  "button",
  "iconButton",
  "chip",
  "splitButton",
  "fab",
  "extendedFab",
  "linearProgress",
  "circularProgress",
  "loadingIndicator",
  "slider",
  "carousel",
  "card",
  "box",
  "bottomSheet",
  "image",
  "camera",
  "map",
  "listItem",
  "searchBar",
  "textField",
  "select",
  "switch",
  "divider",
  "topAppBar",
  "bottomNav",
  "tabs",
  "navRail",
  "avatar",
  "segmentedButton",
  "tooltip",
  "menu",
  "banner",
]);
/** parts held by the four points around them: a circle's diameter, a label's height */
export const ROUND = new Set<Kind>([
  "iconButton",
  "chip",
  "splitButton",
  "fab",
  "extendedFab",
  "circularProgress",
  "loadingIndicator",
  "avatar",
]);
/** the button family: sized on the button scale rather than by the bounds their kind is given */
export const BUTTON_LIKE = new Set<Kind>([
  "button",
  "iconButton",
  "chip",
  "splitButton",
  "fab",
  "extendedFab",
]);
/** these are held by their two ends; they have no height of their own to pull on */
export const WIDE = new Set<Kind>([
  "linearProgress",
  "slider",
  "listItem",
  "searchBar",
  "textField",
  "select",
  "switch",
  "divider",
  "topAppBar",
  "bottomNav",
  "tabs",
  "segmentedButton",
  "tooltip",
  "menu",
  "banner",
]);
export const BAR_SIDES = ["left", "right"] as const;
/** a carousel runs the width of the screen, a rail the height of it: only the other measure is pulled on */
export const TALL = new Set<Kind>(["carousel", "navRail"]);
export const TALL_SIDES = ["top", "bottom"] as const;
/** parts with one measure whichever side is pulled; none today, a picture has two */

export function translateSnapshot(snap: Snapshot, lang: Lang): Snapshot {
  return {
    groups: snap.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({
        ...item,
        label: translateDefaultText(item.label, item.kind, "label", lang),
        ...(item.supporting !== undefined && {
          supporting: translateDefaultText(item.supporting, item.kind, "supporting", lang),
        }),
        ...(item.tabs && {
          tabs: item.tabs.map((tab) => ({
            ...tab,
            label: translateDefaultText(tab.label, item.kind, "tab", lang),
          })),
        }),
      })),
    })),
    frames: snap.frames.map((frame) => ({
      ...frame,
      name: translateDefaultFrameName(frame.name, lang),
    })),
  };
}

export const SEED_FRAMES: Frame[] = [{ id: "seedF1", name: "Home", x: 0, y: 0 }];

/** Documents saved before the bars grew their system insets have the navigation
 *  bar flush with the old 80dp bottom; keep it on the bottom edge. */
export function migrateGroups(groups: Group[], frames: Frame[]): Group[] {
  const oldNavH = KIND_SPEC.bottomNav.h - NAV_BAR_H;
  /* a badge was a part of its own once; it is gone, and a sketch that held one loses it */
  const kept = groups
    .map((g) => ({ ...g, items: g.items.filter((it) => (it.kind as string) !== "badge") }))
    .filter((g) => g.items.length > 0);
  /* a menu used to be a part of its own; now it is something a FAB is asked to open */
  let out = kept.map((g) =>
    g.items.some((it) => it.kind === "fabMenu") ? { ...g, items: g.items.map(migrateFabMenu) } : g,
  );
  /* a carousel used to be one box with one caption and one destination; now every card has its own */
  out = out.map((g) =>
    g.items.some((it) => it.kind === "carousel" && (it.label || it.action))
      ? { ...g, items: g.items.map(migrateCarousel) }
      : g,
  );
  /* a picker used to carry a chosen day and time; it shows today and now, so those fields go */
  out = out.map((g) =>
    g.items.some(hasPickerFields) ? { ...g, items: g.items.map(migratePicker) } : g,
  );
  /* a box with its handle on used to stand in for a bottom sheet; the sheet is its own part now */
  out = out.map((g) =>
    g.items.some(isSheetBox) ? { ...g, items: g.items.map(migrateSheetBox) } : g,
  );
  /* a carousel is as wide as the screen it stands on, whatever size that screen is */
  out = out.map((g) => {
    if (!g.items.some((it) => it.kind === "carousel")) return g;
    const f = frames.find((fr) => {
      const r = frameRect(fr);
      return g.x >= r.l - 1 && g.x <= r.r && g.y >= r.t - 1 && g.y <= r.b;
    });
    const w = f ? frameSizeOf(f).w : PHONE_W;
    if (
      g.items.every((it) => it.kind !== "carousel" || (it.size ?? KIND_SPEC.carousel.defSize) === w)
    )
      return g;
    return { ...g, items: g.items.map((it) => (it.kind === "carousel" ? { ...it, size: w } : it)) };
  });
  return out.map((g) => {
    if (g.items.length !== 1 || g.items[0].kind !== "bottomNav") return g;
    const f = frames.find((fr) => {
      const r = frameRect(fr);
      return g.x >= r.l - 1 && g.x <= r.r && g.y === r.b - oldNavH;
    });
    return f ? { ...g, y: frameRect(f).b - KIND_SPEC.bottomNav.h } : g;
  });
}

/** A copy of a unit under fresh ids, moved by (dx, dy). A copied modal rail starts collapsed
 *  and standard: a screen shows one modal rail, and the copy sits inward of the edge the
 *  original remembered. */
export function rekeyed(g: Group, dx: number, dy: number): Group {
  const idMap = new Map(g.items.map((it) => [it.id, uid()]));
  const pos: Record<string, { x: number; y: number }> | undefined = g.pos ? {} : undefined;
  if (pos) for (const it of g.items) pos[idMap.get(it.id)!] = g.pos?.[it.id] ?? { x: 0, y: 0 };
  const items = g.items.map((it) => {
    const copy: Item = { ...structuredClone(it), id: idMap.get(it.id)! };
    if (copy.kind === "navRail" && copy.railModal) {
      copy.railModal = false;
      copy.railExpanded = false;
      delete copy[railExpansionSide];
    }
    return copy;
  });
  return { ...structuredClone(g), id: uid(), x: g.x + dx, y: g.y + dy, pos, items };
}

/** the ids of the copies, with the copy of the part that was primary last, so it stays the one the panel shows */
export function copiedIds(copies: Group[], primaryAt: number): string[] {
  const ids = copies.flatMap((c) => c.items.map((it) => it.id));
  if (primaryAt < 0 || primaryAt >= ids.length) return ids;
  return [...ids.slice(0, primaryAt), ...ids.slice(primaryAt + 1), ids[primaryAt]];
}

/** Seed ids are deterministic so server and client render the same markup. */
/* shown when an edit is refused because the group is locked */
export const lockedGroupMsg = () => t("lockedGroup", getLang());

export const seed = (lang: Lang = getLang()): Group[] => {
  const text = SEED_TEXT[lang];
  let n = 0;
  const sid = () => `seed${++n}`;
  const mk = (k: Kind) => ({ ...makeItem(k), id: sid() });
  const bar = mk("topAppBar");
  const a = mk("button");
  const b = mk("button");
  a.label = text.favorite;
  a.icon = "star";
  b.label = text.share;
  b.icon = "share";
  b.variant = "tonal";
  const rows = [text.inbox, text.starred, text.archive].map((t, i) => {
    const it = mk("listItem");
    it.label = t;
    it.icon = ["inbox", "star", "archive"][i];
    it.supporting = text.supporting;
    return it;
  });
  const nav = mk("bottomNav");
  const fab = mk("fab");
  return [
    { id: sid(), x: 0, y: 0, axis: "x", items: [bar] },
    { id: sid(), x: PHONE_MARGIN, y: 96, axis: "x", items: [a, b] },
    { id: sid(), x: PHONE_MARGIN, y: 184, axis: "y", items: rows },
    {
      id: sid(),
      x: PHONE_W - 56 - PHONE_MARGIN,
      y: PHONE_H - KIND_SPEC.bottomNav.h - 56 - PHONE_MARGIN,
      axis: "x",
      items: [fab],
    },
    { id: sid(), x: 0, y: PHONE_H - KIND_SPEC.bottomNav.h, axis: "x", items: [nav] },
  ];
};

/** The phone version starts with buttons only: that is all it edits. */
export const mobileSeed = (lang: Lang = getLang()): Group[] => {
  const text = SEED_TEXT[lang];
  const mk = (k: Kind) => makeItem(k);
  const a = mk("button");
  const b = mk("button");
  const c = mk("button");
  a.label = text.favorite;
  a.icon = "star";
  b.label = text.share;
  b.icon = "share";
  b.variant = "tonal";
  c.label = text.start;
  c.icon = "arrow_forward";
  return [
    { id: uid(), x: PHONE_MARGIN, y: 120, axis: "x", items: [a, b] },
    { id: uid(), x: PHONE_MARGIN, y: 200, axis: "x", items: [c] },
  ];
};
