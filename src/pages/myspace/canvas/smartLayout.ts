import dagre from "dagre";
import type { Obj } from "@/pages/myspace/canvas/model";

const SKIP = new Set(["line", "group", "frame", "stroke"]);

export type LayoutDir = "LR" | "TB";

/**
 * Красивая раскладка схемы по связям: цепочки и деревья (от элемента идут связи, от тех — следующие)
 * раскладываются по уровням, несвязанные группы ложатся рядом отдельными блоками,
 * одиночные элементы — аккуратной сеткой ниже. Сами соединители не трогаются: они привязаны к объектам.
 * ids — какие объекты упорядочить (null — все верхнего уровня).
 */
export function layoutGraph(objs: Obj[], ids: string[] | null, dir: LayoutDir = "LR"): Obj[] {
  const pick = ids ? new Set(ids) : null;
  const nodes = objs.filter((o) => !SKIP.has(o.type) && !o.parent && (!pick || pick.has(o.id)));
  if (nodes.length < 2) return objs;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: [string, string][] = [];
  for (const l of objs) {
    if (l.type !== "line") continue;
    const a = l.from?.id;
    const b = l.to?.id;
    if (a && b && a !== b && byId.has(a) && byId.has(b)) edges.push([a, b]);
  }

  // компоненты связности
  const parent = new Map<string, string>(nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of edges) parent.set(find(a), find(b));
  const comps = new Map<string, Obj[]>();
  for (const n of nodes) {
    const r = find(n.id);
    comps.set(r, [...(comps.get(r) ?? []), n]);
  }

  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const pos = new Map<string, { x: number; y: number }>();
  const GAP = 90;
  const MAX_ROW = 2600;

  // связные блоки — крупные первыми
  const linked = [...comps.values()]
    .filter((c) => c.length > 1)
    .sort((a, b) => b.length - a.length);
  const lonely = [...comps.values()]
    .filter((c) => c.length === 1)
    .map((c) => c[0])
    .sort((a, b) => a.y - b.y || a.x - b.x);

  let cx = minX;
  let cy = minY;
  let rowH = 0;
  for (const comp of linked) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: dir, nodesep: 40, ranksep: 80, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    comp.forEach((n) => g.setNode(n.id, { width: n.w, height: n.h }));
    const inComp = new Set(comp.map((n) => n.id));
    edges.forEach(([a, b]) => {
      if (inComp.has(a) && inComp.has(b)) g.setEdge(a, b);
    });
    dagre.layout(g);
    const gw = g.graph().width ?? 0;
    const gh = g.graph().height ?? 0;
    if (cx > minX && cx - minX + gw > MAX_ROW) {
      cx = minX;
      cy += rowH + GAP;
      rowH = 0;
    }
    for (const n of comp) {
      const p = g.node(n.id);
      pos.set(n.id, { x: Math.round(cx + p.x - n.w / 2), y: Math.round(cy + p.y - n.h / 2) });
    }
    cx += gw + GAP;
    rowH = Math.max(rowH, gh);
  }

  // одиночки — сеткой под схемами
  if (lonely.length) {
    const cw = Math.max(...lonely.map((n) => n.w)) + 40;
    const ch = Math.max(...lonely.map((n) => n.h)) + 40;
    const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(lonely.length))));
    const top = linked.length ? cy + rowH + GAP : minY;
    lonely.forEach((n, i) => {
      pos.set(n.id, {
        x: Math.round(minX + (i % cols) * cw),
        y: Math.round(top + Math.floor(i / cols) * ch),
      });
    });
  }

  return objs.map((o) => {
    const p = pos.get(o.id);
    return p ? { ...o, x: p.x, y: p.y } : o;
  });
}
