/**
 * Вычисления графа заметок без React и canvas — чтобы их можно было тестировать
 * и чтобы на больших хранилищах граф не превращался в O(N²) на каждый кадр.
 *
 *  - limitGraph: при превышении лимита оставляет самые связные узлы;
 *  - repulseGrid: отталкивание только от соседей в радиусе CUTOFF (сетка ячеек);
 *    дальние узлы дают пренебрежимо малую силу (repulsion / d²), поэтому
 *    результат визуально тот же, а стоимость ~ O(N) вместо O(N²).
 */
import type { GraphData } from "@/api/types";

export interface SimBody {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

/** Выше этого числа узлов граф показывает только самые связные. */
export const MAX_GRAPH_NODES = 600;
/** Радиус, дальше которого отталкивание не считается. */
export const CUTOFF = 240;
/** Ниже этого числа узлов подписи рисуются всегда. */
export const LABELS_ALWAYS = 80;

export interface Limited {
  data: GraphData;
  total: number;
  shown: number;
}

export function limitGraph(data: GraphData, max = MAX_GRAPH_NODES): Limited {
  const total = data.nodes.length;
  if (total <= max) return { data, total, shown: total };
  const degree = new Map<string, number>();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const keep = [...data.nodes]
    .map((n, i) => ({ n, i, d: degree.get(n.id) ?? 0 }))
    .sort((a, b) => b.d - a.d || a.i - b.i)
    .slice(0, max);
  const ids = new Set(keep.map((k) => k.n.id));
  return {
    data: {
      nodes: data.nodes.filter((n) => ids.has(n.id)),
      edges: data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    },
    total,
    shown: max,
  };
}

/** Отталкивание + тяготение к центру. Меняет vx/vy; возвращает число обработанных пар. */
export function repulseGrid(
  ns: SimBody[],
  opts: { repulsion: number; centerGravity: number; cx: number; cy: number; minDist: number },
): number {
  const { repulsion, centerGravity, cx, cy, minDist } = opts;
  const cell = CUTOFF;
  const grid = new Map<string, SimBody[]>();
  const key = (gx: number, gy: number): string => gx + "," + gy;
  for (const n of ns) {
    const k = key(Math.floor(n.x / cell), Math.floor(n.y / cell));
    const arr = grid.get(k);
    if (arr) arr.push(n);
    else grid.set(k, [n]);
  }
  let pairs = 0;
  for (const n of ns) {
    if (n.pinned) continue;
    n.vx += (cx - n.x) * centerGravity;
    n.vy += (cy - n.y) * centerGravity;
    const gx = Math.floor(n.x / cell);
    const gy = Math.floor(n.y / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const arr = grid.get(key(gx + ox, gy + oy));
        if (!arr) continue;
        for (const o of arr) {
          if (o === n) continue;
          const dx = n.x - o.x;
          const dy = n.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > CUTOFF * CUTOFF) continue;
          const d = Math.max(Math.sqrt(d2), minDist);
          const f = repulsion / (d * d);
          n.vx += (dx / d) * f;
          n.vy += (dy / d) * f;
          pairs++;
        }
      }
    }
  }
  return pairs;
}
