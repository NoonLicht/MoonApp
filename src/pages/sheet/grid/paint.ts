import type {
  SheetBorderSide,
  SheetCell,
  SheetCellStyle,
  SheetGrid,
  SheetRange,
} from "@/api/apiSheet";
import { colName, type Geo } from "@/pages/sheet/grid/geometry";

export const GRID_LINE = "#E1E1E1";
export const ACCENT = "#107C41";
export const HEADER_BG = "#F3F3F3";
export const HEADER_LINE = "#D4D4D4";
export const HEADER_TEXT = "#444444";

const FAMILY = (n: string): string =>
  `"${n}", Calibri, Carlito, "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

/** Кэш картинок спарклайнов (по тексту SVG): после загрузки просим перерисовать. */
const IMAGES = new Map<string, HTMLImageElement | null>();

function svgImage(svg: string, redraw: () => void): HTMLImageElement | null {
  const hit = IMAGES.get(svg);
  if (hit !== undefined) return hit;
  IMAGES.set(svg, null);
  const img = new Image();
  img.onload = () => {
    IMAGES.set(svg, img);
    redraw();
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  if (IMAGES.size > 400) IMAGES.delete(IMAGES.keys().next().value as string);
  return null;
}

export interface Selection {
  ranges: SheetRange[];
  active: { r: number; c: number };
}

export interface PaintArgs {
  /** Размеры холста в CSS-пикселях. */
  w: number;
  h: number;
  dpr: number;
  grid: SheetGrid;
  geo: Geo;
  /** Смещение прокрутки в CSS-пикселях и масштаб. */
  sx: number;
  sy: number;
  zoom: number;
  headerW: number;
  headerH: number;
  gridlines: boolean;
  headings: boolean;
  rtl: boolean;
  selection: Selection;
  clipboard: { ranges: SheetRange[]; cut: boolean } | null;
  /** Ячейка, которая сейчас правится: её содержимое не рисуем. */
  editing: { r: number; c: number } | null;
  /** Диапазоны, подсвеченные при указании ссылок в формуле: [диапазон, цвет]. */
  refs: [SheetRange, string][];
  /** Пунктирная рамка маркера заполнения при перетаскивании. */
  fillPreview: SheetRange | null;
  redraw: () => void;
}

interface Region {
  /** Окно на экране. */
  x: number;
  y: number;
  w: number;
  h: number;
  scrollX: boolean;
  scrollY: boolean;
  colOk: (c: number) => boolean;
  rowOk: (r: number) => boolean;
}

const key = (r: number, c: number): number => r * 16384 + c;

function dashFor(style: string, z: number): number[] {
  switch (style) {
    case "Dashed":
    case "MediumDashed":
      return [4 * z, 2 * z];
    case "Dotted":
    case "Hair":
      return [1.5 * z, 1.5 * z];
    case "DashDot":
    case "MediumDashDot":
    case "SlantDashDot":
      return [4 * z, 2 * z, 1 * z, 2 * z];
    case "DashDotDot":
    case "MediumDashDotDot":
      return [4 * z, 2 * z, 1 * z, 2 * z, 1 * z, 2 * z];
    default:
      return [];
  }
}

function strokeSide(
  ctx: CanvasRenderingContext2D,
  b: SheetBorderSide,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const style = b[2];
  const wpx = Math.max(1, Math.round(b[0]));
  ctx.strokeStyle = b[1];
  ctx.lineWidth = style === "Double" ? 1 : wpx;
  ctx.setLineDash(dashFor(style, 1));
  const horizontal = y0 === y1;
  const snap = (v: number, w: number): number => Math.round(v) + (w % 2 === 1 ? 0.5 : 0);
  const draw = (dx: number, dy: number): void => {
    ctx.beginPath();
    if (horizontal) {
      const y = snap(y0 + dy, ctx.lineWidth);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    } else {
      const x = snap(x0 + dx, ctx.lineWidth);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.stroke();
  };
  if (style === "Double") {
    draw(-1, -1);
    draw(1, 1);
  } else draw(0, 0);
  ctx.setLineDash([]);
}

/** Значок условного форматирования. */
function paintIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  set: string,
  idx: number,
  n: number,
): void {
  const low = set.toLowerCase();
  const pal3 = ["#D13B2F", "#F2B82E", "#2E9E4F"];
  const color =
    n <= 3
      ? (pal3[idx] ?? "#888")
      : (() => {
          const t = idx / Math.max(1, n - 1);
          const mix = (a: number, b: number): number => Math.round(a * (1 - t) + b * t);
          return `rgb(${mix(0xd1, 0x2e)},${mix(0x3b, 0x9e)},${mix(0x2f, 0x4f)})`;
        })();
  const cx = x + s / 2;
  const cy = y + s / 2;
  const r = s / 2;
  ctx.fillStyle = color;
  if (low.includes("arrow")) {
    ctx.beginPath();
    if (idx + 1 === n) {
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy + 0.1 * r);
      ctx.lineTo(cx - r, cy + 0.1 * r);
    } else if (idx === 0) {
      ctx.moveTo(cx, cy + r);
      ctx.lineTo(cx - r, cy - 0.1 * r);
      ctx.lineTo(cx + r, cy - 0.1 * r);
    } else {
      ctx.moveTo(cx + r, cy);
      ctx.lineTo(cx - 0.1 * r, cy - r);
      ctx.lineTo(cx - 0.1 * r, cy + r);
    }
    ctx.closePath();
    ctx.fill();
  } else if (low.includes("rating") || low.includes("quarter")) {
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
    ctx.stroke();
    const frac = idx / Math.max(1, n - 1);
    ctx.fillStyle = "#2B7CD3";
    ctx.fillRect(x + 2, y + s - 2 - (s - 4) * frac, s - 4, (s - 4) * frac);
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function fontOf(st: SheetCellStyle, z: number): { font: string; px: number } {
  const sup = st.f.v === "Superscript" || st.f.v === "Subscript";
  const px = Math.max(3, ((st.f.z * 96) / 72) * z * (sup ? 0.7 : 1));
  return {
    font: `${st.f.i ? "italic " : ""}${st.f.b ? "bold " : ""}${px.toFixed(2)}px ${FAMILY(st.f.n)}`,
    px,
  };
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(?<=[\s-])/)) {
      const probe = line + word;
      if (line && ctx.measureText(probe.trimEnd()).width > maxW) {
        out.push(line.trimEnd());
        line = word;
      } else line = probe;
      // слово длиннее строки режем по символам
      while (ctx.measureText(line.trimEnd()).width > maxW && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && ctx.measureText(line.slice(0, k)).width > maxW) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function paintGrid(ctx: CanvasRenderingContext2D, a: PaintArgs): void {
  const { w, h, dpr, grid, geo, sx, sy, headerW, headerH, gridlines } = a;
  const Z = a.zoom;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  const fw = geo.frozenX * Z;
  const fh = geo.frozenY * Z;
  const bodyX = headerW + fw;
  const bodyY = headerH + fh;
  const cellMap = new Map<number, SheetCell>();
  for (const c of grid.cells) cellMap.set(key(c.r, c.c), c);
  const mergeAt = new Map<number, SheetRange>();
  for (const m of grid.merges) mergeAt.set(key(m.r0, m.c0), m);
  const covered = (r: number, c: number): boolean => {
    for (const m of grid.merges) if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return true;
    return false;
  };

  const regions: Region[] = [
    {
      x: bodyX,
      y: bodyY,
      w: w - bodyX,
      h: h - bodyY,
      scrollX: true,
      scrollY: true,
      colOk: (c) => c >= geo.fc,
      rowOk: (r) => r >= geo.fr,
    },
  ];
  if (geo.fc > 0)
    regions.push({
      x: headerW,
      y: bodyY,
      w: fw,
      h: h - bodyY,
      scrollX: false,
      scrollY: true,
      colOk: (c) => c < geo.fc,
      rowOk: (r) => r >= geo.fr,
    });
  if (geo.fr > 0)
    regions.push({
      x: bodyX,
      y: headerH,
      w: w - bodyX,
      h: fh,
      scrollX: true,
      scrollY: false,
      colOk: (c) => c >= geo.fc,
      rowOk: (r) => r < geo.fr,
    });
  if (geo.fc > 0 && geo.fr > 0)
    regions.push({
      x: headerW,
      y: headerH,
      w: fw,
      h: fh,
      scrollX: false,
      scrollY: false,
      colOk: (c) => c < geo.fc,
      rowOk: (r) => r < geo.fr,
    });

  for (const rg of regions) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rg.x, rg.y, Math.max(0, rg.w), Math.max(0, rg.h));
    ctx.clip();
    const px = (xs: number): number => headerW + xs * Z - (rg.scrollX ? sx : 0);
    const py = (ys: number): number => headerH + ys * Z - (rg.scrollY ? sy : 0);
    const cols = geo.colList.filter(rg.colOk);
    const rows = geo.rowList.filter(rg.rowOk);
    const cw = (c: number): number => geo.wOf(c) * Z;
    const rh = (r: number): number => geo.hOf(r) * Z;

    // Линии сетки.
    if (gridlines) {
      ctx.strokeStyle = GRID_LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const r of rows) {
        const y = Math.round(py(geo.yOf(r)) + rh(r)) - 0.5;
        ctx.moveTo(rg.x, y);
        ctx.lineTo(rg.x + rg.w, y);
      }
      for (const c of cols) {
        const x = Math.round(px(geo.xOf(c)) + cw(c)) - 0.5;
        ctx.moveTo(x, rg.y);
        ctx.lineTo(x, rg.y + rg.h);
      }
      ctx.stroke();
    }

    // Что рисуется в этом окне: ячейки с записями (якоря объединений — по якорю).
    const visible: { cell: SheetCell; x: number; y: number; w: number; h: number }[] = [];
    for (const cell of grid.cells) {
      if (!rg.rowOk(cell.r) || !rg.colOk(cell.c)) continue;
      if (!geo.cols.has(cell.c) || !geo.rows.has(cell.r)) continue;
      const m = cell.m ? mergeAt.get(key(cell.r, cell.c)) : undefined;
      const x = px(geo.xOf(cell.c));
      const y = py(geo.yOf(cell.r));
      const rect = m ? geo.rect(m.r0, m.c0, m.r1, m.c1) : null;
      visible.push({
        cell,
        x,
        y,
        w: (rect ? rect.w : geo.wOf(cell.c)) * Z,
        h: (rect ? rect.h : geo.hOf(cell.r)) * Z,
      });
    }

    // Заливки (объединённая ячейка закрывает линии сетки внутри).
    for (const v of visible) {
      const fill = v.cell.fl ?? (v.cell.m ? "#FFFFFF" : null);
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(Math.floor(v.x), Math.floor(v.y), Math.ceil(v.w) + 0, Math.ceil(v.h) + 0);
    }

    // Содержимое: гистограммы, значки, флажки, текст, спарклайны.
    for (const v of visible) {
      const st = grid.styles[v.cell.s];
      if (!st) continue;
      drawContent(ctx, a, cellMap, covered, v, st, rg);
    }

    // Границы.
    for (const v of visible) {
      const st = grid.styles[v.cell.s];
      if (!st) continue;
      const b = st.b;
      const x0 = Math.round(v.x);
      const y0 = Math.round(v.y);
      const x1 = Math.round(v.x + v.w);
      const y1 = Math.round(v.y + v.h);
      if (b.t) strokeSide(ctx, b.t, x0, y0, x1, y0);
      if (b.b) strokeSide(ctx, b.b, x0, y1 - 1, x1, y1 - 1);
      if (b.l) strokeSide(ctx, b.l, x0, y0, x0, y1);
      if (b.r) strokeSide(ctx, b.r, x1 - 1, y0, x1 - 1, y1);
      if (b.d) {
        ctx.strokeStyle = b.d[1];
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      if (b.u) {
        ctx.strokeStyle = b.u[1];
        ctx.beginPath();
        ctx.moveTo(x0, y1);
        ctx.lineTo(x1, y0);
        ctx.stroke();
      }
    }

    // Указатели: красный уголок примечания, кнопка фильтра.
    for (const v of visible) {
      if (v.cell.cm) {
        ctx.fillStyle = "#D13438";
        ctx.beginPath();
        ctx.moveTo(v.x + v.w, v.y);
        ctx.lineTo(v.x + v.w - 6, v.y);
        ctx.lineTo(v.x + v.w, v.y + 6);
        ctx.closePath();
        ctx.fill();
      }
      if (v.cell.flt) {
        const s = Math.min(Math.max(10, v.h - 4), 18);
        const bx = v.x + v.w - s - 2;
        const by = v.y + v.h - s - 2;
        ctx.fillStyle = "#FAFAFA";
        ctx.fillRect(bx, by, s, s);
        ctx.strokeStyle = "#AAAAAA";
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, s - 1, s - 1);
        ctx.fillStyle = v.cell.flt === 2 ? ACCENT : "#444";
        ctx.beginPath();
        if (v.cell.flt === 2) {
          ctx.moveTo(bx + 3, by + 4);
          ctx.lineTo(bx + s - 3, by + 4);
          ctx.lineTo(bx + s / 2 + 1, by + s / 2 + 1);
          ctx.lineTo(bx + s / 2 + 1, by + s - 3);
          ctx.lineTo(bx + s / 2 - 1, by + s - 4);
          ctx.lineTo(bx + s / 2 - 1, by + s / 2 + 1);
        } else {
          ctx.moveTo(bx + s / 2 - 3.5, by + s / 2 - 1.5);
          ctx.lineTo(bx + s / 2 + 3.5, by + s / 2 - 1.5);
          ctx.lineTo(bx + s / 2, by + s / 2 + 2.5);
        }
        ctx.closePath();
        ctx.fill();
      }
    }

    // Выделение и рамки поверх.
    paintOverlays(ctx, a, rg, px, py);
    ctx.restore();
  }

  if (a.headings) paintHeaders(ctx, a);
}

function drawContent(
  ctx: CanvasRenderingContext2D,
  a: PaintArgs,
  cellMap: Map<number, SheetCell>,
  covered: (r: number, c: number) => boolean,
  v: { cell: SheetCell; x: number; y: number; w: number; h: number },
  st: SheetCellStyle,
  rg: Region,
): void {
  const { cell } = v;
  const Z = a.zoom;
  const geo = a.geo;
  if (a.editing && a.editing.r === cell.r && a.editing.c === cell.c) return;
  const px = (xs: number): number => a.headerW + xs * Z - (rg.scrollX ? a.sx : 0);
  // Гистограмма.
  if (cell.bar) {
    const [frac, color, grad] = cell.bar;
    const bx = v.x + 2;
    const by = v.y + 2;
    const bw = Math.max(0, (v.w - 4) * frac);
    const bh = v.h - 4;
    if (grad) {
      const g = ctx.createLinearGradient(bx, 0, bx + Math.max(1, bw), 0);
      g.addColorStop(0, color);
      g.addColorStop(1, "#ffffff");
      ctx.fillStyle = g;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, Math.max(0, bw - 1), bh - 1);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(bx, by, bw, bh);
    }
  }
  let textLeft = v.x;
  if (cell.ic) {
    const s = 12 * Z;
    paintIcon(ctx, v.x + 2, v.y + v.h / 2 - s / 2, s, cell.ic[0], cell.ic[1], cell.ic[2]);
    textLeft += 15 * Z;
  }
  if (cell.ck !== undefined) {
    const s = Math.min(24, Math.max(8, 13 * Z));
    const bx = v.x + v.w / 2 - s / 2;
    const by = v.y + v.h / 2 - s / 2;
    ctx.fillStyle = cell.ck ? ACCENT : "#fff";
    ctx.strokeStyle = cell.ck ? ACCENT : "#6e6e6e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, s, s, 2);
    ctx.fill();
    ctx.stroke();
    if (cell.ck) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1.5, s / 8);
      ctx.beginPath();
      ctx.moveTo(bx + s * 0.22, by + s * 0.52);
      ctx.lineTo(bx + s * 0.43, by + s * 0.72);
      ctx.lineTo(bx + s * 0.78, by + s * 0.3);
      ctx.stroke();
    }
    return;
  }
  if (cell.sp) {
    const img = svgImage(cell.sp, a.redraw);
    if (img) ctx.drawImage(img, v.x + 3, v.y + 3, v.w - 6, v.h - 6);
  }
  if (cell.pic) {
    ctx.fillStyle = "#E6EEF7";
    ctx.fillRect(v.x + 2, v.y + 2, v.w - 4, v.h - 4);
  }
  if (cell.t === undefined || cell.t === "") return;

  const { font, px: fpx } = fontOf(st, Z);
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const pad = 2.5 * Z;
  const indent = st.a.in * 9 * Z;
  const filterSpace = cell.flt ? 14 * Z : 0;
  const avail = v.w - (textLeft - v.x) - filterSpace;
  let text = cell.t;
  const numeric = cell.n === 1 || cell.k === "n";
  let halign = st.a.h;
  if (halign === "General") halign = cell.k === "b" || cell.k === "e" ? "Center" : numeric ? "Right" : "Left";
  const color = cell.tc ?? "#000000";
  ctx.fillStyle = color;

  // Повтор-заполнение формата `*x`.
  if (cell.fc && text.includes("\u0000")) {
    const [a0, a1] = text.split("\u0000");
    const base = ctx.measureText(a0 + a1).width;
    const cwid = Math.max(1, ctx.measureText(cell.fc).width);
    const n = Math.max(0, Math.floor((avail - 2 * pad - base) / cwid));
    text = a0 + cell.fc.repeat(n) + a1;
  }

  const rotated = st.a.r !== 0 && st.a.r !== 255;
  const vertical = st.a.v;
  const lineH = fpx * 1.22;

  const placeY = (blockH: number): number => {
    switch (vertical) {
      case "Top":
        return v.y + 1 + (lineH - fpx) / 2 + fpx * 0.82;
      case "Center":
      case "Distributed":
      case "Justify":
        return v.y + (v.h - blockH) / 2 + (lineH - fpx) / 2 + fpx * 0.82;
      default:
        return v.y + v.h - 2 - blockH + (lineH - fpx) / 2 + fpx * 0.82 - (lineH - fpx) / 2;
    }
  };

  const drawLine = (s: string, x: number, y: number, align: string, clipL?: number, clipR?: number): void => {
    ctx.save();
    if (clipL !== undefined && clipR !== undefined) {
      ctx.beginPath();
      ctx.rect(clipL, v.y, Math.max(0, clipR - clipL), v.h);
      ctx.clip();
    } else {
      ctx.beginPath();
      ctx.rect(v.x, v.y, v.w, v.h);
      ctx.clip();
    }
    let sup = 0;
    if (st.f.v === "Superscript") sup = -fpx * 0.35;
    if (st.f.v === "Subscript") sup = fpx * 0.2;
    ctx.textAlign = align === "Right" ? "right" : align === "Center" ? "center" : "left";
    ctx.fillStyle = color;
    ctx.fillText(s, x, y + sup);
    const width = ctx.measureText(s).width;
    const x0 = align === "Right" ? x - width : align === "Center" ? x - width / 2 : x;
    if (st.f.u !== "None") {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, fpx / 14);
      const uy = y + sup + fpx * 0.12;
      ctx.beginPath();
      ctx.moveTo(x0, uy);
      ctx.lineTo(x0 + width, uy);
      if (st.f.u.startsWith("Double")) {
        ctx.moveTo(x0, uy + 2);
        ctx.lineTo(x0 + width, uy + 2);
      }
      ctx.stroke();
    }
    if (st.f.s) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, fpx / 14);
      const sy2 = y + sup - fpx * 0.28;
      ctx.beginPath();
      ctx.moveTo(x0, sy2);
      ctx.lineTo(x0 + width, sy2);
      ctx.stroke();
    }
    ctx.restore();
  };

  if (rotated) {
    const deg = st.a.r;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x, v.y, v.w, v.h);
    ctx.clip();
    const cxm = v.x + v.w / 2;
    const cym = v.y + v.h / 2;
    ctx.translate(cxm, cym);
    ctx.rotate((-deg * Math.PI) / 180);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text.split("\n")[0], 0, 0);
    ctx.restore();
    return;
  }
  if (st.a.r === 255) {
    // Вертикальный текст: буквы друг под другом.
    const chars = [...text.replace(/\n/g, "")];
    const total = chars.length * lineH;
    let y = placeY(total) - lineH * 0.0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x, v.y, v.w, v.h);
    ctx.clip();
    ctx.textAlign = "center";
    for (const ch of chars) {
      ctx.fillText(ch, v.x + v.w / 2, y);
      y += lineH;
    }
    ctx.restore();
    return;
  }

  const wrap = st.a.w || halign === "Justify";
  if (wrap) {
    const maxW = Math.max(4, avail - 2 * pad - indent);
    const lines = wrapLines(ctx, text, maxW);
    const block = lines.length * lineH;
    const y0 = placeY(block);
    const align = halign === "Justify" || halign === "Distributed" ? "Left" : halign;
    lines.forEach((ln, i) => {
      const x =
        align === "Right"
          ? v.x + v.w - pad - filterSpace
          : align === "Center" || align === "CenterAcross"
            ? textLeft + (avail + 0) / 2
            : textLeft + pad + indent;
      drawLine(ln, x, y0 + i * lineH, align);
    });
    return;
  }

  let first = text.split("\n")[0];
  let width = ctx.measureText(first).width;
  // Сжать по размеру ячейки.
  if (st.a.sh && width > avail - 2 * pad - indent && width > 0) {
    const k = Math.max(0.3, (avail - 2 * pad - indent) / width);
    ctx.font = font.replace(/([\d.]+)px/, (_m, p: string) => `${(Number(p) * k).toFixed(2)}px`);
    width = ctx.measureText(first).width;
  } else if (numeric && width > avail - 2 * pad && halign !== "Fill") {
    // Числа и даты не переносятся и не вылезают: ####.
    const cwid = Math.max(1, ctx.measureText("0").width);
    const n = Math.max(1, Math.floor((avail - 2 * pad) / cwid));
    first = "#".repeat(n);
    width = ctx.measureText(first).width;
  }
  const y = placeY(lineH);
  if (halign === "Fill") {
    const unit = Math.max(1, ctx.measureText(first).width);
    const n = Math.max(1, Math.floor((avail - 2 * pad) / unit));
    drawLine(first.repeat(n), textLeft + pad + indent, y, "Left");
    return;
  }
  // Переполнение в пустые соседние ячейки (только у текста).
  const emptyNeighbour = (c: number): boolean => {
    const k = cellMap.get(key(cell.r, c));
    return !(k && (k.t || k.m || k.ck !== undefined || k.sp)) && !covered(cell.r, c);
  };
  let left = v.x;
  let right = v.x + v.w;
  const canSpill = !numeric && !cell.m && !cell.flt && Math.abs(st.a.r) !== 90;
  if (halign === "CenterAcross") {
    // Выравнивание по центру выделения: по пустым ячейкам справа с тем же выравниванием.
    let c = cell.c;
    while (c + 1 <= geo.maxCol && emptyNeighbour(c + 1)) {
      const k = cellMap.get(key(cell.r, c + 1));
      if (!k || grid_style_h(a.grid, k) !== "CenterAcross") break;
      c++;
    }
    right = px(geo.xOf(c) + geo.wOf(c) * 1) ;
    right = Math.max(right, v.x + v.w);
  } else if (canSpill) {
    if (halign === "Left" || halign === "Center") {
      let c = cell.c + 1;
      while (right - v.x < width + 2 * pad + indent && c <= geo.maxCol && emptyNeighbour(c)) {
        right = px(geo.xOf(c) + geo.wOf(c));
        c++;
      }
    }
    if (halign === "Right" || halign === "Center") {
      let c = cell.c - 1;
      while (v.x + v.w - left < width + 2 * pad && c >= geo.minCol && emptyNeighbour(c)) {
        left = px(geo.xOf(c));
        c--;
      }
    }
  }
  const spanL = left;
  const spanR = right;
  let x: number;
  let align: string;
  if (halign === "Right") {
    x = v.x + v.w - pad - filterSpace;
    align = "Right";
  } else if (halign === "Center" || halign === "CenterAcross") {
    x = (spanL + spanR - filterSpace) / 2 + (textLeft - v.x) / 2;
    align = "Center";
  } else {
    x = textLeft + pad + indent;
    align = "Left";
  }
  drawLine(first, x, y, align, spanL, spanR);
  ctx.font = font;
}

function grid_style_h(g: SheetGrid, c: SheetCell): string {
  return g.styles[c.s]?.a.h ?? "General";
}

function rangeRect(
  a: PaintArgs,
  rg: Region,
  r: SheetRange,
  px: (x: number) => number,
  py: (y: number) => number,
): { x: number; y: number; w: number; h: number } | null {
  const geo = a.geo;
  const Z = a.zoom;
  // Диапазон целых строк/столбцов тянем на всё окно.
  const rect = geo.rect(r.r0, r.c0, r.r1, r.c1);
  const x = px(rect.x);
  const y = py(rect.y);
  let wpx = rect.w * Z;
  let hpx = rect.h * Z;
  if (r.c1 >= 16383 && r.c0 === 0) wpx = 1e6;
  if (r.r1 >= 1048575 && r.r0 === 0) hpx = 1e6;
  void rg;
  return { x, y, w: wpx, h: hpx };
}

function paintOverlays(
  ctx: CanvasRenderingContext2D,
  a: PaintArgs,
  rg: Region,
  px: (x: number) => number,
  py: (y: number) => number,
): void {
  const geo = a.geo;
  const Z = a.zoom;
  const sel = a.selection;
  const activeRect = (): { x: number; y: number; w: number; h: number } => {
    const m = a.grid.merges.find(
      (mm) =>
        sel.active.r >= mm.r0 && sel.active.r <= mm.r1 && sel.active.c >= mm.c0 && sel.active.c <= mm.c1,
    );
    const r = m
      ? geo.rect(m.r0, m.c0, m.r1, m.c1)
      : geo.rect(sel.active.r, sel.active.c, sel.active.r, sel.active.c);
    return { x: px(r.x), y: py(r.y), w: r.w * Z, h: r.h * Z };
  };
  const act = activeRect();
  // Подсветка указываемых в формуле диапазонов.
  for (const [r, col] of a.refs) {
    const rr = rangeRect(a, rg, r, px, py);
    if (!rr) continue;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.strokeRect(rr.x + 1, rr.y + 1, rr.w - 2, rr.h - 2);
    ctx.fillStyle = `${col}22`;
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
  }
  // Заливка выделения вокруг активной ячейки.
  const multi = sel.ranges.length > 1 || sel.ranges[0].r0 !== sel.ranges[0].r1 || sel.ranges[0].c0 !== sel.ranges[0].c1;
  if (multi) {
    for (const r of sel.ranges) {
      const rr = rangeRect(a, rg, r, px, py);
      if (!rr) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rr.x, rr.y, rr.w, rr.h);
      ctx.rect(act.x, act.y, act.w, act.h);
      ctx.clip("evenodd");
      ctx.fillStyle = "rgba(16,124,65,0.14)";
      ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
      ctx.restore();
    }
  }
  // Рамка выделения.
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  for (const r of sel.ranges) {
    const rr = rangeRect(a, rg, r, px, py);
    if (!rr) continue;
    ctx.strokeRect(rr.x + 0.5, rr.y + 0.5, Math.max(1, rr.w - 1), Math.max(1, rr.h - 1));
  }
  // Активная ячейка в нескольких областях обводится тоньше.
  if (multi) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(act.x + 2, act.y + 2, Math.max(1, act.w - 4), Math.max(1, act.h - 4));
  }
  // Маркер заполнения.
  const last = sel.ranges[sel.ranges.length - 1];
  if (last && !a.editing) {
    const rr = rangeRect(a, rg, last, px, py);
    if (rr && rr.w < 1e5 && rr.h < 1e5) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(rr.x + rr.w - 4, rr.y + rr.h - 4, 7, 7);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(rr.x + rr.w - 3.5, rr.y + rr.h - 3.5, 6, 6);
    }
  }
  if (a.fillPreview) {
    const rr = rangeRect(a, rg, a.fillPreview, px, py);
    if (rr) {
      ctx.strokeStyle = "#444";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(rr.x + 0.5, rr.y + 0.5, rr.w - 1, rr.h - 1);
      ctx.setLineDash([]);
    }
  }
  // Бегущая рамка скопированного диапазона.
  if (a.clipboard) {
    for (const r of a.clipboard.ranges) {
      const rr = rangeRect(a, rg, r, px, py);
      if (!rr) continue;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(rr.x + 1, rr.y + 1, rr.w - 2, rr.h - 2);
      ctx.setLineDash([]);
    }
  }
}

function paintHeaders(ctx: CanvasRenderingContext2D, a: PaintArgs): void {
  const { w, h, headerW, headerH, geo, sx, sy, zoom: Z } = a;
  const sel = a.selection;
  const selCol = (c: number): boolean => sel.ranges.some((r) => c >= r.c0 && c <= r.c1);
  const selRow = (r0: number): boolean => sel.ranges.some((r) => r0 >= r.r0 && r0 <= r.r1);
  const wholeCol = (c: number): boolean =>
    sel.ranges.some((r) => c >= r.c0 && c <= r.c1 && r.r0 === 0 && r.r1 >= 1048575);
  const wholeRow = (r0: number): boolean =>
    sel.ranges.some((r) => r0 >= r.r0 && r0 <= r.r1 && r.c0 === 0 && r.c1 >= 16383);
  const fs = Math.max(9, Math.min(14, 11 * Z));
  ctx.font = `${fs}px "Segoe UI", Calibri, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fw = geo.frozenX * Z;
  const fh = geo.frozenY * Z;

  // Заголовки столбцов.
  ctx.save();
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, 0, w, headerH);
  for (const c of geo.colList) {
    const frozen = c < geo.fc;
    const x = headerW + geo.xOf(c) * Z - (frozen ? 0 : sx);
    const cw = geo.wOf(c) * Z;
    if (!frozen && x + cw < headerW + fw) continue;
    if (x > w) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(frozen ? headerW : headerW + fw, 0, frozen ? fw : w, headerH);
    ctx.clip();
    const whole = wholeCol(c);
    const on = selCol(c);
    if (on) {
      ctx.fillStyle = whole ? ACCENT : "#CAEAD8";
      ctx.fillRect(x, 0, cw, headerH);
    }
    ctx.strokeStyle = HEADER_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x + cw) - 0.5, 0);
    ctx.lineTo(Math.round(x + cw) - 0.5, headerH);
    ctx.stroke();
    ctx.fillStyle = whole ? "#fff" : on ? "#0B5D31" : HEADER_TEXT;
    if (on) ctx.font = `600 ${fs}px "Segoe UI", Calibri, Arial, sans-serif`;
    ctx.fillText(colName(c), x + cw / 2, headerH / 2 + 1);
    if (on) ctx.font = `${fs}px "Segoe UI", Calibri, Arial, sans-serif`;
    if (on && !whole) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(x, headerH - 2, cw, 2);
    }
    ctx.restore();
  }
  ctx.strokeStyle = HEADER_LINE;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(w, headerH - 0.5);
  ctx.stroke();
  ctx.restore();

  // Заголовки строк.
  ctx.save();
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, 0, headerW, h);
  for (const r of geo.rowList) {
    const frozen = r < geo.fr;
    const y = headerH + geo.yOf(r) * Z - (frozen ? 0 : sy);
    const rh = geo.hOf(r) * Z;
    if (!frozen && y + rh < headerH + fh) continue;
    if (y > h) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, frozen ? headerH : headerH + fh, headerW, frozen ? fh : h);
    ctx.clip();
    const whole = wholeRow(r);
    const on = selRow(r);
    if (on) {
      ctx.fillStyle = whole ? ACCENT : "#CAEAD8";
      ctx.fillRect(0, y, headerW, rh);
    }
    ctx.strokeStyle = HEADER_LINE;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y + rh) - 0.5);
    ctx.lineTo(headerW, Math.round(y + rh) - 0.5);
    ctx.stroke();
    ctx.fillStyle = whole ? "#fff" : on ? "#0B5D31" : HEADER_TEXT;
    if (on) ctx.font = `600 ${fs}px "Segoe UI", Calibri, Arial, sans-serif`;
    ctx.fillText(String(r + 1), headerW / 2, y + rh / 2 + 1);
    if (on) ctx.font = `${fs}px "Segoe UI", Calibri, Arial, sans-serif`;
    if (on && !whole) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(headerW - 2, y, 2, rh);
    }
    ctx.restore();
  }
  ctx.strokeStyle = HEADER_LINE;
  ctx.beginPath();
  ctx.moveTo(headerW - 0.5, 0);
  ctx.lineTo(headerW - 0.5, h);
  ctx.stroke();
  ctx.restore();

  // Левый верхний угол («выделить всё»).
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, 0, headerW, headerH);
  ctx.fillStyle = "#B8B8B8";
  ctx.beginPath();
  ctx.moveTo(headerW - 4, headerH - 14);
  ctx.lineTo(headerW - 4, headerH - 4);
  ctx.lineTo(headerW - 14, headerH - 4);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = HEADER_LINE;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(headerW, headerH - 0.5);
  ctx.moveTo(headerW - 0.5, 0);
  ctx.lineTo(headerW - 0.5, headerH);
  ctx.stroke();
}
