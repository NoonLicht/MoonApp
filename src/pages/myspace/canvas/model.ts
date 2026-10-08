/* ============================================================
   Holst — модель документа v3 и геометрия.
   Документ — плоский список объектов в порядке слоёв (первый — самый нижний).
   Координаты всех объектов — мировые; parent лишь связывает с рамкой или группой.
   ============================================================ */

export type ShapeKind =
  | "rect"
  | "rounded"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "hexagon"
  | "parallelogram"
  | "cylinder"
  | "star"
  | "cloud"
  | "arrow"
  | "chat";

export type ObjType =
  | "shape"
  | "text"
  | "sticky"
  | "frame"
  | "group"
  | "line"
  | "stroke"
  | "image"
  | "task"
  | "note"
  | "sticker";

export type Dash = "solid" | "dashed" | "dotted";
export type LineStyle = "straight" | "curve" | "step";
export type Head = "none" | "arrow" | "triangle" | "dot";
export type Side = "t" | "r" | "b" | "l" | "auto";
export type FontFamily = "sans" | "serif" | "mono" | "hand";
export type TaskStatus = "todo" | "inprogress" | "done";

/** конец соединителя: привязан к объекту (id) или свободен (x, y) */
export interface Anchor {
  id?: string;
  side?: Side;
  x?: number;
  y?: number;
}

export interface Obj {
  id: string;
  type: ObjType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  name?: string;
  parent?: string | null;
  locked?: boolean;
  hidden?: boolean;

  /* оформление */
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  sw?: number;
  dash?: Dash;
  opacity?: number;
  radius?: number;
  shadow?: boolean;

  /* текст внутри любого объекта */
  text?: string;
  fs?: number;
  fw?: number;
  italic?: boolean;
  ta?: "left" | "center" | "right";
  va?: "top" | "middle" | "bottom";
  tc?: string;
  ff?: FontFamily;
  /** высота текстового блока подгоняется под содержимое */
  auto?: boolean;

  /* соединитель */
  from?: Anchor;
  to?: Anchor;
  ls?: LineStyle;
  h1?: Head;
  h2?: Head;
  animated?: boolean;

  /* рисунок */
  pts?: [number, number][];
  bw?: number;
  bh?: number;

  /* картинка */
  src?: string;

  /* задача */
  status?: TaskStatus;
  due?: string;
  subtasks?: { text: string; done: boolean }[];

  /* заметка из «Моего пространства» */
  path?: string;
  preview?: string;

  /* стикер */
  emoji?: string;
}

export interface HolstDoc {
  version: 3;
  name: string;
  objs: Obj[];
  viewport?: { x: number; y: number; zoom: number };
  grid?: boolean;
  updatedAt: string;
}

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ───────────── константы ───────────── */

export const SWATCHES = [
  "#ffffff",
  "#fef08a",
  "#fed7aa",
  "#fecaca",
  "#fbcfe8",
  "#e9d5ff",
  "#bfdbfe",
  "#a5f3fc",
  "#bbf7d0",
  "#e5e7eb",
  "#94a3b8",
  "#1f2937",
];
export const INK = [
  "#1c1d2b",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ffffff",
];
export const EMOJIS = ["👍", "❤️", "🎉", "🔥", "⭐", "✅", "❓", "💡", "⚠️", "🚀", "👀", "🎯"];

export const SHAPES: { kind: ShapeKind; ru: string; en: string }[] = [
  { kind: "rect", ru: "Прямоугольник", en: "Rectangle" },
  { kind: "rounded", ru: "Скруглённый", en: "Rounded" },
  { kind: "ellipse", ru: "Эллипс", en: "Ellipse" },
  { kind: "diamond", ru: "Ромб (решение)", en: "Diamond" },
  { kind: "triangle", ru: "Треугольник", en: "Triangle" },
  { kind: "hexagon", ru: "Шестиугольник", en: "Hexagon" },
  { kind: "parallelogram", ru: "Параллелограмм", en: "Parallelogram" },
  { kind: "cylinder", ru: "Цилиндр (база данных)", en: "Cylinder" },
  { kind: "star", ru: "Звезда", en: "Star" },
  { kind: "cloud", ru: "Облако", en: "Cloud" },
  { kind: "arrow", ru: "Стрелка", en: "Arrow" },
  { kind: "chat", ru: "Реплика", en: "Speech" },
];

