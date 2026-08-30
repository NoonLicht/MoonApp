import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-flib-"));
  process.env.PERSONAL_APP_STORAGE = tmpDir;
});

async function flib() {
  return await import("../server/flibusta");
}

const ENTRY_FB2 = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <link href="/opds/new/1/new/" rel="next" type="application/atom+xml" />
  <entry>
    <updated>2026-08-29T21:25:03+02:00</updated>
    <title>\u041e\u0442\u043f\u0435\u0447\u0430\u0442\u043a\u0438</title>
    <author><name>\u041c\u0430\u043c\u043e\u043d \u0410\u043d\u0442\u043e\u043d \u0412\u0430\u0434\u0438\u043c\u043e\u0432\u0438\u0447</name><uri>/a/253193</uri></author>
    <category term="\u0422\u0440\u0438\u043b\u043b\u0435\u0440" label="\u0422\u0440\u0438\u043b\u043b\u0435\u0440"/>
    <dc:language>ru</dc:language>
    <dc:format>fb2+zip</dc:format>
    <dc:issued>2026</dc:issued>
    <content type="text/html">&lt;p class=&quot;book&quot;&gt;\u0412 \u0442\u0438\u0445\u043e\u043c \u0433\u043e\u0440\u043e\u0434\u043a\u0435.&lt;/p&gt;
    &lt;br/&gt;\u0413\u043e\u0434 \u0438\u0437\u0434\u0430\u043d\u0438\u044f: 2026&lt;br/&gt;\u0424\u043e\u0440\u043c\u0430\u0442: fb2&lt;br/&gt;\u042f\u0437\u044b\u043a: ru&lt;br/&gt;\u0420\u0430\u0437\u043c\u0435\u0440: 3074 Kb&lt;br/&gt;</content>
    <link href="/i/76/887376/img_0.jpeg" rel="http://opds-spec.org/image" type="image/jpeg" />
    <link href="/b/887376/fb2" rel="http://opds-spec.org/acquisition/open-access" type="application/fb2+zip" />
    <link href="/b/887376/epub" rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" />
    <link href="/b/887376/mobi" rel="http://opds-spec.org/acquisition/open-access" type="application/x-mobipocket-ebook" />
    <link href="/b/887376" rel="alternate" type="text/html" title="\u041a\u043d\u0438\u0433\u0430 \u043d\u0430 \u0441\u0430\u0439\u0442\u0435" />
    <id>tag:book:5066e98c8e9da74eca295bc73600d50a</id>
  </entry>
</feed>`;
const AUTHOR_ONLY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>\u041f\u043e \u0430\u0432\u0442\u043e\u0440\u0430\u043c</title>
    <link href="/opds/authorsindex/\u0410" type="application/atom+xml;profile=opds-catalog" />
    <id>tag:root:authors</id>
  </entry>
</feed>`;

describe("flibusta OPDS-\u043f\u0430\u0440\u0441\u0435\u0440", () => {
  it("\u0440\u0430\u0437\u0431\u0438\u0440\u0430\u0435\u0442 \u043a\u043d\u0438\u0436\u043d\u044b\u0439 entry \u043f\u043e\u043b\u043d\u043e\u0441\u0442\u044c\u044e", async () => {
    const m = await flib();
    const b = m.parseEntry(ENTRY_FB2.match(/<entry>[\s\S]*?<\/entry>/)[0]);
    expect(b).not.toBeNull();
    expect(b.id).toBe("tag:book:5066e98c8e9da74eca295bc73600d50a");
    expect(b.bid).toBe(887376);
    expect(b.title).toBe("\u041e\u0442\u043f\u0435\u0447\u0430\u0442\u043a\u0438");
    expect(b.author).toBe("\u041c\u0430\u043c\u043e\u043d \u0410\u043d\u0442\u043e\u043d \u0412\u0430\u0434\u0438\u043c\u043e\u0432\u0438\u0447");
    expect(b.year).toBe(2026);
    expect(b.language).toBe("ru");
    expect(b.genres).toEqual(["\u0422\u0440\u0438\u043b\u043b\u0435\u0440"]);
    expect(Array.isArray(b.formats)).toBe(true);
    expect(b.formats).toContain("fb2");
    expect(b.formats).toContain("epub");
    expect(b.formats).toContain("mobi");
    expect(b.sizeText).toContain("3074");
    expect(b.cover).toContain("/i/76/887376");
  });

  it("\u043f\u0440\u043e\u043f\u0443\u0441\u043a\u0430\u0435\u0442 \u043d\u0435-\u043a\u043d\u0438\u0436\u043d\u044b\u0435 entry (\u043f\u043e\u0434\u043a\u0430\u0442\u0430\u043b\u043e\u0433\u0438)", async () => {
    const m = await flib();
    const b = m.parseEntry(AUTHOR_ONLY.match(/<entry>[\s\S]*?<\/entry>/)[0]);
    expect(b).toBeNull();
  });

  it("parseFeed \u0434\u043e\u0441\u0442\u0430\u0451\u0442 \u043a\u043d\u0438\u0433\u0438 \u0438 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 href", async () => {
    const m = await flib();
    const { books, next } = m.parseFeed(ENTRY_FB2);
    expect(books.length).toBe(1);
    expect(books[0].bid).toBe(887376);
    expect(next).toContain("/opds/new/1/new");
  });
});

