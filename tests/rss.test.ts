import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** RSS-ридер (server/ts/rss.ts): разбор лент, слияние, OPML, обновление, сводка. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-rss-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
let rss: any;
beforeAll(() => {
  rss = req("../server/rss");
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Tech &amp; Co</title>
  <link>https://tech.example/</link>
  <item>
    <title><![CDATA[Новый процессор &amp; память]]></title>
    <link>https://tech.example/a1</link>
    <guid isPermaLink="false">a1</guid>
    <pubDate>Tue, 09 Jun 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Короткое <b>описание</b> &nbsp;статьи.</p><script>alert(1)</script>]]></description>
    <media:thumbnail url="https://tech.example/img/a1.jpg"/>
  </item>
  <item>
    <title>Без картинки</title>
    <link>https://tech.example/a2</link>
    <pubDate>Mon, 08 Jun 2026 09:00:00 GMT</pubDate>
    <content:encoded><![CDATA[<div><img src="https://tech.example/in.png"> Текст &#1090;&#1077;&#1089;&#1090;</div>]]></content:encoded>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Блог</title>
  <link rel="self" href="https://blog.example/feed.xml"/>
  <link rel="alternate" href="https://blog.example/"/>
  <entry>
    <title>Запись один</title>
    <link rel="alternate" href="https://blog.example/p1"/>
    <link rel="enclosure" href="https://blog.example/p1.mp3"/>
    <id>tag:blog.example,2026:p1</id>
    <updated>2026-06-09T12:30:00Z</updated>
    <summary type="html">&lt;p&gt;Кратко&lt;/p&gt;</summary>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("RSS 2.0: заголовок, CDATA, сущности, дата, картинка, описание без HTML и скриптов", () => {
    const f = rss.parseFeed(RSS);
    expect(f.title).toBe("Tech & Co");
    expect(f.site).toBe("https://tech.example/");
    expect(f.items).toHaveLength(2);
    expect(f.items[0]).toMatchObject({
      guid: "a1",
      title: "Новый процессор & память",
      link: "https://tech.example/a1",
      published: "2026-06-09T10:00:00.000Z",
      image: "https://tech.example/img/a1.jpg",
    });
    expect(f.items[0].summary).toBe("Короткое описание статьи.");
    expect(f.items[0].summary).not.toContain("alert");
  });

  it("RSS: нет guid — берётся ссылка; картинка из content:encoded; числовые сущности", () => {
    const it = rss.parseFeed(RSS).items[1];
    expect(it.guid).toBe("https://tech.example/a2");
    expect(it.image).toBe("https://tech.example/in.png");
    expect(it.summary).toContain("Текст тест");
  });

  it("Atom: ссылка alternate (а не enclosure/self), id, updated, HTML в summary", () => {
    const f = rss.parseFeed(ATOM);
    expect(f.title).toBe("Блог");
    expect(f.site).toBe("https://blog.example/");
    expect(f.items[0]).toMatchObject({
      guid: "tag:blog.example,2026:p1",
      link: "https://blog.example/p1",
      published: "2026-06-09T12:30:00.000Z",
      summary: "Кратко",
    });
  });

  it("не-лента отвергается", () => {
    expect(() => rss.parseFeed("<html><body>404</body></html>")).toThrow("feed_not_recognized");
  });
});

describe("OPML", () => {
  it("экспорт → импорт возвращает те же подписки, спецсимволы экранируются", () => {
    const feeds = [
      { title: 'A & "B"', url: "https://x.example/feed?a=1&b=2", site: "https://x.example" },
      { title: "Второй", url: "https://y.example/rss" },
    ];
    const xml = rss.buildOpml(feeds);
    expect(xml).toContain("&amp;");
    expect(rss.parseOpml(xml)).toEqual([
      { title: 'A & "B"', url: "https://x.example/feed?a=1&b=2" },
      { title: "Второй", url: "https://y.example/rss" },
    ]);
  });

  it("вложенные категории раскрываются в плоский список", () => {
    const xml = `<opml><body><outline text="Новости"><outline text="N1" xmlUrl="https://n1/rss"/><outline text="N2" xmlUrl="https://n2/rss"/></outline></body></opml>`;
    expect(rss.parseOpml(xml).map((x: any) => x.url)).toEqual(["https://n1/rss", "https://n2/rss"]);
  });
});

