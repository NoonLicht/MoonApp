import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Контекст чата из файла/папки/сайта (server/ts/chatContext.ts). */
const req = createRequire(import.meta.url);
let cc: any;
beforeAll(() => {
  cc = req("../server/chatContext");
});

describe("isPublicUrl", () => {
  it("пропускает обычные сайты", () => {
    expect(cc.isPublicUrl("https://example.com/a?b=1")).toBe(true);
    expect(cc.isPublicUrl("http://8.8.8.8/")).toBe(true);
  });

  it("отвергает не-http и локальные/частные адреса", () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://example.com",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://10.0.0.5",
      "http://192.168.1.1",
      "http://172.20.0.1",
      "http://169.254.169.254/latest",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://printer.local/",
      "не адрес",
    ])
      expect(cc.isPublicUrl(u), u).toBe(false);
  });
});

describe("отрывки и контекст", () => {
  const docs = [
    { title: "физика.md", text: "Закон Ома связывает ток, напряжение и сопротивление в цепи.\n\nОптика изучает свет и линзы в приборах." },
    { title: "кулинария.md", text: "Борщ варят из свёклы и капусты, добавляя мясо и специи по вкусу." },
  ];

  it("выбирает отрывки по пересечению слов вопроса", () => {
    const p = cc.pickPassages(docs, "что такое закон Ома и сопротивление");
    expect(p[0].title).toBe("физика.md");
    expect(p[0].text).toContain("Ома");
    expect(p.every((x: any) => x.score > 0)).toBe(true);
  });

  it("без вопроса берёт начала документов", () => {
    const p = cc.pickPassages(docs, "");
    expect(p.length).toBe(3);
  });

  it("buildContext укладывается в лимит и называет источники", () => {
    const p = cc.pickPassages(docs, "");
    const full = cc.buildContext(p);
    expect(full).toContain("[физика.md]");
    expect(cc.buildContext(p, 60).length).toBeLessThan(full.length);
    expect(cc.buildContext([])).toBe("");
  });

  it("длинный абзац режется на отрывки", () => {
    const long = "Слово ".repeat(400);
    expect(cc.splitPassages(long, 300).length).toBeGreaterThan(5);
  });
});