describe("flibusta \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u044b\u0439 \u043a\u0430\u0442\u0430\u043b\u043e\u0433", () => {
  it("addBooks \u0434\u0435\u0434\u0443\u043f\u043b\u0438\u0446\u0438\u0440\u0443\u0435\u0442 \u043f\u043e id", async () => {
    const m = await flib();
    m.resetCatalog();
    await m.addBooks([
      { id: "a", bid: 1, title: "X", author: "A" },
      { id: "a", bid: 1, title: "X", author: "A" },
      { id: "b", bid: 2, title: "Y", author: "B" },
    ]);
    expect((await m.catalogStats()).count).toBe(2);
  });

  it("searchCatalog \u0444\u0438\u043b\u044c\u0442\u0440\u0443\u0435\u0442 \u0438 \u043f\u0430\u0433\u0438\u043d\u0438\u0440\u0443\u0435\u0442", async () => {
    const m = await flib();
    m.resetCatalog();
    await m.addBooks([
      { id: "a", bid: 1, title: "\u041f\u0443\u0448\u043a\u0438\u043d. \u0421\u043a\u0430\u0437\u043a\u0438", author: "\u041f\u0443\u0448\u043a\u0438\u043d", year: 1831, language: "ru", genres: ["\u041f\u043e\u044d\u0437\u0438\u044f"] },
      { id: "b", bid: 2, title: "\u041a\u0438\u043d\u0433\u0430\u043a\u043e\u0440\u043d", author: "Rothfuss", year: 2007, language: "ru", genres: ["\u0424\u0430\u043d\u0442\u0430\u0441\u0442\u0438\u043a\u0430"] },
      { id: "c", bid: 3, title: "\u041c\u0430\u0441\u0442\u0435\u0440 \u0438 \u041c\u0430\u0440\u0433\u0430\u0440\u0438\u0442\u0430", author: "\u0411\u0443\u043b\u0433\u0430\u043a\u043e\u0432", year: 1967, language: "ru", genres: ["\u041f\u0440\u043e\u0437\u0430"] },
    ]);
    const res = await m.searchCatalog({ q: "\u043f\u0443\u0448\u043a\u0438\u043d", genre: "" });
    expect(res.total).toBe(1);
    expect(res.items[0].title).toContain("\u041f\u0443\u0448\u043a\u0438\u043d");

    const byYear = await m.searchCatalog({ yearFrom: "1900", yearTo: "2000" });
    expect(byYear.total).toBe(1);
    expect(byYear.items[0].title).toBe("\u041c\u0430\u0441\u0442\u0435\u0440 \u0438 \u041c\u0430\u0440\u0433\u0430\u0440\u0438\u0442\u0430");

    const paged = await m.searchCatalog({ page: 2, pageSize: 2 });
    expect(paged.total).toBe(3);
    expect(paged.items.length).toBe(1);
    expect(paged.hasMore).toBe(false);
  });
});