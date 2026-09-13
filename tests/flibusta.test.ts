import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-flib-"));
  process.env.MOONAPP_STORAGE = tmpDir;
});

async function flib() {
  return await import("../server/flibusta");
}

const ENTRY_FB2 = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <link href="/opds/new/1/new/" rel="next" type="application/atom+xml" />
  <entry>
    <updated>2026-08-29T21:25:03+02:00</updated>
    <title>Отпечатки</title>
    <author><name>Мамон Антон Вадимович</name><uri>/a/253193</uri></author>
    <category term="Триллер" label="Триллер"/>
    <dc:language>ru</dc:language>
    <dc:format>fb2+zip</dc:format>
    <dc:issued>2026</dc:issued>
    <content type="text/html">&lt;p class="book"&gt;В тихом городке.&lt;/p&gt;
    &lt;br/&gt;Год издания: 2026&lt;br/&gt;Формат: fb2&lt;br/&gt;Язык: ru&lt;br/&gt;Размер: 3074 Kb&lt;br/&gt;</content>
    <link href="/i/76/887376/img_0.jpeg" rel="http://opds-spec.org/image" type="image/jpeg" />
    <link href="/b/887376/fb2" rel="http://opds-spec.org/acquisition/open-access" type="application/fb2+zip" />
    <link href="/b/887376/epub" rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" />
    <link href="/b/887376/mobi" rel="http://opds-spec.org/acquisition/open-access" type="application/x-mobipocket-ebook" />
    <link href="/b/887376" rel="alternate" type="text/html" title="Книга на сайте" />
    <id>tag:book:5066e98c8e9da74eca295bc73600d50a</id>
  </entry>
</feed>`;
const AUTHOR_ONLY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>По авторам</title>
    <link href="/opds/authorsindex/А" type="application/atom+xml;profile=opds-catalog" />
    <id>tag:root:authors</id>
  </entry>
</feed>`;

describe("flibusta OPDS-парсер", () => {
  it("разбирает книжный entry полностью", async () => {
    const m = await flib();
    const b = m.parseEntry(ENTRY_FB2.match(/<entry>[\s\S]*?<\/entry>/)[0]);
    expect(b).not.toBeNull();
    expect(b.id).toBe("tag:book:5066e98c8e9da74eca295bc73600d50a");
    expect(b.bid).toBe(887376);
    expect(b.title).toBe("Отпечатки");
    expect(b.author).toBe("Мамон Антон Вадимович");
    expect(b.year).toBe(2026);
    expect(b.language).toBe("ru");
    expect(b.genres).toEqual(["Триллер"]);
    expect(b.formats).toContain("fb2");
    expect(b.formats).toContain("epub");
    expect(b.formats).toContain("mobi");
    expect(b.sizeText).toContain("3074");
    expect(b.cover).toContain("/i/76/887376");
  });

  it("пропускает не-книжные entry (подкаталоги)", async () => {
    const m = await flib();
    const b = m.parseEntry(AUTHOR_ONLY.match(/<entry>[\s\S]*?<\/entry>/)[0]);
    expect(b).toBeNull();
  });

  it("parseFeed достаёт книги и следующий href", async () => {
    const m = await flib();
    const { books, next } = m.parseFeed(ENTRY_FB2);
    expect(books.length).toBe(1);
    expect(books[0].bid).toBe(887376);
    expect(next).toContain("/opds/new/1/new");
  });

  it("parseNavEntries извлекает навигационные ссылки (жанры)", async () => {
    const m = await flib();
    const nav = m.parseNavEntries(AUTHOR_ONLY);
    expect(nav).toEqual([{ title: "По авторам", href: "/opds/authorsindex/А" }]);
  });
});

describe("flibusta избранное/закладки", () => {
  it("toggleMyBook переключает флаги и чистит пустые записи", async () => {
    const m = await flib();
    const r1 = m.toggleMyBook("fav", 424242, { bid: 424242, title: "T" });
    expect(r1).toEqual({ fav: true, bm: false });
    const r2 = m.toggleMyBook("bm", 424242, { bid: 424242, title: "T" });
    expect(r2).toEqual({ fav: true, bm: true });
    const flags = m.myFlags([424242, 1]);
    expect(flags[424242]).toEqual({ fav: true, bm: true });
    expect(m.myBooks("fav").map((b) => b.bid)).toContain(424242);
    m.toggleMyBook("fav", 424242, {});
    m.toggleMyBook("bm", 424242, {});
    expect(m.myBooks("all").map((b) => b.bid)).not.toContain(424242);
  });
});
