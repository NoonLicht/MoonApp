import { describe, expect, it } from "vitest";
import {
  alignDeltas,
  corners,
  distributeDeltas,
  lineGeom,
  make,
  nearestSide,
  rotatePt,
  sidePoint,
  snapMove,
  boundsOf,
  type Obj,
} from "@/pages/myspace/canvas/model";
import {
  cloneObjs,
  deleteObjs,
  fitGroups,
  groupObjs,
  mapById,
  moveObjs,
  reorder,
  reparent,
  topGroupOf,
  ungroupObjs,
  withChildren,
} from "@/pages/myspace/canvas/board";
import { fromFlow } from "@/pages/myspace/canvas/legacy";
import { TEMPLATES } from "@/pages/myspace/canvas/templates";

const box = (id: string, x: number, y: number, w = 100, h = 60, extra: Partial<Obj> = {}): Obj =>
  make("shape", { x: 0, y: 0 }, { id, x, y, w, h, ...extra });

describe("геометрия", () => {
  it("поворот на 90° меняет габарит местами", () => {
    const o = box("a", 0, 0, 100, 40, { rot: 90 });
    const b = boundsOf(o);
    expect(Math.round(b.w)).toBe(40);
    expect(Math.round(b.h)).toBe(100);
    expect(corners(o)).toHaveLength(4);
  });

  it("точки сторон учитывают поворот", () => {
    const o = box("a", 0, 0, 100, 100, { rot: 180 });
    const top = sidePoint(o, "t");
    expect(Math.round(top.x)).toBe(50);
    expect(Math.round(top.y)).toBe(100);
    expect(Math.round(top.ny)).toBe(1);
    const p = rotatePt({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    expect(Math.round(p.y)).toBe(10);
  });

  it("ближайшая сторона смотрит на точку", () => {
    const o = box("a", 0, 0, 100, 100);
    expect(nearestSide(o, { x: 400, y: 50 })).toBe("r");
    expect(nearestSide(o, { x: 50, y: -300 })).toBe("t");
  });

  it("соединитель идёт от одной фигуры к другой и пересчитывается при переносе", () => {
    const a = box("a", 0, 0);
    const b = box("b", 400, 0);
    const line = make(
      "line",
      { x: 0, y: 0 },
      { id: "l", from: { id: "a", side: "auto" }, to: { id: "b", side: "auto" }, ls: "straight" },
    );
    let g = lineGeom(line, mapById([a, b, line]));
    expect(Math.round(g.a.x)).toBe(100);
    expect(Math.round(g.b.x)).toBe(400);
    const moved = moveObjs([a, b, line], new Set(["b"]), 0, 300);
    g = lineGeom(line, mapById(moved));
    expect(Math.round(g.b.y)).toBe(300);
  });

  it("ступенчатый и кривой соединители дают путь", () => {
    const a = box("a", 0, 0);
    const b = box("b", 300, 200);
    for (const ls of ["step", "curve"] as const) {
      const l = make("line", { x: 0, y: 0 }, { id: "l", from: { id: "a" }, to: { id: "b" }, ls });
      expect(lineGeom(l, mapById([a, b, l])).d.startsWith("M")).toBe(true);
    }
  });
});

describe("привязка и выравнивание", () => {
  it("блок прилипает к краю соседа в пределах порога", () => {
    const r = snapMove({ x: 103, y: 0, w: 50, h: 50 }, [{ x: 0, y: 0, w: 100, h: 50 }], 6);
    expect(r.dx).toBe(-3);
    expect(r.guides.some((g) => g.axis === "x")).toBe(true);
    expect(snapMove({ x: 140, y: 0, w: 50, h: 50 }, [{ x: 0, y: 0, w: 100, h: 50 }], 6).dx).toBe(0);
  });

  it("выравнивание и равные промежутки", () => {
    const boxes = new Map([
      ["a", { x: 0, y: 0, w: 10, h: 10 }],
      ["b", { x: 50, y: 20, w: 30, h: 10 }],
      ["c", { x: 200, y: 40, w: 10, h: 10 }],
    ]);
    expect(alignDeltas(boxes, "left").get("c")!.x).toBe(-200);
    const d = distributeDeltas(boxes, "x");
    expect(d.get("b")!.x).toBe(40);
  });
});

describe("операции над списком", () => {
  const a = box("a", 0, 0);
  const b = box("b", 200, 0);
  const c = box("c", 400, 0);

  it("группа объединяет, клик по ребёнку выбирает группу, разгруппировка возвращает", () => {
    const r = groupObjs([a, b, c], ["a", "b"])!;
    const grp = r.objs.find((o) => o.id === r.id)!;
    expect(grp.type).toBe("group");
    expect(grp.w).toBe(300);
    expect(topGroupOf(r.objs, "a")).toBe(r.id);
    const u = ungroupObjs(r.objs, [r.id]);
    expect(u.objs.find((o) => o.id === "a")!.parent ?? null).toBeNull();
    expect(u.freed.sort()).toEqual(["a", "b"]);
  });

  it("перенос группы двигает детей, габарит группы подгоняется", () => {
    const r = groupObjs([a, b], ["a", "b"])!;
    const moved = fitGroups(moveObjs(r.objs, withChildren(r.objs, [r.id]), 50, 10));
    expect(moved.find((o) => o.id === "a")!.x).toBe(50);
    expect(moved.find((o) => o.id === r.id)!.x).toBe(50);
  });

  it("удаление убирает потомков и оставляет соединитель со свободным концом", () => {
    const l = make("line", { x: 0, y: 0 }, { id: "l", from: { id: "a" }, to: { id: "b" } });
    const out = deleteObjs([a, b, l], ["b"]);
    expect(out.find((o) => o.id === "b")).toBeUndefined();
    const line = out.find((o) => o.id === "l")!;
    expect(line.to?.id).toBeUndefined();
    expect(typeof line.to?.x).toBe("number");
  });

  it("копия получает новые id, а связь между копиями сохраняется", () => {
    const l = make("line", { x: 0, y: 0 }, { id: "l", from: { id: "a" }, to: { id: "b" } });
    const { copies } = cloneObjs([a, b, l], ["a", "b", "l"], 20, 20);
    expect(copies).toHaveLength(3);
    const ids = new Set(copies.map((x) => x.id));
    expect(ids.has("a")).toBe(false);
    const cl = copies.find((x) => x.type === "line")!;
    expect(ids.has(cl.from!.id!)).toBe(true);
    expect(ids.has(cl.to!.id!)).toBe(true);
  });

  it("порядок слоёв", () => {
    expect(reorder([a, b, c], ["a"], "front").map((o) => o.id)).toEqual(["b", "c", "a"]);
    expect(reorder([a, b, c], ["c"], "backward").map((o) => o.id)).toEqual(["a", "c", "b"]);
  });

  it("объект, оказавшийся над рамкой, входит в неё", () => {
    const frame = make("frame", { x: 0, y: 0 }, { id: "f", x: 0, y: 0, w: 500, h: 300 });
    const inside = box("i", 100, 100);
    const out = reparent([frame, inside], ["i"]);
    expect(out.find((o) => o.id === "i")!.parent).toBe("f");
  });
});

describe("перенос старых досок", () => {
  it("все шаблоны превращаются в объекты, а связи — в соединители", () => {
    for (const tpl of TEMPLATES) {
      const { nodes, edges } = tpl.gen(0, 0);
      const list = fromFlow(nodes, edges);
      expect(list.length, tpl.id).toBeGreaterThan(0);
      const ids = new Set(list.map((o) => o.id));
      for (const l of list.filter((o) => o.type === "line")) {
        if (l.from?.id) expect(ids.has(l.from.id)).toBe(true);
        if (l.to?.id) expect(ids.has(l.to.id)).toBe(true);
      }
    }
  });
});
