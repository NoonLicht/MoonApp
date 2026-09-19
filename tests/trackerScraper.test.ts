import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { encodeCp1251 } from "../server/charset";

/**
 * Скрапер форума (server/trackerScraper) — сетевая часть.
 *
 * Реальную сеть не трогаем: подменяем глобальный fetch «форумом», который ведёт
 * себя как rutracker.org (cp1251-страницы, форма login.php, таблица #tor-tbl,
 * Set-Cookie bb_data). Так проверяются именно те места, где легко ошибиться:
 * переиспользование куки, повторный вход при истёкшей сессии, cp1251 в строке
 * поиска, сортировка по сидам, кэш результатов.
 *
 * ВАЖНО про порядок: тест «нет ключей» идёт первым, пока секрет с логином ещё
 * не сохранён (секреты лежат в файле storage, удалять их API не умеет).
 */
const req = createRequire(import.meta.url);
const realFetch = globalThis.fetch;
const fetcher = vi.fn();

let scraper: any;
let settings: any;
let security: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-tracker-"));
  scraper = req("../server/trackerScraper");
  settings = req("../server/settings");
  security = req("../server/security");
  vi.stubGlobal("fetch", fetcher);
});

beforeEach(() => {
  fetcher.mockReset();
  // Площадку задаём явно пресетом: этот набор проверяет phpBB-движок (rutracker),
  // а трекер ПО УМОЛЧАНИЮ в приложении — rutor (server/ts/trackerProviders.ts).
  scraper.applyTrackerPreset("rutracker");
  // Троттлинг форума в тестах выключаем (в проде — 1200 мс между запросами).
  settings.set({ trackers: { enabled: true, minIntervalMs: 0, maxResults: 50 } });
  scraper.clearTrackerCache();
});

const LOGIN_FORM = `<html><body><form action="login.php" method="post">
  <input type="hidden" name="creation_time" value="1700000000">
  <input type="text" name="login_username"><input type="password" name="login_password">
  </form></body></html>`;
const LOGGED_IN = `<html><body><a href="login.php?logout=1">Выход [user]</a></body></html>`;

/** Выдача: 5 сидов, 42 сида и одна раздача вообще без ссылок на файлы. */
const SEARCH_HTML = `<html><body><table id="tor-tbl"><tbody>
<tr id="trs-tr-111"><td><a href="viewtopic.php?t=111">Фильм (2021) [BDRip 1080p x264] Дубляж</a>
  <a href="dl.php?t=111">.torrent</a></td><td>1.4 GB</td>
  <td class="seedmed">5</td><td class="leechmed">1</td></tr>
<tr id="trs-tr-222"><td><a href="viewtopic.php?t=222">Фильм (2021) [WEB-DL 2160p x265] MVO</a>
  <a href="magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd">M</a>
  <a href="dl.php?t=222">.torrent</a></td><td>12.5 GB</td>
  <td class="seedmed">42</td><td class="leechmed">3</td></tr>
<tr id="trs-tr-333"><td><a href="viewtopic.php?t=333">Фильм без файлов</a></td><td>700 MB</td>
  <td class="seedmed">99</td><td class="leechmed">0</td></tr>
</tbody></table></body></html>`;

const NO_RESULTS_HTML = `<html><body><h2>Результатов поиска: 0</h2><p>Ничего не найдено</p></body></html>`;

