import { describe, expect, it } from "vitest";
import { layoutGraph } from "../../src/pages/myspace/canvas/smartLayout";
import { make, type Obj } from "../../src/pages/myspace/canvas/model";

const node = (id: string, x: number, y: number): Obj => ({
  ...make("sticky", { x: 0, y: 0 }),
  id,
  x,
  y,
});
const link = (id: string, a: string, b: string): Obj =>
  make("line", { x: 0, y: 0 }, { id, from: { id: a }, to: { id: b } });

describe("раскладка схемы по связям", () => {
  it("дерево уровнями слева направо, дети правее родителя", () => {
    const objs = [
      node("a", 500, 500),
      node("b", 0, 0),
      node("c", 900, 40),
      node("d", 10, 700),
      link("l1", "a", "b"),
      link("l2", "a", "c"),
      link("l3", "b", "d"),
    ];
    const out = layoutGraph(objs, null, "LR");
    const p = (id: string) => out.find((o) => o.id === id)!;
    expect(p("b").x).toBeGreaterThan(p("a").x);
    expect(p("c").x).toBeGreaterThan(p("a").x);
    expect(p("d").x).toBeGreaterThan(p("b").x);
    expect(p("b").x).toBe(p("c").x);
  });

  it("несвязанные элементы ложатся сеткой под схемой и не пересекаются с ней", () => {
    const objs = [
      node("a", 0, 0),
      node("b", 300, 0),
      link("l", "a", "b"),
      node("x", 50, 50),
      node("y", 60, 60),
      node("z", 70, 70),
    ];
    const out = layoutGraph(objs, null, "TB");
    const schemeBottom = Math.max(...["a", "b"].map((id) => out.find((o) => o.id === id)!.y + 180));
    for (const id of ["x", "y", "z"])
      expect(out.find((o) => o.id === id)!.y).toBeGreaterThanOrEqual(schemeBottom);
    expect(
      new Set(
        ["x", "y", "z"].map(
          (id) => `${out.find((o) => o.id === id)!.x},${out.find((o) => o.id === id)!.y}`,
        ),
      ).size,
    ).toBe(3);
  });

  it("соединители и рамки остаются на месте", () => {
    const objs = [node("a", 0, 0), node("b", 5, 5), link("l", "a", "b")];
    const out = layoutGraph(objs, null);
    expect(out.find((o) => o.id === "l")).toEqual(objs[2]);
  });
});
