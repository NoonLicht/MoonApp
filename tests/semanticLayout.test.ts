import { describe, expect, it } from "vitest";
import { layoutByGroups } from "../src/pages/myspace/canvas/SmartPanel";
import { make, type Obj } from "../src/pages/myspace/canvas/model";
import { targetFor } from "../src/lib/deepLink";

const sticky = (text: string, x: number): Obj => ({
  ...make("sticky", { x, y: 0 }),
  text,
});

describe("раскладка стикеров по смыслу", () => {
  it("создаёт рамку на группу и привязывает стикеры, одиночки уходят в «Разное»", () => {
    const objs = [
      sticky("яблоки", 0),
      sticky("груши", 200),
      sticky("налоги", 400),
      sticky("отчёт", 600),
    ];
    const ids = objs.map((o) => o.id);
    const out = layoutByGroups(objs, ids, [[0, 1], [2], [3]]);
    const frames = out.filter((o) => o.type === "frame");
    expect(frames.map((f) => f.name)).toEqual(["яблоки", "Разное"]);
    const first = out.find((o) => o.id === ids[0]);
    expect(first?.parent).toBe(frames[0].id);
    expect(out.find((o) => o.id === ids[3])?.parent).toBe(frames[1].id);
    // рамки лежат под стикерами
    expect(out.indexOf(frames[0])).toBeLessThan(out.findIndex((o) => o.id === ids[0]));
  });
});

describe("переход из поиска", () => {
  it("ведёт на нужную страницу и вид", () => {
    expect(targetFor("note", "a/b.md")).toEqual({ page: "myspace", view: "notes", ref: "a/b.md" });
    expect(targetFor("lecture", "3", 5000)).toMatchObject({ page: "lecture", ref: "3", at: 5000 });
    expect(targetFor("chat", "7").page).toBe("aichat");
  });
});
