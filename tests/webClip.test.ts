import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Веб-клиппер (server/ts/webClip.ts). */
const req = createRequire(import.meta.url);
let wc: any;
beforeAll(() => {
  wc = req("../server/webClip");
});

const link = (p: Record<string, string>) => "moonapp://clip?" + new URLSearchParams(p).toString();

describe("parseClipUrl", () => {
  it("разбирает заголовок, адрес и выделенный текст", () => {
    const c = wc.parseClipUrl(link({ title: "  Статья  о\nкотах ", url: "https://example.com/a", text: "Кошки спят." }));
    expect(c).toEqual({ title: "Статья о котах", url: "https://example.com/a", text: "Кошки спят." });
  });

  it("без заголовка берёт адрес", () => {
    const c = wc.parseClipUrl(link({ url: "https://example.com/a", text: "x" }));
    expect(c.title).toBe("https://example.com/a");
  });

  it("отвергает чужие схемы источника, чужое «хост» и пустое", () => {
    expect(wc.parseClipUrl(link({ title: "t", url: "javascript:alert(1)" }))).toBeNull();
    expect(wc.parseClipUrl(link({ title: "t", url: "file:///etc/passwd" }))).toBeNull();
    expect(wc.parseClipUrl("moonapp://other?title=t&url=https://a.b")).toBeNull();
    expect(wc.parseClipUrl("https://example.com")).toBeNull();
    expect(wc.parseClipUrl(link({ url: "https://a.b" }))).toBeNull();
    expect(wc.parseClipUrl("мусор")).toBeNull();
  });

  it("вырезает управляющие символы и обрезает длину", () => {
    const c = wc.parseClipUrl(link({ title: "a\u0007b", url: "https://a.b", text: "x".repeat(50_000) }));
    expect(c.title).toBe("ab");
    expect(c.text.length).toBe(12_000);
  });
});

describe("buildNote", () => {
  const clip = { title: "Статья: про #котов?", url: "https://example.com/a", text: "Строка 1\nСтрока 2" };

  it("кладёт заметку в папку клипов, с безопасным именем и цитатой", () => {
    const n = wc.buildNote(clip, new Date("2026-03-05T10:00:00Z"));
    expect(n.path).toBe("Веб-клипы/Статья про котов.md");
    expect(n.content).toContain("# Статья: про #котов?");
    expect(n.content).toContain("Источник: <https://example.com/a>");
    expect(n.content).toContain("Сохранено: 2026-03-05");
    expect(n.content).toContain("> Строка 1\n> Строка 2");
  });

  it("не затирает существующую заметку", () => {
    const taken = new Set(["Веб-клипы/Статья про котов.md"]);
    expect(wc.buildNote(clip, new Date(), (p: string) => taken.has(p)).path).toBe("Веб-клипы/Статья про котов 2.md");
  });
});