export const FONTS: Record<FontFamily, string> = {
  sans: 'var(--font-body, "Inter"), system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'var(--font-mono, "JetBrains Mono"), ui-monospace, monospace',
  hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive',
};

export const DEFAULT_SIZE: Record<ObjType, { w: number; h: number }> = {
  shape: { w: 160, h: 100 },
  text: { w: 220, h: 40 },
  sticky: { w: 180, h: 180 },
  frame: { w: 480, h: 340 },
  group: { w: 0, h: 0 },
  line: { w: 0, h: 0 },
  stroke: { w: 0, h: 0 },
  image: { w: 320, h: 200 },
  task: { w: 240, h: 140 },
  note: { w: 220, h: 150 },
  sticker: { w: 56, h: 56 },
};

let seq = 0;
export const uid = (): string =>
  `o${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** Новый объект с разумными значениями по умолчанию. */
export function make(type: ObjType, at: Pt, patch: Partial<Obj> = {}): Obj {
  const s = DEFAULT_SIZE[type];
  const base: Obj = {
    id: uid(),
    type,
    x: Math.round(at.x - (patch.w ?? s.w) / 2),
    y: Math.round(at.y - (patch.h ?? s.h) / 2),
    w: s.w,
    h: s.h,
    rot: 0,
  };
  switch (type) {
    case "shape":
      Object.assign(base, {
        shape: "rounded",
        fill: "#bfdbfe",
        stroke: "#1f2937",
        sw: 2,
        dash: "solid",
        radius: 16,
        fs: 16,
        fw: 500,
        ta: "center",
        va: "middle",
        text: "",
      });
      break;
    case "sticky":
      Object.assign(base, {
        fill: "#fef08a",
        shadow: true,
        fs: 18,
        fw: 500,
        ta: "left",
        va: "top",
        text: "",
        radius: 6,
        ff: "hand",
      });
      break;
    case "text":
      Object.assign(base, { fs: 20, fw: 500, ta: "left", va: "top", text: "", auto: true });
      break;
    case "frame":
      Object.assign(base, {
        name: "Рамка",
        fill: "#ffffff",
        stroke: "#94a3b8",
        sw: 1,
        radius: 12,
        opacity: 1,
      });
      break;
    case "task":
      Object.assign(base, { text: "", status: "todo", subtasks: [], fill: "#ffffff", radius: 14 });
      break;
    case "note":
      Object.assign(base, { fill: "#ffffff", radius: 14 });
      break;
    case "sticker":
      Object.assign(base, { emoji: "👍", fs: 44 });
      break;
    case "line":
      Object.assign(base, {
        stroke: "#8b7bf0",
        sw: 2,
        dash: "solid",
        ls: "curve",
        h1: "none",
        h2: "arrow",
      });
      break;
    case "stroke":
      Object.assign(base, { stroke: "#f59e0b", sw: 4, opacity: 1 });
      break;
    default:
      break;
  }
  return { ...base, ...patch };
}

/* ───────────── геометрия ───────────── */

const rad = (d: number) => (d * Math.PI) / 180;

export const center = (o: Box): Pt => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

export function rotatePt(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p;
  const a = rad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function corners(o: Box & { rot?: number }): Pt[] {
  const c = center(o);
  const r = o.rot ?? 0;
  return [
    { x: o.x, y: o.y },
    { x: o.x + o.w, y: o.y },
    { x: o.x + o.w, y: o.y + o.h },
    { x: o.x, y: o.y + o.h },
  ].map((p) => rotatePt(p, c, r));
}

export function aabbOf(pts: Pt[]): Box {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** габарит объекта с учётом поворота (для линий — по концам) */
export function boundsOf(o: Obj, byId?: Map<string, Obj>): Box {
  if (o.type === "line") {
    const e = lineEnds(o, byId ?? new Map());
    return aabbOf([e.a, e.b]);
  }
  return aabbOf(corners(o));
}

export function unionBox(list: Box[]): Box | null {
  if (list.length === 0) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  const r = Math.max(...list.map((b) => b.x + b.w));
  const b = Math.max(...list.map((b2) => b2.y + b2.h));
  return { x, y, w: r - x, h: b - y };
}

export const boxesTouch = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const boxContains = (outer: Box, p: Pt): boolean =>
  p.x >= outer.x && p.x <= outer.x + outer.w && p.y >= outer.y && p.y <= outer.y + outer.h;

/* ───────────── соединители ───────────── */

export interface End {
  x: number;
  y: number;
  /** единичная нормаль наружу из объекта (куда «смотрит» конец) */
  nx: number;
  ny: number;
}

const SIDE_N: Record<Exclude<Side, "auto">, [number, number]> = {
  t: [0, -1],
  r: [1, 0],
  b: [0, 1],
  l: [-1, 0],
};

export function sidePoint(o: Obj, side: Exclude<Side, "auto">): End {
  const c = center(o);
  const local: Pt =
    side === "t"
      ? { x: c.x, y: o.y }
      : side === "b"
        ? { x: c.x, y: o.y + o.h }
        : side === "l"
          ? { x: o.x, y: c.y }
          : { x: o.x + o.w, y: c.y };
  const p = rotatePt(local, c, o.rot);
  const [nx, ny] = SIDE_N[side];
  const a = rad(o.rot);
  return {
    x: p.x,
    y: p.y,
    nx: nx * Math.cos(a) - ny * Math.sin(a),
    ny: nx * Math.sin(a) + ny * Math.cos(a),
  };
}

/** Какая сторона объекта ближе всего смотрит на точку. */
export function nearestSide(o: Obj, toward: Pt): Exclude<Side, "auto"> {
  const c = center(o);
  const d = rotatePt(toward, c, -o.rot);
  const dx = (d.x - c.x) / Math.max(1, o.w);
  const dy = (d.y - c.y) / Math.max(1, o.h);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "r" : "l";
  return dy > 0 ? "b" : "t";
}

function endOf(a: Anchor | undefined, other: Pt, byId: Map<string, Obj>): End {
  const o = a?.id ? byId.get(a.id) : undefined;
  if (o && o.type !== "line") {
    const side = a?.side && a.side !== "auto" ? a.side : nearestSide(o, other);
    return sidePoint(o, side);
  }
  const p = { x: a?.x ?? 0, y: a?.y ?? 0 };
  const dx = other.x - p.x;
  const dy = other.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: p.x, y: p.y, nx: dx / len, ny: dy / len };
}

export function anchorPoint(a: Anchor | undefined, byId: Map<string, Obj>): Pt {
  const o = a?.id ? byId.get(a.id) : undefined;
  if (o && o.type !== "line") return center(o);
  return { x: a?.x ?? 0, y: a?.y ?? 0 };
}

export function lineEnds(l: Obj, byId: Map<string, Obj>): { a: End; b: End } {
  const pa = anchorPoint(l.from, byId);
  const pb = anchorPoint(l.to, byId);
  return { a: endOf(l.from, pb, byId), b: endOf(l.to, pa, byId) };
}

export interface LineGeom {
  d: string;
  a: End;
  b: End;
  mid: Pt;
  /** направление касательной на концах, для наконечников (в градусах) */
  angA: number;
  angB: number;
}

export function lineGeom(l: Obj, byId: Map<string, Obj>): LineGeom {
  const { a, b } = lineEnds(l, byId);
  const style = l.ls ?? "curve";
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  if (style === "straight") {
    const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    return {
      d: `M${a.x} ${a.y} L${b.x} ${b.y}`,
      a,
      b,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      angA: ang + 180,
      angB: ang,
    };
  }
  if (style === "curve") {
    const k = Math.max(40, Math.min(180, dist * 0.45));
    const c1 = { x: a.x + a.nx * k, y: a.y + a.ny * k };
    const c2 = { x: b.x + b.nx * k, y: b.y + b.ny * k };
    const mid = {
      x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x,
      y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y,
    };
    return {
      d: `M${a.x} ${a.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`,
      a,
      b,
      mid,
      angA: (Math.atan2(a.y - c1.y, a.x - c1.x) * 180) / Math.PI,
      angB: (Math.atan2(b.y - c2.y, b.x - c2.x) * 180) / Math.PI,
    };
  }
  /* ступенчатый: выходим из конца по нормали, затем ломаная под прямыми углами */
  const gap = 24;
  const p1 = { x: a.x + a.nx * gap, y: a.y + a.ny * gap };
  const p2 = { x: b.x + b.nx * gap, y: b.y + b.ny * gap };
  const horizA = Math.abs(a.nx) >= Math.abs(a.ny);
  const horizB = Math.abs(b.nx) >= Math.abs(b.ny);
  const pts: Pt[] = [{ x: a.x, y: a.y }, p1];
  if (horizA && horizB) {
    const mx = (p1.x + p2.x) / 2;
    pts.push({ x: mx, y: p1.y }, { x: mx, y: p2.y });
  } else if (!horizA && !horizB) {
    const my = (p1.y + p2.y) / 2;
    pts.push({ x: p1.x, y: my }, { x: p2.x, y: my });
  } else if (horizA) {
    pts.push({ x: p2.x, y: p1.y });
  } else {
    pts.push({ x: p1.x, y: p2.y });
  }
  pts.push(p2, { x: b.x, y: b.y });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
  const mi = Math.floor(pts.length / 2);
  const mid = {
    x: (pts[mi - 1].x + pts[mi].x) / 2,
    y: (pts[mi - 1].y + pts[mi].y) / 2,
  };
  const last = pts.length - 1;
  return {
    d,
    a,
    b,
    mid,
    angA: (Math.atan2(pts[0].y - pts[1].y, pts[0].x - pts[1].x) * 180) / Math.PI,
    angB:
      (Math.atan2(pts[last].y - pts[last - 1].y, pts[last].x - pts[last - 1].x) * 180) / Math.PI,
  };
}

/* ───────────── привязка (snapping) ───────────── */

export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/**
 * Прилипание перемещаемого блока к краям и центрам остальных объектов.
 * Возвращает поправку к смещению и линии-подсказки.
 */
export function snapMove(
  moving: Box,
  others: Box[],
  threshold: number,
): { dx: number; dy: number; guides: Guide[] } {
  const mx = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const my = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  let bestX: { d: number; at: number; o: Box } | null = null;
  let bestY: { d: number; at: number; o: Box } | null = null;
  for (const o of others) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w];
    const oy = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const a of mx)
      for (const b of ox) {
        const d = b - a;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d)))
          bestX = { d, at: b, o };
      }
    for (const a of my)
      for (const b of oy) {
        const d = b - a;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d)))
          bestY = { d, at: b, o };
      }
  }
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const moved = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  if (bestX) {
    guides.push({
      axis: "x",
      at: bestX.at,
      from: Math.min(moved.y, bestX.o.y),
      to: Math.max(moved.y + moved.h, bestX.o.y + bestX.o.h),
    });
  }
  if (bestY) {
    guides.push({
      axis: "y",
      at: bestY.at,
      from: Math.min(moved.x, bestY.o.x),
      to: Math.max(moved.x + moved.w, bestY.o.x + bestY.o.w),
    });
  }
  return { dx, dy, guides };
}

/* ───────────── выравнивание ───────────── */

export type AlignKind = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Сдвиги для выравнивания набора объектов по общему габариту (или по рамке, если один). */
export function alignDeltas(
  boxes: Map<string, Box>,
  kind: AlignKind,
  within?: Box,
): Map<string, Pt> {
  const all = within ?? unionBox([...boxes.values()]);
  const out = new Map<string, Pt>();
  if (!all) return out;
  for (const [id, b] of boxes) {
    let dx = 0;
    let dy = 0;
    if (kind === "left") dx = all.x - b.x;
    if (kind === "right") dx = all.x + all.w - (b.x + b.w);
    if (kind === "hcenter") dx = all.x + all.w / 2 - (b.x + b.w / 2);
    if (kind === "top") dy = all.y - b.y;
    if (kind === "bottom") dy = all.y + all.h - (b.y + b.h);
    if (kind === "vcenter") dy = all.y + all.h / 2 - (b.y + b.h / 2);
    out.set(id, { x: dx, y: dy });
  }
  return out;
}

/** Равные промежутки между объектами по горизонтали или вертикали. */
export function distributeDeltas(boxes: Map<string, Box>, axis: "x" | "y"): Map<string, Pt> {
  const items = [...boxes.entries()].sort((a, b) => a[1][axis] - b[1][axis]);
  const out = new Map<string, Pt>();
  if (items.length < 3) return out;
  const size = axis === "x" ? "w" : "h";
  const first = items[0][1];
  const last = items[items.length - 1][1];
  const total = last[axis] + last[size] - first[axis];
  const used = items.reduce((s, [, b]) => s + b[size], 0);
  const gap = (total - used) / (items.length - 1);
  let cursor = first[axis];
  for (const [id, b] of items) {
    const delta = cursor - b[axis];
    out.set(id, axis === "x" ? { x: delta, y: 0 } : { x: 0, y: delta });
    cursor += b[size] + gap;
  }
  return out;
}
