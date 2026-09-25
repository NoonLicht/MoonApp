import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { createRequire } from "module";

/**
 * Контракт server/bookmarks (CRUD) — изолированный storage (как в
 * tests/backup.test.ts), чтобы не писать в настоящий storage/bookmarks.json
 * разработчика. Сеть (fetch для read-later) здесь не трогаем — это отдельный
 * интеграционный путь; проверяем то, что обязано работать даже без сети.
 */
const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/bookmarks");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-bookmarks-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/bookmarks");
});

describe("server/bookmarks — CRUD без read-later", () => {
  it("create/list/update/remove работают и без сети (saveForLater не указан)", async () => {
    const created = await engine.create({
      url: "https://example.com/",
      title: "Example",
      tags: ["a", "b"],
    });
    expect(created.id).toBeTruthy();
    expect(created.articleNotePath).toBeNull();

    const list1 = engine.list();
    expect(list1).toHaveLength(1);
    expect(list1[0].title).toBe("Example");

    const updated = engine.update(created.id, { title: "Renamed", tags: ["c"] });
    expect(updated?.title).toBe("Renamed");
    expect(updated?.tags).toEqual(["c"]);

    const ok = engine.remove(created.id);
    expect(ok).toBe(true);
    expect(engine.list()).toHaveLength(0);
  });

  it("без title подставляется url", async () => {
    const created = await engine.create({ url: "https://example.org/page" });
    expect(created.title).toBe("https://example.org/page");
  });

  it("update/remove несуществующей записи возвращает null/false", () => {
    expect(engine.update("no-such-id", { title: "x" })).toBeNull();
    expect(engine.remove("no-such-id")).toBe(false);
  });
});

describe("server/bookmarks — режим чтения и постфактум-сохранение статьи (реальный HTTP)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<html><head><title>Test Article</title></head><body>" +
          "<script>should be stripped</script>" +
          "<nav><ul><li>Главная</li><li>Новости</li><li>О сайте</li></ul></nav>" +
          "<header><div>18+</div><div>MWC 2018</div></header>" +
          "<article>" +
          "<h1>Заголовок</h1><p>Первый абзац.</p><p>Второй абзац.</p>" +
          "</article>" +
          "<footer><div>© 1997—2026</div><div>Контакты</div></footer>" +
          "</body></html>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/`;
  });

  afterAll(() => {
    server.close();
  });

  it("fetchArticle скачивает и очищает страницу (без сохранения)", async () => {
    // ИИ-ключ в тестовом storage не настроен — cleanupArticleText внутри
    // fetchArticle падает и тихо откатывается на сырой HTML→текст вырез
    // (см. try/catch в fetchArticle), поэтому проверяем именно его поведение.
    const article = await engine.fetchArticle(baseUrl);
    expect(article.title).toBe("Test Article");
    expect(article.text).toContain("Заголовок");
    expect(article.text).toContain("Первый абзац.");
    expect(article.text).not.toContain("should be stripped");
    // Меню/шапка/подвал должны быть отброшены — берём только текст статьи.
    expect(article.text).not.toContain("Главная");
    expect(article.text).not.toContain("MWC 2018");
    expect(article.text).not.toContain("Контакты");
    // ничего не должно появиться в списке закладок/заметок
    expect(engine.list().find((b) => b.url === baseUrl)).toBeUndefined();
  });

  it("saveArticleFor сохраняет статью для уже существующей закладки", async () => {
    const created = await engine.create({ url: baseUrl, title: "My Article" });
    expect(created.articleNotePath).toBeNull();

    const updated = await engine.saveArticleFor(created.id);
    expect(updated?.articleNotePath).toBe("Read Later/My Article.md");

    const onDisk = engine.list().find((b) => b.id === created.id);
    expect(onDisk?.articleNotePath).toBe("Read Later/My Article.md");
  });

  it("saveArticleFor для несуществующего id возвращает null", async () => {
    expect(await engine.saveArticleFor("no-such-id")).toBeNull();
  });
});
