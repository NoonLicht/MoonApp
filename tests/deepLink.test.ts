import { describe, expect, it } from "vitest";
import { moonHref, parseMoonHref, targetFor } from "../src/lib/deepLink";

describe("переходы между страницами", () => {
  it("ведёт на нужную страницу и вид", () => {
    expect(targetFor("note", "a/b.md")).toEqual({ page: "myspace", view: "notes", ref: "a/b.md" });
    expect(targetFor("lecture", "3", 5000)).toMatchObject({ page: "lecture", ref: "3", at: 5000 });
    expect(targetFor("chat", "7").page).toBe("aichat");
    expect(targetFor("task", "t1")).toMatchObject({ page: "myspace", view: "tasks", ref: "t1" });
  });
  it("moon://-ссылка туда и обратно, в том числе с # и кириллицей", () => {
    const h = moonHref("canvas", "Доска_1#o12");
    expect(h.startsWith("moon://canvas/")).toBe(true);
    expect(parseMoonHref(h)).toEqual({ kind: "canvas", ref: "Доска_1#o12" });
    expect(parseMoonHref("https://x.y")).toBeNull();
  });
});
