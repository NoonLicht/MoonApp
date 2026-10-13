import { describe, it, expect } from "vitest";
import { parseSlash, suggestSlash } from "@/pages/ai-chat/lib/slashCommands";

describe("слэш-команды чата", () => {
  it("известная команда с аргументом и без", () => {
    expect(parseSlash("/compact")).toEqual({ name: "compact", arg: "", known: true });
    expect(parseSlash("/compact про код")).toEqual({ name: "compact", arg: "про код", known: true });
    expect(parseSlash("/TITLE Новый")).toMatchObject({ name: "title", arg: "Новый" });
  });

  it("путь и обычный текст командой не считаются", () => {
    expect(parseSlash("/usr/bin/env")).toBeNull();
    expect(parseSlash("/foo bar baz")).toBeNull();
    expect(parseSlash("привет")).toBeNull();
  });

  it("одно неизвестное слово — неизвестная команда", () => {
    expect(parseSlash("/zzz")).toEqual({ name: "zzz", arg: "", known: false });
  });

  it("подсказки по префиксу, пока нет пробела", () => {
    expect(suggestSlash("/co").map((c) => c.name)).toEqual(["compact", "copy"]);
    expect(suggestSlash("/").length).toBeGreaterThan(8);
    expect(suggestSlash("/compact текст")).toEqual([]);
  });
});
