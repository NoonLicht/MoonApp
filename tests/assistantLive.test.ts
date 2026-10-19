import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { partialNumber, partialString } from "../src/lib/assistant/sharedTools";

/** Поиск без ключей (разбор страниц) и потоковый разбор аргументов вызова для живой записи в документ. */
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let web: any;
beforeAll(() => {
  web = req("../server/assistant/web");
});

describe("поиск без ключей: разбор страниц", () => {
  const ddg = `
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhabr.com%2Fru%2Farticles%2F1%2F&amp;rut=abc">Рейтинг <b>моделей</b></a>
    <a class="result__snippet" href="x">Лучшие модели &amp; сравнение</a></div>
    <div class="result"><a class="result__a" href="https://example.org/two">Two</a><a class="result__snippet" href="x">Second</a></div>`;

  it("DuckDuckGo: адрес берётся из редиректа, теги и сущности убираются", () => {
    const r = web.parseDuckduckgo(ddg, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      title: "Рейтинг моделей",
      url: "https://habr.com/ru/articles/1/",
      snippet: "Лучшие модели & сравнение",
    });
    expect(r[1].url).toBe("https://example.org/two");
  });

  it("DuckDuckGo: страница с капчей — ошибка, а не пустая выдача", () => {
    expect(() => web.parseDuckduckgo("<html>anomaly-modal bots</html>", 5)).toThrow(
      "search_blocked",
    );
  });

  it("Brave: заголовок, ссылка и описание без служебных комментариев", () => {
    const html = `<div class="snippet svelte-x" data-type="web"><a href="https://developer.tuya.com/en/" class="l1"><div class="title search-snippet-title">Tuya Developer</div></a>
      <div class="generic-snippet svelte-y"><div class="content t-primary"><!--[-1--><!--]--> <!---->Build IoT<!----></div></div></div></main>`;
    const r = web.parseBrave(html, 5);
    expect(r).toEqual([
      { title: "Tuya Developer", url: "https://developer.tuya.com/en/", snippet: "Build IoT" },
    ]);
  });
});

describe("неполный JSON аргументов", () => {
  it("строка читается по мере поступления, незавершённый escape ждёт следующего куска", () => {
    expect(partialString('{"where":"end","text":"Привет', "text")).toEqual({
      text: "Привет",
      done: false,
    });
    expect(partialString('{"text":"a\\nb', "text")?.text).toBe("a\nb");
    expect(partialString('{"text":"a\\', "text")?.text).toBe("a");
    expect(partialString('{"text":"a\\u04', "text")?.text).toBe("a");
    expect(partialString('{"text":"\\u0416x"}', "text")).toEqual({ text: "Жx", done: true });
    expect(partialString('{"text":"say \\"hi\\""}', "text")?.text).toBe('say "hi"');
    expect(partialString('{"where":"end"', "text")).toBeNull();
  });

  it("число считается готовым только после запятой или скобки", () => {
    expect(partialNumber('{"paragraph":1', "paragraph")).toBeNull();
    expect(partialNumber('{"paragraph":12,"text":"x', "paragraph")).toBe(12);
  });
});

