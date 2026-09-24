import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Встроенный просмотр веб-архива (.sitebak): список страниц и отдача файлов.
 *
 * Проверяем на живом крауле: тест поднимает локальный сайт (страница со ссылкой,
 * картинкой и скриптом), архивирует его и смотрит на архив глазами интерфейса —
 * GET /:id/pages, /:id/file (HTML), /:id/raw/* (ассеты). Ключевая проверка:
 * КАЖДАЯ локальная ссылка из HTML архива должна отдаваться (200) — иначе в
 * превью «битые фото». Ровно это ломалось, когда картинка перекодировалась в
 * .webp, а ссылка в HTML оставалась на .jpg.
 */
const req = createRequire(import.meta.url);

/** Мини-JPEG: содержимое неважно, проверяем отдачу и MIME. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

const REF_RE = (id: string) => new RegExp(`/api/archive/${id}/raw/([^"'#?\\s><)]+)`, "gi");

describe("Встроенный просмотр архива (/api/archive/:id/*)", () => {
  let srv: any = null;
  let site: any = null;
  let base = "";
  let storage = "";
  let engine: any;
  let archiveId = "";
  /** Путь HTML-страницы внутри архива (заполняется в первом тесте). */
  let mainPage = "";

  const pagesOf = async (id: string) => {
    const res = await fetch(`${base}/api/archive/${id}/pages`);
    return { status: res.status, body: await res.json() };
  };
  const get = async (route: string) => {
    const res = await fetch(`${base}/api/archive${route}`);
    const type = res.headers.get("content-type") || "";
    return {
      status: res.status,
      type,
      csp: res.headers.get("content-security-policy"),
      text: type.includes("text/") || type.includes("json") ? await res.text() : "",
      buf:
        type.includes("text/") || type.includes("json")
          ? Buffer.alloc(0)
          : Buffer.from(await res.arrayBuffer()),
    };
  };

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-archview-"));
    process.env.MOONAPP_STORAGE = storage;
    // Этот тест намеренно архивирует локальную фикстуру на 127.0.0.1 — не
    // реальный SSRF, а проверка самого краулера (см. isBlockedHost в
    // server/ts/sitebak.ts и tests/sitebakSsrf.test.ts, где защита проверяется).
    process.env.MOONAPP_ALLOW_LOCAL_CRAWL = "1";

    // Локальный «сайт»: главная со ссылкой на вторую страницу и картинкой.
    const page1 =
      "<!doctype html><html><head><title>Главная — тест</title>" +
      '<link rel="stylesheet" href="/css/site.css">' +
      // Второй стиль подключён АБСОЛЮТНОЙ ссылкой (порт подставляется при отдаче):
      // оба написания адреса должны вшиваться одинаково.
      '<link rel="stylesheet" href="http://127.0.0.1:{PORT}/css/abs.css"></head><body>' +
      '<h1>Привет</h1><img src="/img/pic.jpg" alt="pic">' +
      '<a href="/page2.html">Вторая</a><script>window.x = 1;</script></body></html>';
    const page2 =
      "<!doctype html><html><head><title>Вторая страница</title></head><body>2</body></html>";
    site = http.createServer((rq: any, rs: any) => {
      if (rq.url === "/img/pic.jpg") {
        rs.writeHead(200, { "Content-Type": "image/jpeg" });
        rs.end(JPEG);
        return;
      }
      if (rq.url === "/css/site.css") {
        rs.writeHead(200, { "Content-Type": "text/css" });
        // Фон ссылается на картинку относительным путём — так пишут почти все
        // сайты; в офлайн-превью такой url() должен указывать внутрь архива.
        rs.end("body{background:url(/img/pic.jpg)}");
        return;
      }
      if (rq.url === "/css/abs.css") {
        rs.writeHead(200, { "Content-Type": "text/css" });
        // Здесь url() в кавычках — тоже ходовое написание.
        rs.end('body{background:url("/img/pic.jpg")}');
        return;
      }
      rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      rs.end(
        rq.url === "/page2.html" ? page2 : page1.replace("{PORT}", String(site.address().port)),
      );
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
    const sitePort = site.address().port;

    const express = require("express");
    engine = req("../server/sitebak");
    const router = require("../server/routes/archive");

    // Архивируем локальный сайт: картинки жмём в webp — именно на этом пути
    // ключ файла менялся с .jpg на .webp (см. проверку ссылок ниже).
    const job = engine.startCrawl({
      url: `http://127.0.0.1:${sitePort}/`,
      depth: 1,
      domainScope: "domain",
      maxPages: 10,
      imageMode: "webp",
      videoMode: "ignore",
      stripScripts: true,
      inlineAssets: true,
      blockAds: true,
      stripExif: true,
      delayMs: 0,
      concurrency: 2,
    });
    const t0 = Date.now();
    for (;;) {
      const j = engine.getJob(job.id);
      if (j?.done || j?.stage === "error") break;
      if (Date.now() - t0 > 20000) throw new Error("краул не завершился за 20 с");
      await new Promise((r) => setTimeout(r, 50));
    }
    if (engine.getJob(job.id).stage === "error")
      throw new Error(`краул упал: ${engine.getJob(job.id).error}`);

    const app = express();
    app.use(express.json());
    app.use("/api/archive", router);
    await new Promise<void>((resolve) => {
      srv = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${srv.address().port}`;
    archiveId = job.id;
  });

  afterAll(() => {
    delete process.env.MOONAPP_ALLOW_LOCAL_CRAWL;
    try {
      srv?.close();
      site?.close();
    } catch {
      /* noop */
    }
    try {
      fs.rmSync(storage, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it("архив виден в списке (просмотр открывается с карточки)", async () => {
    const res = await fetch(`${base}/api/archive/list`);
    const list = await res.json();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(archiveId);
    expect(list[0].site).toContain("127.0.0.1");
  });

  it("список страниц архива: заголовки из <title>, только HTML", async () => {
    const { status, body } = await pagesOf(archiveId);
    expect(status).toBe(200);
    expect(body.total).toBe(2); // две html-страницы, картинка в список не попадает
    const titles = body.pages.map((p: any) => p.title).sort();
    expect(titles).toEqual(["Вторая страница", "Главная — тест"]);
    const main: any = body.pages.find((p: any) => p.title === "Главная — тест");
    expect(main.path).toMatch(/\.html$/);
    mainPage = main.path;
  });

  it("страница отдаётся без скриптов и с жёстким CSP (фрейм безопасен)", async () => {
    const r = await get(`/${archiveId}/file?path=${encodeURIComponent(mainPage)}`);
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain("Привет");
    expect(r.text).not.toMatch(/<script/i);
    expect(r.text).not.toMatch(/onclick=/i);
    expect(r.csp).toContain("script-src 'none'");
  });

  it("все локальные ссылки страницы реально отдаются (иначе фото «битые»)", async () => {
    const r = await get(`/${archiveId}/file?path=${encodeURIComponent(mainPage)}`);
    const refs = [...r.text.matchAll(REF_RE(archiveId))].map((m) => m[1]);
    // Картинка + вшитый/подключённый ресурс — ссылки должны быть не пустыми.
    expect(refs.length).toBeGreaterThan(0);
    for (const rel of refs) {
      const asset = await get(`/${archiveId}/raw/${encodeURIComponent(rel)}`);
      expect(asset.status, `ссылка ${rel} не отдаётся`).toBe(200);
    }
  });

  it("картинка отдаётся с MIME по реальному расширению в архиве", async () => {
    const r = await get(`/${archiveId}/file?path=${encodeURIComponent(mainPage)}`);
    const img = new RegExp(
      `/api/archive/${archiveId}/raw/([^"'#?\\s>]+\\.(?:webp|jpg|jpeg|png))`,
      "i",
    ).exec(r.text)?.[1];
    expect(img, "в архиве должна быть ссылка на картинку").toBeTruthy();
    const asset = await get(`/${archiveId}/raw/${encodeURIComponent(img!)}`);
    expect(asset.status).toBe(200);
    expect(asset.buf.length).toBeGreaterThan(0);
    // Расширение ссылки и ответа совпадают: jpg под MIME webp не отдаём.
    if (/\.webp$/i.test(img!)) expect(asset.type).toBe("image/webp");
    else expect(asset.type).toMatch(/^image\//);
  });

  it("старый архив самолечится: ссылка на .jpg отдаёт файл .webp", async () => {
    const r = await get(`/${archiveId}/file?path=${encodeURIComponent(mainPage)}`);
    const img = new RegExp(
      `/api/archive/${archiveId}/raw/([^"'#?\\s><)]+\\.(?:webp|jpe?g|png))`,
      "i",
    ).exec(r.text)?.[1];
    expect(img).toBeTruthy();
    // Так ссылались архивы, собранные до исправления карты ссылок: файл уже
    // перекодирован, а расширение в HTML осталось прежним.
    const wrong = /\.webp$/i.test(img!)
      ? img!.replace(/\.webp$/i, ".jpg")
      : img!.replace(/\.jpg$/i, ".webp");
    const asset = await get(`/${archiveId}/raw/${encodeURIComponent(wrong)}`);
    expect(asset.status).toBe(200);
    expect(asset.buf.length).toBeGreaterThan(0);
  });

  it("вшитые стили не ломают превью: url() в <style> ведёт внутрь архива", async () => {
    const r = await get(`/${archiveId}/file?path=${encodeURIComponent(mainPage)}`);
    // Стили вшиты (inlineAssets, оба — и по относительному href, и по абсолютному),
    // значит внешних /css/ ссылок в разметке быть не должно.
    expect(r.text).not.toMatch(/href=["']\/css\//i);
    expect(r.text).not.toMatch(/href=["']https?:\/\/[^"']*\/css\//i);
    const styles = [...r.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
    expect(styles.length, "обе таблицы стилей должны быть вшиты").toBe(2);
    const body = styles.join("\n");
    expect(body).not.toMatch(/url\(\s*["']?\/img\//);
    // Каждый фон из вшитых стилей должен реально отдаваться превью.
    const bgs = [...body.matchAll(/url\(["']?(\/api\/archive\/[^)"']+)/gi)].map((m) => m[1]);
    expect(bgs.length, "фон из CSS должен указывать внутрь архива").toBe(2);
    for (const bg of bgs) {
      const asset = await get(bg.replace(`/api/archive`, ""));
      expect(asset.status, `фон ${bg} не отдаётся`).toBe(200);
      expect(asset.buf.length).toBeGreaterThan(0);
    }
  });

  it("traversal и отсутствующие файлы не отдаются", async () => {
    expect((await get(`/${archiveId}/file?path=..%2Farchives.json`)).status).toBe(400);
    expect((await get(`/${archiveId}/raw/..%2F..%2Farchives.json`)).status).toBe(400);
    expect((await get(`/${archiveId}/file?path=нет-такого.html`)).status).toBe(404);
    expect((await get(`/нет-такого-архива/pages`)).status).toBe(404);
  });
});

/**
 * Окно просмотра должно быть КЛИКАБЕЛЬНЫМ и не «протекать» в страницу архива.
 *
 * Реальная жалоба: «нет прокрутки — колесо крутит задний фон, список страниц
 * слева не выбирается, крестик не нажимается». Окно рисуется порталом в
 * #overlay-root, а у хоста в theme.css стоит `pointer-events: none` (пустой узел
 * не должен перехватывать клики) — значит сама модалка обязана включить клики
 * себе. У .arch-view-overlay этого свойства не было, и события уходили сквозь
 * окно на страницу под ним.
 */
describe("окно просмотра архива: клики и прокрутка не уходят на страницу", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "..", "src", "styles", "arch.css"), "utf8");
  const theme = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "styles", "theme.css"),
    "utf8",
  );
  // Геометрия модалок вынесена в общий слой .app-modal-backdrop (ui.css): он
  // начинается ПОД верхней панелью приложения и центрирует карточку.
  const uiCss = fs.readFileSync(path.resolve(__dirname, "..", "src", "styles", "ui.css"), "utf8");
  const page = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "pages", "archiver", "ArchiverPage.tsx"),
    "utf8",
  );

  it("хост порталов действительно не перехватывает клики", () => {
    expect(/\.overlay-root\s*\{[^}]*pointer-events:\s*none/s.test(theme)).toBe(true);
  });

  it(".arch-view-overlay включает клики себе (иначе колесо крутит фон)", () => {
    const rule = /\.arch-view-overlay\s*\{([^}]*)\}/s.exec(css)?.[1] || "";
    expect(rule).toMatch(/pointer-events:\s*auto/);
    // Геометрию (fixed, отступ под верхней панелью, центрирование) задаёт общий
    // слой модалок: окно архива больше не накрывает меню приложения.
    const layer = /\.app-modal-backdrop\s*\{([^}]*)\}/s.exec(uiCss)?.[1] || "";
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/pointer-events:\s*auto/);
    expect(layer).toMatch(/top:\s*var\(--content-top\)/);
    expect(layer).toMatch(/align-items:\s*center/);
  });

  it("окно монтируется порталом в #overlay-root и закрывается по Esc", () => {
    expect(page).toContain("getOverlayRoot() ?? document.body");
    expect(page).toMatch(/if \(e\.key === "Escape"\) setViewer\(null\)/);
  });

  it("внутри окна есть свои скроллы: список страниц и фрейм", () => {
    const list = /\.arch-view-list\s*\{([^}]*)\}/s.exec(css)?.[1] || "";
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/\.arch-view-iframe\s*\{[^}]*height:\s*100%/s);
  });
});