describe("mergeItems", () => {
  const p = (guid: string, published: string) => ({ guid, title: guid, link: "https://e/" + guid, published, summary: "" });

  it("не дублирует известные статьи и сохраняет отметки прочитано/сохранено", () => {
    const first = rss.mergeItems([], "f1", [p("a", "2026-01-01T00:00:00Z"), p("b", "2026-01-02T00:00:00Z")], "now");
    expect(first.added).toBe(2);
    first.items[0].read = true;
    first.items[1].saved = true;
    const second = rss.mergeItems(first.items, "f1", [p("a", "2026-01-01T00:00:00Z"), p("c", "2026-01-03T00:00:00Z")], "now");
    expect(second.added).toBe(1);
    expect(second.items).toHaveLength(3);
    expect(second.items.find((i: any) => i.guid === "a").read).toBe(true);
    expect(second.items.find((i: any) => i.guid === "b").saved).toBe(true);
  });

  it("ленты не пересекаются: одинаковый guid в разных лентах — разные статьи", () => {
    const a = rss.mergeItems([], "f1", [p("same", "2026-01-01T00:00:00Z")], "now");
    const b = rss.mergeItems(a.items, "f2", [p("same", "2026-01-01T00:00:00Z")], "now");
    expect(b.items).toHaveLength(2);
  });

  it("обрезает старьё сверх 1000, но сохранённые остаются навсегда", () => {
    const many = Array.from({ length: 1005 }, (_, i) =>
      p("g" + i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    let m = rss.mergeItems([], "f", many.slice(0, 5), "now");
    m.items[0].saved = true; // самая старая, но сохранена
    const oldestId = m.items[0].id;
    m = rss.mergeItems(m.items, "f", many.slice(5), "now");
    expect(m.items.length).toBe(1001); // 1000 свежих + 1 сохранённая старая
    expect(m.items.some((i: any) => i.id === oldestId)).toBe(true);
  });
});

describe("подписки, обновление и сводка", () => {
  const calls: string[] = [];
  const fetcher = (bodies: Record<string, string>) => async (url: string, cond: any) => {
    calls.push(url + (cond.etag ? " etag=" + cond.etag : ""));
    if (!(url in bodies)) throw new Error("HTTP 404");
    if (cond.etag === "v1") return { status: 304, text: "" };
    return { status: 200, text: bodies[url], etag: "v1" };
  };

  it("addFeed загружает ленту и статьи; повторная подписка не создаёт дубль", async () => {
    const f = fetcher({ "https://tech.example/rss": RSS });
    const feed = await rss.addFeed("https://tech.example/rss", f);
    expect(feed.title).toBe("Tech & Co");
    expect((await rss.addFeed("https://tech.example/rss", f)).id).toBe(feed.id);
    const feeds = rss.listFeeds();
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ unread: 2, total: 2 });
  });

  it("только http(s) и корректный URL", async () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "not a url", ""]) {
      await expect(rss.addFeed(bad, async () => ({ status: 200, text: RSS }))).rejects.toThrow("invalid_url");
    }
  });

  it("refresh: условный запрос по ETag (304 — без новых статей), ошибка одной ленты не роняет остальные", async () => {
    await rss.addFeed("https://blog.example/feed.xml", fetcher({ "https://blog.example/feed.xml": ATOM }));
    calls.length = 0;
    const r1 = await rss.refresh(undefined, fetcher({ "https://tech.example/rss": RSS }));
    // blog.example недоступен (404) → failed, tech.example — 304 по etag
    expect(r1).toEqual({ added: 0, failed: 1 });
    expect(calls.some((c) => c.includes("etag=v1"))).toBe(true);
    const failed = rss.listFeeds().find((f: any) => f.url.includes("blog"));
    expect(failed.error).toContain("404");
  });

  it("статьи: фильтры непрочитанные/сохранённые/поиск; отметки и read-all", () => {
    const all = rss.listItems({});
    expect(all.length).toBe(3);
    expect(all[0].published >= all[1].published).toBe(true); // свежие первыми
    expect(rss.listItems({ q: "процессор" })).toHaveLength(1);
    rss.patchItem(all[0].id, { read: true, saved: true });
    expect(rss.listItems({ unread: true })).toHaveLength(2);
    expect(rss.listItems({ saved: true })).toHaveLength(1);
    expect(rss.markAllRead()).toBe(2);
    expect(rss.listItems({ unread: true })).toHaveLength(0);
    expect(rss.patchItem("нет-такой", { read: true })).toBeNull();
  });

  it("buildDigestPrompt: язык ответа, нумерация, источник и обрезка описаний", () => {
    const prompt = rss.buildDigestPrompt(
      [{ title: "T1", summary: "x".repeat(500), feedTitle: "Feed", published: "" }],
      "Spanish",
    );
    expect(prompt).toContain("Spanish");
    expect(prompt).toContain("1. [Feed] T1 — ");
    expect(prompt.length).toBeLessThan(900);
  });

  it("digest без новостей — ошибка no_items, а не запрос к модели", async () => {
    await expect(rss.digest("unread", "Russian")).rejects.toThrow("no_items");
  });

  it("OPML-импорт подписывается на ленты и считает пропущенные/неудачные", async () => {
    const xml = rss.buildOpml([
      { title: "Tech", url: "https://tech.example/rss" }, // уже есть
      { title: "Новая", url: "https://new.example/rss" },
      { title: "Битая", url: "https://dead.example/rss" },
    ]);
    const f = fetcher({ "https://new.example/rss": ATOM, "https://tech.example/rss": RSS });
    // importOpml использует переданный загрузчик для каждой ленты
    const r = await rss.importOpml(xml, f);
    expect(r).toEqual({ added: 1, skipped: 1, failed: 1 });
    expect(rss.removeFeed(rss.listFeeds().find((x: any) => x.url.includes("new.example")).id)).toBe(true);
  });
});