describe("Word: живая запись текста в документ", () => {
  /** Поддельная страница: журнал вызовов ядра и один абзац в документе. */
  const make = async () => {
    const { wordAdapter } = await import("../src/pages/word/assistant");
    const log: string[] = [];
    const cx: any = {
      docId: "d",
      lang: "ru",
      tw: (s: string) => s,
      s: { selection: { collapsed: true, focus: { path: [0] }, text: "" }, pages: [1], words: 1 },
      ui: { docName: "t" },
      query: async () => ({ blocks: [{ index: 0, type: "paragraph", text: "Старый", len: 12 }] }),
      exec: async (c: string, p?: any) => {
        log.push(p?.text !== undefined ? `${c}:${p.text}` : c);
        return { ok: true };
      },
    };
    const adapter = wordAdapter(() => cx, "ru");
    return { log, tool: (n: string) => adapter.tools.find((t) => t.name === n)! };
  };

  it("текст набирается по мере поступления аргументов, а не одним куском в конце", async () => {
    const { log, tool } = await make();
    const w = tool("insert_text").live!();
    const full = '{"where":"end","text":"Первая строка\nВтор';
    for (let i = 1; i <= full.length; i++) w.push(full.slice(0, i));
    expect(w.started()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    // до окончания вызова в документе уже есть набранный текст
    expect(log.filter((l) => l.startsWith("text.insert")).join("|")).toContain("Первая строка");
    const done = await w.finish({ where: "end", text: "Первая строка\nВторая" });
    expect(done).toMatch(/Wrote 2/);
    const typed = log
      .filter((l) => l.startsWith("text.insert:"))
      .map((l) => l.slice(12))
      .join("");
    expect(typed).toBe("Первая строкаВторая");
    expect(log.filter((l) => l === "text.newParagraph").length).toBeGreaterThanOrEqual(2);
  });

  it("без указания места живая запись не стартует: документ не трогается", async () => {
    const { log, tool } = await make();
    const w = tool("insert_text").live!();
    w.push('{"text":"Привет');
    expect(w.started()).toBe(false);
    expect(log).toEqual([]);
  });

  it("замена абзаца: выделение выбирается один раз, текст пишется поверх", async () => {
    const { log, tool } = await make();
    const w = tool("replace_paragraph").live!();
    w.push('{"paragraph":0,"text":"Нов');
    await new Promise((r) => setTimeout(r, 20));
    await w.finish({ paragraph: 0, text: "Новый" });
    expect(log.filter((l) => l === "select.range")).toHaveLength(1);
    expect(
      log
        .filter((l) => l.startsWith("text.insert:"))
        .map((l) => l.slice(12))
        .join(""),
    ).toBe("Новый");
  });

  it("пустой текст при замене стирает абзац, а удаление ограничено тремя за запрос", async () => {
    const { log, tool } = await make();
    const w = tool("replace_paragraph").live!();
    w.push('{"paragraph":0,"text":"');
    await new Promise((r) => setTimeout(r, 20));
    await w.finish({ paragraph: 0, text: "" });
    expect(log).toContain("text.delete");
    expect(tool("delete_paragraph").limit).toBe(3);
  });

  it("таблица: строки набираются через табы и превращаются в настоящую таблицу Word", async () => {
    const { wordAdapter } = await import("../src/pages/word/assistant");
    const log: string[] = [];
    const cx: any = {
      docId: "d",
      lang: "ru",
      tw: (s: string) => s,
      s: { selection: { collapsed: true, focus: { path: [0] }, text: "" } },
      ui: { docName: "t" },
      query: async () => ({
        blocks: [{ index: 0, type: "paragraph", text: "", len: 0 }],
        selection: { focus: { path: [0] } },
      }),
      exec: async (c: string, p?: any) => {
        log.push(
          c === "select.range"
            ? `sel:${p.anchor.path[0]}-${p.focus.path[0]}:${p.focus.off}`
            : p?.text !== undefined
              ? `${c}:${p.text}`
              : `${c}${p?.separator ? ":" + p.separator : ""}`,
        );
        return { ok: true };
      },
    };
    const t = wordAdapter(() => cx, "ru").tools.find((x) => x.name === "insert_table")!;
    const out = await t.run({
      where: "end",
      rows: [
        ["Модель", "Контекст"],
        ["Qwen3", "32K"],
      ],
    });
    expect(out).toMatch(/2x2/);
    expect(log).toContain("text.insert:Модель	Контекст");
    expect(log).toContain("text.insert:Qwen3	32K");
    // выделены обе строки, последняя — в байтах UTF-8
    expect(log).toContain("sel:0-1:" + new TextEncoder().encode("Qwen3	32K").length);
    expect(log[log.length - 1]).toBe("table.fromText:tab");
    await expect(t.run({ where: "end", rows: [] })).rejects.toThrow();
  });
});