/** Страница-проверка Cloudflare: именно её отдаёт rutracker на tracker.php. */
const CF_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
<body><div id="cf-wrapper">Checking your browser before accessing rutracker.org</div>
<noscript>Please enable JavaScript and cookies to continue</noscript></body></html>`;

/** Ответ «как от форума»: cp1251-байты — иначе русский текст не прочитается. */
function forumBody(html: string): Buffer {
  return Buffer.from(encodeCp1251(html));
}

/** Мок форума: страница входа, успешный POST, проверка сессии и выдача. */
function mockForum(opts: { searchHtml?: string; loggedOut?: boolean; searchStatus?: number } = {}) {
  fetcher.mockImplementation(async (url: unknown, init: RequestInit = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.includes("login.php")) {
      if (method === "POST") {
        return new Response(forumBody(LOGGED_IN), {
          status: 200,
          headers: { "set-cookie": "bb_data=session123; path=/; HttpOnly" },
        });
      }
      return new Response(forumBody(LOGIN_FORM), {
        status: 200,
        headers: { "set-cookie": "bb_ssl=1; path=/" },
      });
    }
    if (u.includes("tracker.php")) {
      if (method === "POST") {
        return new Response(forumBody(opts.searchHtml || SEARCH_HTML), {
          status: opts.searchStatus || 200,
        });
      }
      // GET на страницу поиска — проверка «жива ли сессия».
      return new Response(forumBody(opts.loggedOut ? LOGIN_FORM : LOGGED_IN), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

/** Сколько раз ходили на страницу входа (GET формы + POST логина). */
function loginCalls(): number {
  return fetcher.mock.calls.filter((c) => String(c[0]).includes("login.php")).length;
}

/** Сохранить логин/пароль в секреты (иначе поиск вернёт no_credentials). */
function withCredentials() {
  security.setSecret("tracker", JSON.stringify({ login: "user", password: "pa55" }));
}

describe("trackerScraper — вход и поиск", () => {
  it("без логина/пароля → no_credentials (в сеть не ходим)", async () => {
    // Первый тест в файле: секрет ещё не сохранён.
    mockForum();
    await expect(scraper.searchTrackerReleases("матрица")).rejects.toMatchObject({
      code: "no_credentials",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("логинится, ищет, сортирует по сидам и кэширует результат", async () => {
    withCredentials();
    mockForum();

    const first = await scraper.searchTrackerReleases("матрица");
    expect(first.cached).toBe(false);
    expect(first.via).toBe("direct");
    // Сортировка по сидам: 42 → 5; раздача без magnet/.torrent отброшена.
    expect(first.items.map((i: { seeders: number }) => i.seeders)).toEqual([42, 5]);
    expect(first.items[0]).toMatchObject({ id: "222", size: "12.5 GB" });
    expect(first.items[0].torrentUrl).toBe("https://rutracker.org/forum/dl.php?t=222");
    expect(first.items[0].magnet).toContain("magnet:?xt=urn:btih:");
    expect(first.items[0].meta).toMatchObject({ resolution: "4K", codec: "x265 (HEVC)" });
    expect(first.items[1].meta).toMatchObject({ resolution: "1080p", codec: "x264" });
    expect(first.total).toBe(3); // найдено 3, показано 2

    // GET формы входа + POST логина (+ GET проверки сессии) + POST поиска.
    expect(loginCalls()).toBe(2);

    // Повторный тот же запрос — из кэша, в сеть не ходим.
    const again = await scraper.searchTrackerReleases("матрица");
    expect(again.cached).toBe(true);
    expect(fetcher.mock.calls.length).toBe(4);

    // Другой запрос — сессия переиспользуется, входа больше нет.
    const second = await scraper.searchTrackerReleases("другой фильм");
    expect(second.cached).toBe(false);
    expect(loginCalls()).toBe(2);

    // forceRefresh обходит кэш.
    const forced = await scraper.searchTrackerReleases("матрица", { forceRefresh: true });
    expect(forced.cached).toBe(false);

    // Сессия (куки bb_data) сохранена на диск — переживёт перезапуск.
    const files = fs.readdirSync(path.join(process.env.MOONAPP_STORAGE as string, "trackers"));
    expect(files.some((f) => f.startsWith("session-"))).toBe(true);
  });

  it("строка поиска уходит в cp1251 — именно так её ждёт форум", async () => {
    withCredentials();
    mockForum();
    await scraper.searchTrackerReleases("ёж");
    const post = fetcher.mock.calls.find(
      (c) => String(c[1]?.method).toUpperCase() === "POST" && String(c[0]).includes("tracker.php"),
    );
    // «ёж» в cp1251 = B8 E6, в UTF-8 было бы D1 91 D0 B6.
    expect(String(post?.[1]?.body)).toBe("nm=%B8%E6");
  });

  it("истёкшая сессия: форум отдал форму входа → перелогин и повтор запроса", async () => {
    withCredentials();
    let searches = 0;
    fetcher.mockImplementation(async (url: unknown, init: RequestInit = {}) => {
      const u = String(url);
      const method = String(init.method || "GET").toUpperCase();
      if (u.includes("login.php")) {
        return new Response(forumBody(method === "POST" ? LOGGED_IN : LOGIN_FORM), {
          status: 200,
          headers: { "set-cookie": "bb_data=fresh; path=/" },
        });
      }
      if (u.includes("tracker.php")) {
        if (method === "POST") {
          searches += 1;
          // Первый поиск — «вы разлогинены», второй (после входа) — выдача.
          return new Response(forumBody(searches === 1 ? LOGIN_FORM : SEARCH_HTML), {
            status: 200,
          });
        }
        return new Response(forumBody(LOGGED_IN), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });

    const res = await scraper.searchTrackerReleases("матрица");
    expect(searches).toBe(2);
    expect(res.items.length).toBeGreaterThan(0);
  });

  it("пустая выдача — норма, а не ошибка разбора", async () => {
    withCredentials();
    mockForum({ searchHtml: NO_RESULTS_HTML });
    const res = await scraper.searchTrackerReleases("нет-такого-фильма");
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("непонятная разметка → parse_failed (с понятным текстом)", async () => {
    withCredentials();
    mockForum({ searchHtml: "<html><body><p>совсем другая страница</p></body></html>" });
    await expect(scraper.searchTrackerReleases("матрица")).rejects.toMatchObject({
      code: "parse_failed",
    });
  });

  it("выключенный поиск → tracker_disabled, слишком длинный запрос → bad_query", async () => {
    settings.set({ trackers: { enabled: false } });
    await expect(scraper.searchTrackerReleases("матрица")).rejects.toMatchObject({
      code: "tracker_disabled",
    });
    settings.set({ trackers: { enabled: true } });
    await expect(scraper.searchTrackerReleases("x".repeat(300))).rejects.toMatchObject({
      code: "bad_query",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("сбой сети → network_error (а не сырое исключение fetch)", async () => {
    withCredentials();
    fetcher.mockImplementation(async () => {
      throw new Error("ENETUNREACH");
    });
    await expect(scraper.searchTrackerReleases("матрица")).rejects.toMatchObject({
      code: "network_error",
    });
  });
});

describe("trackerScraper — Cloudflare, диагностика и куки", () => {
  it("страница-проверка Cloudflare → cf_challenge с диагностикой (а не «вход выполнен»)", async () => {
    withCredentials();
    // Так ведёт себя rutracker с нештатного IP: и login.php, и tracker.php
    // отдают челлендж. Раньше такая страница считалась «вошли» и падала на разборе.
    fetcher.mockImplementation(
      async () =>
        new Response(forumBody(CF_PAGE), {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        }),
    );
    let caught: any = null;
    try {
      await scraper.searchTrackerReleases("матрица");
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe("cf_challenge");
    expect(caught?.details).toMatchObject({ status: 403, cloudflare: true });
    expect(String(caught?.details?.snippet)).toContain("Just a moment");
    // Диагностика транспорта: видно, шёл запрос стеком Chromium (cf_clearance
    // подходит) или обычным fetch (Cloudflare считает его ботом), каким UA и прокси.
    expect(caught?.details?.transport).toBe("fetch");
    expect(typeof caught?.details?.userAgent).toBe("string");
    expect(caught?.details?.proxy).toBeNull();
    expect(Array.isArray(caught?.details?.cookies)).toBe(true);
    // Признак входа — булев: по нему видно, ушёл запрос гостем или вошедшим.
    expect(typeof caught?.details?.hasLogin).toBe("boolean");
    // Ошибка запоминается для /tracker/status.
    expect(scraper.trackerStatus().lastError?.code).toBe("cf_challenge");
  });

  it("гостевая сессия без логина и пароля → no_credentials (а не «не разобрали страницу»)", async () => {
    // Куки есть, но это гость (нет bb_data): поиск ушёл бы гостем и получил
    // проверку Cloudflare — просим вход, а не показываем непонятную ошибку.
    security.setSecret("tracker", "");
    scraper.importTrackerCookies("bb_guid=g1; bb_ssl=1; bb_session=s1; cf_clearance=cf1");
    fetcher.mockImplementation(async () => new Response(forumBody(LOGIN_FORM), { status: 200 }));
    await expect(scraper.searchTrackerReleases("матрица")).rejects.toMatchObject({
      code: "no_credentials",
    });
    withCredentials();
  });

  it("непонятная страница → parse_failed с диагностикой (статус, размер, сниппет)", async () => {
    withCredentials();
    mockForum({ searchHtml: "<html><body><p>совсем другая страница</p></body></html>" });
    let caught: any = null;
    try {
      await scraper.searchTrackerReleases("матрица");
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe("parse_failed");
    expect(caught?.details).toMatchObject({ status: 200, cloudflare: false, loginForm: false });
    expect(String(caught?.details?.snippet)).toContain("другая страница");
    expect(caught?.details?.bytes).toBeGreaterThan(0);
  });

  it("пароль не принят (форум вернул форму входа) → login_failed с диагностикой", async () => {
    withCredentials();
    fetcher.mockImplementation(async () => new Response(forumBody(LOGIN_FORM), { status: 200 }));
    let caught: any = null;
    try {
      await scraper.trackerLogin();
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe("login_failed");
    expect(caught?.details).toMatchObject({ loginForm: true, cloudflare: false });
  });

  it("импорт куки из браузера: сохраняются, видны в статусе и уходят в запросы", async () => {
    withCredentials();
    const res = scraper.importTrackerCookies("cf_clearance=abc123; bb_data=xyz; path=/; HttpOnly");
    expect(res.cookies.sort()).toEqual(["bb_data", "cf_clearance"]);
    expect(scraper.trackerStatus().cookieNames).toEqual(
      expect.arrayContaining(["cf_clearance", "bb_data"]),
    );

    mockForum();
    await scraper.searchTrackerReleases("матрица");
    const post = fetcher.mock.calls.find(
      (c) => String(c[1]?.method).toUpperCase() === "POST" && String(c[0]).includes("tracker.php"),
    );
    expect(String(post?.[1]?.headers?.Cookie)).toContain("cf_clearance=abc123");

    // Функция синхронная: пустую строку она отклоняет исключением.
    let code = "";
    try {
      scraper.importTrackerCookies("   ");
    } catch (e) {
      code = (e as { code?: string }).code || "";
    }
    expect(code).toBe("bad_query");
  });

  it("parseCookieString: строка, заголовок Cookie и JSON", () => {
    expect(scraper.parseCookieString("a=1; b=2; path=/")).toEqual({ a: "1", b: "2" });
    expect(scraper.parseCookieString("Cookie: cf_clearance=x; bb_data=y")).toEqual({
      cf_clearance: "x",
      bb_data: "y",
    });
    expect(scraper.parseCookieString('{"cf_clearance":"x","bb_data":""}')).toEqual({
      cf_clearance: "x",
    });
    expect(scraper.parseCookieString("")).toEqual({});
    expect(scraper.parseCookieString(null)).toEqual({});
  });
});

describe("trackerScraper — статус и скачивание .torrent", () => {
  it("статус: только флаги, пароль наружу не отдаётся", () => {
    const st = scraper.trackerStatus();
    expect(st.baseUrl).toBe("https://rutracker.org");
    expect(st.hasCredentials).toBe(true);
    expect(typeof st.session.ok).toBe("boolean");
    expect(JSON.stringify(st)).not.toContain("pa55");
  });

  it("HTML вместо .torrent → torrent_download_failed (мусор в клиент не уйдёт)", async () => {
    withCredentials();
    fetcher.mockImplementation(async () => new Response("<html>войдите</html>", { status: 200 }));
    await expect(scraper.downloadTrackerTorrent("111")).rejects.toMatchObject({
      code: "torrent_download_failed",
    });
  });

  it("валидный .torrent отдаётся с именем из Content-Disposition; битый id отклоняется", async () => {
    withCredentials();
    const bencode = Buffer.from("d4:infod4:name4:teste", "latin1");
    fetcher.mockImplementation(
      async () =>
        new Response(bencode, {
          status: 200,
          headers: {
            "content-disposition":
              "attachment; filename*=UTF-8''%D1%84%D0%B8%D0%BB%D1%8C%D0%BC.torrent",
          },
        }),
    );
    const out = await scraper.downloadTrackerTorrent("222");
    expect(out.name).toBe("фильм.torrent");
    expect(out.buffer[0]).toBe(0x64); // 'd' — bencode-словарь

    const before = fetcher.mock.calls.length;
    await expect(scraper.downloadTrackerTorrent("не-число")).rejects.toMatchObject({
      code: "bad_release",
    });
    expect(fetcher.mock.calls.length).toBe(before); // валидация до сети
  });

  it("logout забывает сессию на диске", () => {
    expect(scraper.trackerLogout()).toEqual({ ok: true });
    const dir = path.join(process.env.MOONAPP_STORAGE as string, "trackers");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files.some((f) => f.startsWith("session-"))).toBe(false);
  });
});

describe("trackerScraper — подхват куки и Chromium-транспорт", () => {
  it("cookiesHaveLogin: вход отмечает только bb_data, а не гостевые куки", () => {
    expect(scraper.cookiesHaveLogin({ bb_data: "x" })).toBe(true);
    // Гостевые куки форума: bb_guid/bb_ssl/bb_session он ставит и без входа, bb_t —
    // трекинг. Считать их входом = закрывать окно входа до логина (ломало поиск).
    expect(scraper.cookiesHaveLogin({ bb_session: "x" })).toBe(false);
    expect(scraper.cookiesHaveLogin({ bb_guid: "x", bb_ssl: "1" })).toBe(false);
    expect(scraper.cookiesHaveLogin({ bb_t: "x" })).toBe(false);
    // cf_clearance — это только пройденная проверка Cloudflare, а не вход.
    expect(scraper.cookiesHaveLogin({ cf_clearance: "x" })).toBe(false);
    expect(scraper.cookiesHaveLogin({})).toBe(false);
  });

  it("статус не считает гостевые куки живой сессией", async () => {
    withCredentials();
    scraper.importTrackerCookies("bb_guid=g1; bb_ssl=1; bb_session=s1; cf_clearance=cf1");
    const st = scraper.trackerStatus();
    // Куки есть (Cloudflare пройден), но входа нет — UI должен просить вход.
    expect(st.cookieNames).toEqual(expect.arrayContaining(["cf_clearance", "bb_session"]));
    expect(st.session.ok).toBe(false);
    expect(st.chromium.loggedIn).toBe(false);
  });

  it("вне Electron Chromium-транспорт недоступен (тесты идут обычным fetch)", () => {
    expect(scraper.chromiumTransportAvailable()).toBe(false);
  });

  it("cookieDomainMatches: домен куки покрывает хост и поддомены", () => {
    expect(scraper.cookieDomainMatches(".rutracker.org", "rutracker.org")).toBe(true);
    expect(scraper.cookieDomainMatches("rutracker.org", "rutracker.org")).toBe(true);
    expect(scraper.cookieDomainMatches(".rutracker.org", "forum.rutracker.org")).toBe(true);
    expect(scraper.cookieDomainMatches(".example.com", "rutracker.org")).toBe(false);
    // Кука без домена считается своей: раздел окна входа отдельный.
    expect(scraper.cookieDomainMatches("", "rutracker.org")).toBe(true);
  });

  /**
   * Главная регрессия окна входа: куки сессии форума лежат с `Path=/forum/`, поэтому
   * `cookies.get({ url })` их не возвращал, и вход выглядел невыполненным. Плюс UA
   * окна входа нельзя перебивать своим — иначе Cloudflare снова отдаёт проверку.
   */
  it("Chromium-транспорт: куки с Path=/forum/ подхватываются, UA окна не перебивается", async () => {
    withCredentials();
    settings.set({ trackers: { userAgent: "" } });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const WINDOW_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.6478.234 Safari/537.36";
    const setUserAgent = vi.fn(async () => undefined);
    const fake = {
      fetch: async (url: string, init: { headers?: Record<string, string> }) => {
        seen.push({ url: String(url), headers: (init?.headers || {}) as Record<string, string> });
        return new Response(forumBody(SEARCH_HTML), { status: 200 });
      },
      cookies: {
        // Electron без фильтра отдаёт ВСЕ куки раздела — так и должны выглядеть данные.
        get: async (filter?: unknown) => {
          expect(filter).toEqual({});
          return [
            { name: "bb_data", value: "session123", domain: ".rutracker.org", path: "/forum/" },
            { name: "cf_clearance", value: "cf1", domain: ".rutracker.org", path: "/" },
            { name: "yt", value: "чужое", domain: ".youtube.com", path: "/" },
          ];
        },
        remove: async () => undefined,
      },
      getUserAgent: () => WINDOW_UA,
      setUserAgent,
    };
    scraper.bindChromiumSession(fake);
    try {
      expect(scraper.chromiumTransportAvailable()).toBe(true);
      const res = await scraper.searchTrackerReleases("матрица");
      expect(res.items.length).toBeGreaterThan(0);

      const search = seen.find((s) => s.url.includes("tracker.php"));
      expect(search).toBeTruthy();
      // Кука с путём /forum/ дошла до форума, чужая (youtube) — нет.
      expect(search!.headers.Cookie).toContain("bb_data=session123");
      expect(search!.headers.Cookie).toContain("cf_clearance=cf1");
      expect(search!.headers.Cookie).not.toContain("youtube");
      // UA — как у окна входа (в настройках UA пусто), сессию не перебиваем.
      expect(search!.headers["User-Agent"]).toBe(WINDOW_UA);
      expect(setUserAgent).not.toHaveBeenCalled();
      // Логин с паролем не понадобился: вход в окне считается выполненным.
      expect(loginCalls()).toBe(0);
      // Статус это тоже видит — UI покажет «Вход выполнен».
      const st = scraper.trackerStatus();
      expect(st.chromium.loggedIn).toBe(true);
      expect(st.cookieNames).toEqual(expect.arrayContaining(["bb_data", "cf_clearance"]));
    } finally {
      scraper.bindChromiumSession(null);
    }
  });

  it("Chromium-транспорт: заданный в настройках UA ставится сессии (окно и поиск совпадают)", async () => {
    withCredentials();
    const setUserAgent = vi.fn(async () => undefined);
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0 Safari/537.36";
    settings.set({ trackers: { userAgent: ua } });
    const fake = {
      fetch: async () => new Response(forumBody(SEARCH_HTML), { status: 200 }),
      cookies: {
        get: async () => [{ name: "bb_data", value: "s", domain: ".rutracker.org", path: "/forum/" }],
        remove: async () => undefined,
      },
      getUserAgent: () => "старый-ua",
      setUserAgent,
    };
    scraper.bindChromiumSession(fake);
    try {
      await scraper.searchTrackerReleases("матрица");
      expect(setUserAgent).toHaveBeenCalledWith(ua, expect.stringContaining("ru-RU"));
    } finally {
      scraper.bindChromiumSession(null);
      settings.set({ trackers: { userAgent: "" } });
    }
  });

  it("chromiumUaUsable: UA с Electron-токеном для форума не годится", () => {
    expect(
      scraper.chromiumUaUsable(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.6478.234 Safari/537.36",
      ),
    ).toBe(true);
    // Именно такой UA у Chromium приложения — Cloudflare на него отдаёт проверку.
    expect(
      scraper.chromiumUaUsable(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoonApp/0.2.2 Chrome/126.0.6478.234 Electron/31.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(scraper.chromiumUaUsable("")).toBe(false);
  });

  it("Chromium-транспорт: UA приложения (Electron) заменяется на обычный Chrome", async () => {
    withCredentials();
    settings.set({ trackers: { userAgent: "" } });
    const seen: Record<string, string>[] = [];
    const setUserAgent = vi.fn(async () => undefined);
    const fake = {
      fetch: async (_url: string, init: { headers?: Record<string, string> }) => {
        seen.push((init?.headers || {}) as Record<string, string>);
        return new Response(forumBody(SEARCH_HTML), { status: 200 });
      },
      cookies: {
        get: async () => [{ name: "bb_data", value: "s", domain: ".rutracker.org", path: "/forum/" }],
        remove: async () => undefined,
      },
      // Дефолтный UA Electron-браузера: содержит имя приложения и Electron.
      getUserAgent: () =>
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoonApp/0.2.2 Chrome/126.0.6478.234 Electron/31.0.0 Safari/537.36",
      setUserAgent,
    };
    scraper.bindChromiumSession(fake);
    try {
      await scraper.searchTrackerReleases("матрица");
      expect(setUserAgent).toHaveBeenCalledWith(
        expect.stringContaining("Chrome/"),
        expect.stringContaining("ru-RU"),
      );
      expect(seen[0]["User-Agent"]).toContain("Chrome/");
      expect(seen[0]["User-Agent"]).not.toContain("Electron");
    } finally {
      scraper.bindChromiumSession(null);
    }
  });

  it("importCookiesFromBrowsers: куки сохраняются, UA подставляется, проба возвращается", async () => {
    withCredentials();
    const probe = {
      id: "chrome",
      browser: "Google Chrome",
      profile: "Default",
      version: "126.0.6478.127",
      cookies: 2,
      reason: "",
    };
    const res = await scraper.importCookiesFromBrowsers({
      collect: () => ({ cookies: { cf_clearance: "cf", bb_data: "bd" }, probes: [probe], source: probe }),
      probe: async () => ({ status: 200, authorized: true, loginForm: false, cloudflare: false }),
    });

    expect(res.ok).toBe(true);
    expect(res.cookies.sort()).toEqual(["bb_data", "cf_clearance"]);
    expect(res.source?.browser).toBe("Google Chrome");
    // UA браузера-источника обязателен: cf_clearance привязан к паре «IP + UA».
    expect(res.userAgent).toContain("Chrome/126.0.6478.127");
    expect(String(settings.get("trackers").userAgent)).toContain("Chrome/126.0.6478.127");
    expect(res.probe.authorized).toBe(true);

    const st = scraper.trackerStatus();
    expect(st.cookieNames).toEqual(expect.arrayContaining(["cf_clearance", "bb_data"]));
    // Окно входа вне Electron недоступно — UI предложит вставку куки.
    expect(st.chromium.available).toBe(false);
    expect(st.loginUrl).toContain("login.php");
  });

  it("importCookiesFromBrowsers: браузеры без куки → ok:false и список проверенного", async () => {
    withCredentials();
    const res = await scraper.importCookiesFromBrowsers({
      collect: () => ({
        cookies: {},
        probes: [
          {
            id: "edge",
            browser: "Microsoft Edge",
            profile: "Default",
            version: "153.0.4234.32",
            cookies: 0,
            reason: "куки rutracker.org не найдены, 2 не расшифровано",
          },
        ],
        source: null,
      }),
      probe: async () => ({}),
    });
    // Это не ошибка, а факт: UI покажет причины (например app-bound encryption).
    expect(res.ok).toBe(false);
    expect(res.cookies).toEqual([]);
    expect(res.probes[0].reason).toContain("не расшифровано");
  });
});
/**
 * Трекер БЕЗ входа: rutor.info.
 *
 * Ключевые отличия от rutracker, которые здесь и проверяются:
 *  - строка поиска уходит ЧАСТЬЮ ПУТИ (`/search/0/0/000/0/<запрос>`), а не
 *    POST-полем `nm`, и в utf-8 (пробелы — %20, а не «+»: в пути «+» литеральный);
 *  - вход не нужен: ни логина с паролем, ни куки сессии (код no_credentials
 *    появляться не должен);
 *  - выдача разбирается движком rutor (строки tr.gai/tr.tum);
 *  - .torrent лежит на поддомене, поэтому торрент-URL абсолютный.
 */
const RUTOR_SEARCH_HTML = `<html><body>
<div id="index">Результатов поиска 12 (max. 2000)<table width="100%">
<tr class="backgr"><td>Добавлен</td><td>Название</td><td>Размер</td><td>Пиры</td></tr>
<tr class="gai"><td>06&nbsp;Сен&nbsp;26</td><td colspan = "2"><a class="downgif" href="//d.rutor.info/download/1105259"></a><a href="magnet:?xt=urn:btih:06555d165746e815b0ab5b16de37ed24f9142595&amp;dn=rutor.info"></a>
<a href="/torrent/1105259/bad-matrix-2026-mp3">Bad Matrix (2026) MP3 </a></td>
<td align="right">82.73&nbsp;MB</td><td align="center"><span class="green">&nbsp;3</span>&nbsp;<span class="red">&nbsp;0</span></td></tr>
<tr class="tum"><td>09&nbsp;Июл&nbsp;26</td><td ><a class="downgif" href="//d.rutor.info/download/1098254"></a>
<a href="/torrent/1098254/matrica-kvadrologija-1999-2021-uhd-bdremux-2160p">Матрица. Квадрология (1999-2021) UHD BDRemux 2160p | 4K | HDR </a></td>
<td align="right">265.94&nbsp;GB</td><td align="center"><span class="green">&nbsp;11</span>&nbsp;<span class="red">&nbsp;2</span></td></tr>
</table></div></body></html>`;

/** Мок rutor: поиск частью пути, ответ utf-8, формы входа на странице нет. */
function mockRutor(opts: { searchHtml?: string; status?: number } = {}) {
  fetcher.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/search/")) {
      return new Response(opts.searchHtml || RUTOR_SEARCH_HTML, {
        status: opts.status || 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

/** Выполнить проверку на пресете rutor и вернуть настройки rutracker обратно. */
async function withRutor(fn: () => Promise<void> | void): Promise<void> {
  scraper.applyTrackerPreset("rutor");
  try {
    await fn();
  } finally {
    scraper.applyTrackerPreset("rutracker");
  }
}

describe("trackerScraper — трекер без входа (rutor)", () => {
  it("пресет применяется целиком, пользовательские настройки сохраняются", async () => {
    await withRutor(() => {
      const cfg = scraper.trackerCfg();
      expect(cfg.engine).toBe("rutor");
      expect(cfg.baseUrl).toBe("https://rutor.info");
      expect(cfg.searchPath).toBe("/search/0/0/000/0/{q}");
      expect(cfg.encoding).toBe("utf-8");
      expect(cfg.requiresLogin).toBe(false);
      expect(cfg.torrentPath).toBe("https://d.rutor.info/download/{id}");
      // Пауза/лимит — предпочтения пользователя (выставлены в beforeEach).
      expect(cfg.minIntervalMs).toBe(0);
      expect(cfg.maxResults).toBe(50);
    });
  });

  it("неизвестный трекер → bad_query", async () => {
    let code = "";
    try {
      scraper.applyTrackerPreset("nnmclub");
    } catch (e) {
      code = (e as { code?: string }).code || "";
    }
    expect(code).toBe("bad_query");
  });

  it("поиск уходит в путь (/search/0/0/000/0/<utf-8>) и не требует входа", async () => {
    await withRutor(async () => {
      mockRutor();
      // Убираем логин/пароль: у rutor они не нужны, и поиск обязан работать.
      security.setSecret("tracker", "");
      try {
        const res = await scraper.searchTrackerReleases("матрица воскрешение", {
          forceRefresh: true,
        });
        const urls = fetcher.mock.calls.map((c) => String(c[0]));
        // Пробел — %20: в пути «+» был бы литеральным плюсом в названии.
        expect(urls[0]).toBe(
          "https://rutor.info/search/0/0/000/0/%D0%BC%D0%B0%D1%82%D1%80%D0%B8%D1%86%D0%B0%20%D0%B2%D0%BE%D1%81%D0%BA%D1%80%D0%B5%D1%88%D0%B5%D0%BD%D0%B8%D0%B5",
        );
        expect(urls.some((u) => /login|users\.php/i.test(u))).toBe(false);
        expect(res.items).toHaveLength(2);
        // Сортировка по сидам — как у rutracker (11 > 3).
        expect(res.items[0].id).toBe("1098254");
        expect(res.items[0].size).toBe("265.94 GB");
        expect(res.items[0].seeders).toBe(11);
        expect(res.items[0].torrentUrl).toBe("https://d.rutor.info/download/1098254");
        expect(res.items[0].topicUrl).toBe("https://rutor.info/torrent/1098254");
        expect(res.items[1].magnet).toContain("magnet:?xt=urn:btih:06555d");
      } finally {
        withCredentials(); // секрет нужен остальным тестам файла
      }
    });
  });


it("пустая выдача («Результатов поиска 0») — норма, а не ошибка разбора", async () => {
    await withRutor(async () => {
      mockRutor({ searchHtml: '<div id="index">Результатов поиска 0 (max. 2000)</div>' });
      const res = await scraper.searchTrackerReleases("заведомо-нет", { forceRefresh: true });
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
    });
  });

  it("Cloudflare: cf_challenge, но hasLogin не врёт (вход движку не нужен)", async () => {
    await withRutor(async () => {
      mockRutor({ searchHtml: CF_PAGE, status: 403 });
      let err: { code?: string; details?: { hasLogin?: boolean; cookies?: string[] } } = {};
      try {
        await scraper.searchTrackerReleases("матрица", { forceRefresh: true });
        throw new Error("ожидалась ошибка cf_challenge");
      } catch (e) {
        err = e as typeof err;
      }
      expect(err.code).toBe("cf_challenge");
      // Куки пусты, но «нет входа» — не причина: у rutor входа нет вовсе.
      expect(err.details?.cookies).toEqual([]);
      expect(err.details?.hasLogin).toBe(true);
    });
  });

  it("статус: движок, «вход не нужен» и список трекеров для переключателя", async () => {
    await withRutor(async () => {
      const st = scraper.trackerStatus();
      expect(st.engine).toBe("rutor");
      expect(st.requiresLogin).toBe(false);
      expect(st.session.ok).toBe(true); // готово к поиску без входа
      expect(st.presets.map((p: { id: string }) => p.id)).toEqual(["rutor", "rutracker"]);
      expect(st.loginUrl).toBe("https://rutor.info/users.php");
    });
  });

  it("cookiesHaveLogin учитывает движок: без входа вход «есть»", async () => {
    await withRutor(() => {
      expect(scraper.cookiesHaveLogin({})).toBe(true);
    });
    // rutracker без bb_data — входа нет (гостевые bb_session/bb_ssl не считаются).
    expect(scraper.cookiesHaveLogin({})).toBe(false);
    expect(scraper.cookiesHaveLogin({ bb_session: "x", bb_ssl: "1" })).toBe(false);
    expect(scraper.cookiesHaveLogin({ bb_data: "x" })).toBe(true);
  });
});

// Возвращаем настоящий fetch ПОСЛЕДНИМ: набор тестов rutor (выше) снова
// подменяет его мок-форумом, а другим файлам тестов нужен системный fetch.
describe("trackerScraper — очистка окружения", () => {
  it("возвращает системный fetch", () => {
    vi.stubGlobal("fetch", realFetch);
    expect(globalThis.fetch).toBe(realFetch);
  });
});