describe("текст статьи", () => {
  it("достаёт заголовки и абзацы из <article>, отбрасывая меню и скрипты", () => {
    const rss = createRequire(import.meta.url)("../server/rss");
    const html = `<html><nav><p>Меню меню меню меню меню меню меню меню</p></nav><script>var a=1;</script>
      <article><h1>Заголовок статьи</h1><p>Первый абзац достаточно длинный, чтобы пройти фильтр.</p>
      <p>коротко</p><ul><li>Пункт списка который тоже достаточно длинный</li></ul>
      <p>Первый абзац достаточно длинный, чтобы пройти фильтр.</p></article><footer><p>Подвал подвал подвал подвал подвал подвал</p></footer></html>`;
    const b = rss.extractArticle(html);
    expect(b.map((x: { kind: string }) => x.kind)).toEqual(["h", "p", "li"]);
    expect(JSON.stringify(b)).not.toContain("Меню");
    expect(JSON.stringify(b)).not.toContain("Подвал");
  });
});

describe("хранение в БД", () => {
  it("ленты и статьи лежат в БД и переживают перезагрузку модуля", async () => {
    const xml = `<rss version="2.0"><channel><title>T</title><item><title>A</title><link>https://x/a</link><guid>a</guid><description>d</description></item></channel></rss>`;
    const f = await rss.addFeed("https://persist.example/rss", async () => ({ status: 200, text: xml }));
    expect(rss.listItems({ feedId: f.id }).length).toBe(1);
    const db = req("../server/db");
    db.flush();
    const docs = db.docStore.all("rss_item");
    expect(docs.length).toBeGreaterThan(0);
    expect(JSON.parse(docs[0].json).title).toBeDefined();
    expect(rss.getLastDigest()).toBeNull();
  });
});

describe("перевод новостей", () => {
  it("определяет письменность и разбирает JSON из ответа модели", () => {
    expect(rss.scriptOf("Новости о погоде в Москве")).toBe("cyr");
    expect(rss.scriptOf("Samsung Galaxy S26 Ultra is down")).toBe("lat");
    expect(rss.scriptOf("今日のニュース")).toBe("cjk");
    expect(rss.scriptOf("12 34")).toBe("");
    expect(rss.parseJsonArray('Вот:\n```json\n[{"i":0,"same":true}]\n```')).toEqual([{ i: 0, same: true }]);
    expect(rss.parseJsonArray("нет массива")).toBeNull();
  });

  it("статьи уже на языке пользователя не уходят в ИИ и помечаются 0", async () => {
    const xml = `<rss version="2.0"><channel><title>Р</title><item><title>Заголовок новости дня</title><link>https://r/1</link><guid>r1</guid><description>Описание новости на русском языке</description></item></channel></rss>`;
    const f = await rss.addFeed("https://ru.example/rss", async () => ({ status: 200, text: xml }));
    const id = rss.listItems({ feedId: f.id })[0].id;
    expect((await rss.translateItems([id], "ru")).items).toEqual([{ id, tr: 0 }]);
    expect(rss.listItems({ feedId: f.id })[0].tr).toEqual({ ru: 0 });
    await expect(rss.translateItems([id], "xx")).rejects.toThrow("unsupported_language");
  });
});

describe("поиск по статьям", () => {
  it("без модели эмбеддингов отвечает обычным текстовым поиском", async () => {
    const xml = `<rss version="2.0"><channel><title>S</title><item><title>Квантовый компьютер выпущен</title><link>https://s/1</link><guid>s1</guid><description>Новая машина</description></item><item><title>Погода завтра</title><link>https://s/2</link><guid>s2</guid><description>Дождь</description></item></channel></rss>`;
    await rss.addFeed("https://search.example/rss", async () => ({ status: 200, text: xml }));
    const r = await rss.searchItems("квантовый");
    expect(r.mode).toBe("text");
    expect(r.items.map((i: { title: string }) => i.title)).toEqual(["Квантовый компьютер выпущен"]);
    expect((await rss.searchItems("")).mode).toBe("text");
  });
});

