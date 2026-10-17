import type { SheetGrid, SheetRange } from "@/api/apiSheet";

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;
/** Высота ряда заголовков столбцов. */
export const HEADER_H = 22;
/** Минимальная ширина колонки заголовков строк. */
export const HEADER_W_MIN = 40;

/** Номер столбца → буквы: 0 → A, 26 → AA. */
export function colName(c: number): string {
  let n = c;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Буквы → номер столбца (A → 0); null, если это не буквы столбца. */
export function colIndex(s: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(s)) return null;
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1 < MAX_COLS ? n - 1 : null;
}

export const a1 = (r: number, c: number): string => `${colName(c)}${r + 1}`;

export function rangeA1(r: SheetRange | { r0: number; c0: number; r1: number; c1: number }): string {
  return r.r0 === r.r1 && r.c0 === r.c1 ? a1(r.r0, r.c0) : `${a1(r.r0, r.c0)}:${a1(r.r1, r.c1)}`;
}

export interface Pos {
  x: number;
  w: number;
}

/**
 * Быстрый доступ к геометрии окна: положение и ширина столбцов, положение и высота строк
 * (в пикселях листа при масштабе 100%), а также поиск ячейки по точке.
 */
export class Geo {
  readonly cols = new Map<number, Pos>();
  readonly rows = new Map<number, Pos>();
  /** Индексы по возрастанию: для поиска по координате. */
  readonly colList: number[];
  readonly rowList: number[];
  readonly fr: number;
  readonly fc: number;
  readonly frozenX: number;
  readonly frozenY: number;

  constructor(g: SheetGrid) {
    for (const [c, x, w] of g.cols) this.cols.set(c, { x, w });
    for (const [r, y, h] of g.rows) this.rows.set(r, { x: y, w: h });
    this.colList = [...this.cols.keys()].sort((a, b) => a - b);
    this.rowList = [...this.rows.keys()].sort((a, b) => a - b);
    [this.fr, this.fc] = g.freeze;
    this.frozenX = g.frozenX;
    this.frozenY = g.frozenY;
  }

  /** Столбец, в который попадает координата листа x (среди столбцов окна); null — левее/правее окна. */
  colAt(x: number): number | null {
    const l = this.colList;
    for (let i = l.length - 1; i >= 0; i--) {
      const p = this.cols.get(l[i]);
      if (p && x >= p.x) return x < p.x + p.w ? l[i] : i === l.length - 1 ? null : l[i];
    }
    return null;
  }

  rowAt(y: number): number | null {
    const l = this.rowList;
    for (let i = l.length - 1; i >= 0; i--) {
      const p = this.rows.get(l[i]);
      if (p && y >= p.x) return y < p.x + p.w ? l[i] : i === l.length - 1 ? null : l[i];
    }
    return null;
  }

  /** Левый край столбца c; для столбцов вне окна — за пределами экрана. */
  xOf(c: number): number {
    const p = this.cols.get(c);
    if (p) return p.x;
    const first = this.colList[0];
    const last = this.colList[this.colList.length - 1];
    if (first === undefined) return 0;
    if (c < first) return (this.cols.get(first)?.x ?? 0) - (first - c) * 64;
    const lp = this.cols.get(last);
    return (lp ? lp.x + lp.w : 0) + (c - last - 1) * 64;
  }

  yOf(r: number): number {
    const p = this.rows.get(r);
    if (p) return p.x;
    const first = this.rowList[0];
    const last = this.rowList[this.rowList.length - 1];
    if (first === undefined) return 0;
    if (r < first) return (this.rows.get(first)?.x ?? 0) - (first - r) * 20;
    const lp = this.rows.get(last);
    return (lp ? lp.x + lp.w : 0) + (r - last - 1) * 20;
  }

  wOf(c: number): number {
    return this.cols.get(c)?.w ?? 64;
  }

  hOf(r: number): number {
    return this.rows.get(r)?.w ?? 20;
  }

  /** Прямоугольник диапазона в координатах листа. */
  rect(r0: number, c0: number, r1: number, c1: number): { x: number; y: number; w: number; h: number } {
    const x = this.xOf(c0);
    const y = this.yOf(r0);
    return { x, y, w: this.xOf(c1) + this.wOf(c1) - x, h: this.yOf(r1) + this.hOf(r1) - y };
  }

  get minRow(): number {
    return this.rowList[0] ?? 0;
  }
  get maxRow(): number {
    return this.rowList[this.rowList.length - 1] ?? 0;
  }
  get minCol(): number {
    return this.colList[0] ?? 0;
  }
  get maxCol(): number {
    return this.colList[this.colList.length - 1] ?? 0;
  }
}
