import { describe, it, expect } from "vitest";
import { limitGraph, repulseGrid, CUTOFF, type SimBody } from "../src/pages/myspace/lib/graphSim";

/** Расчёты графа заметок: лимит узлов по связности и отталкивание по сетке. */
const body = (id: string, x: number, y: number): SimBody => ({
  id,
  x,
  y,
  vx: 0,
  vy: 0,
  pinned: false,
});

describe("limitGraph", () => {
  const mk = (n: number) => ({
    nodes: Array.from({ length: n }, (_, i) => ({ id: "n" + i, label: "n" + i, type: "note" })),
    edges: [] as { source: string; target: string }[],
  });

  it("малый граф возвращается как есть", () => {
    const g = mk(10);
    const r = limitGraph(g as never, 600);
    expect(r.data).toBe(g);
    expect(r.shown).toBe(10);
  });

  it("большой граф урезается до самых связных узлов, рёбра чистятся", () => {
    const g = mk(50);
    // n7 — хаб, n8 и n9 — по одной связи, остальные одиночки
    g.edges.push(
      { source: "n7", target: "n8" },
      { source: "n7", target: "n9" },
      { source: "n7", target: "n20" },
      { source: "n30", target: "n31" },
    );
    const r = limitGraph(g as never, 4);
    const ids = r.data.nodes.map((n) => n.id);
    expect(ids).toContain("n7");
    expect(r.total).toBe(50);
    expect(r.shown).toBe(4);
    expect(r.data.nodes).toHaveLength(4);
    for (const e of r.data.edges) {
      expect(ids).toContain(e.source);
      expect(ids).toContain(e.target);
    }
  });
});

describe("repulseGrid", () => {
  const opts = { repulsion: 600, centerGravity: 0, cx: 0, cy: 0, minDist: 30 };

  it("близкие узлы расталкиваются в разные стороны", () => {
    const a = body("a", 0, 0);
    const b = body("b", 50, 0);
    repulseGrid([a, b], opts);
    expect(a.vx).toBeLessThan(0);
    expect(b.vx).toBeGreaterThan(0);
  });

  it("узлы дальше радиуса отсечения не влияют друг на друга", () => {
    const a = body("a", 0, 0);
    const b = body("b", CUTOFF + 50, 0);
    const pairs = repulseGrid([a, b], opts);
    expect(pairs).toBe(0);
    expect(a.vx).toBe(0);
  });

  it("закреплённый узел не получает скорость", () => {
    const a = body("a", 0, 0);
    a.pinned = true;
    const b = body("b", 40, 0);
    repulseGrid([a, b], opts);
    expect(a.vx).toBe(0);
    expect(b.vx).toBeGreaterThan(0);
  });

  it("на тысяче узлов считает заметно меньше пар, чем N²", () => {
    const ns = Array.from({ length: 1000 }, (_, i) =>
      body("n" + i, (i % 40) * 120, Math.floor(i / 40) * 120),
    );
    const pairs = repulseGrid(ns, opts);
    expect(pairs).toBeLessThan(1000 * 999 * 0.1);
  });
});