describe("настройки автообновления", () => {
  it("по умолчанию 5 минут, значения ограничиваются, сохраняются в БД", () => {
    expect(rss.getSettings().intervalMin).toBe(5);
    expect(rss.normSettings({ intervalMin: 0 }).intervalMin).toBe(0);
    expect(rss.normSettings({ intervalMin: -3 }).intervalMin).toBe(0);
    expect(rss.normSettings({ intervalMin: 0.2 }).intervalMin).toBe(1);
    expect(rss.normSettings({ intervalMin: 99999 }).intervalMin).toBe(15);
    expect(rss.normSettings({ intervalMin: "abc" }).intervalMin).toBe(5);
    rss.setSettings({ intervalMin: 15 });
    expect(rss.getSettings().intervalMin).toBe(15);
  });
});

describe("Google Translate: раскладка ответа по строкам", () => {
  it("возвращает переводы предложений в свои строки по длине оригиналов", () => {
    const texts = ["Hello world. How are you?", "Second line"];
    // payload = "Hello world. How are you?\nSecond line"
    const segs: [string, string][] = [
      ["Привет, мир. ", "Hello world. "],
      ["Как дела?\n", "How are you?\n"],
      ["Вторая строка", "Second line"],
    ];
    expect(rss.alignGoogle(texts, segs)).toEqual(["Привет, мир. Как дела?", "Вторая строка"]);
  });
});

describe("очистка БД, настройки движков, хранение статей", () => {
  it("clearStore удаляет несохранённые статьи и их тексты, сохранённые остаются", async () => {
    const xml = `<rss version="2.0"><channel><title>C</title><item><title>Один</title><link>https://c/1</link><guid>c1</guid><description>d1</description></item><item><title>Два</title><link>https://c/2</link><guid>c2</guid><description>d2</description></item></channel></rss>`;
    const f = await rss.addFeed("https://clear.example/rss", async () => ({ status: 200, text: xml }));
    const [a, b] = rss.listItems({ feedId: f.id });
    rss.patchItem(a.id, { saved: true });
    const db = req("../server/db");
    db.docStore.set("rss_article", b.id, JSON.stringify({ blocks: [], partial: false }));
    db.docStore.set("rss_article_tr", `${b.id}:ru`, "0");
    const r = rss.clearStore();
    expect(r.removed).toBeGreaterThanOrEqual(1);
    const left = rss.listItems({ feedId: f.id });
    expect(left.map((i: { id: string }) => i.id)).toEqual([a.id]);
    expect(db.docStore.get("rss_article", b.id)).toBeUndefined();
    expect(db.docStore.get("rss_article_tr", `${b.id}:ru`)).toBeUndefined();
  });

  it("настройки: частичное сохранение, ключ LibreTranslate наружу не отдаётся", () => {
    rss.setSettings({ libreUrl: "https://libre.example", libreKey: "SECRET" });
    rss.setSettings({ intervalMin: 10 }); // не затирает остальное
    const pub = rss.publicSettings();
    expect(pub).toMatchObject({ intervalMin: 10, libreUrl: "https://libre.example", hasLibreKey: true });
    expect(JSON.stringify(pub)).not.toContain("SECRET");
    rss.setSettings({ libreKey: "" }); // пустой ключ не стирает сохранённый
    expect(rss.publicSettings().hasLibreKey).toBe(true);
    rss.setSettings({ clearLibreKey: true });
    expect(rss.publicSettings().hasLibreKey).toBe(false);
  });

  it("нормализация движка и разбиение текста по лимиту", () => {
    expect(rss.normEngine("mymemory")).toBe("mymemory");
    expect(rss.normEngine("whatever")).toBe("ai");
    const parts = rss.splitForLimit("One two. Three four five. Six seven eight nine.", 20);
    expect(parts.every((p: string) => p.length <= 20)).toBe(true);
    expect(parts.join(" ")).toContain("Six seven");
  });
});

describe("выгрузка локальной модели", () => {
  it("настройка «выгружать после перевода» хранится, по умолчанию выключена", () => {
    expect(rss.normSettings({}).unloadAfter).toBe(false);
    rss.setSettings({ unloadAfter: true });
    expect(rss.publicSettings().unloadAfter).toBe(true);
    rss.setSettings({ unloadAfter: false });
    expect(rss.publicSettings().unloadAfter).toBe(false);
    expect(() => rss.unloadLocal()).not.toThrow();
  });
});
