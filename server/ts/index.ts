/**
 * Точка входа HTTP-API: собирает express-приложение из роутов и поднимает его
 * строго на loopback. Здесь же — токен-аутентификация, CSP, раздача собранного
 * фронта (dist) и стартовые фоновые задачи (бэкапы, автосинк подписок, winget).
 *
 * TS-исходник, как server/ts/db.ts: компилируется в server/index.js командой
 * `npm run compile:server`, поэтому `require("../server")` из electron/main.js
 * и `node server/index.js` работают без изменений — экспорты createApp/startServer/db
 * сохранены.
 */
import path from "path";
import fs from "fs";
import express from "express";
import type http from "http";
import config from "./config";
import logger from "./logger";
import { db, stmts } from "./db";
import * as backups from "./backup";
import settings from "./settings";
import * as monitor from "./monitor";
import * as winget from "./winget";
import * as proxySubs from "./proxySubscriptions";
import * as tgws from "./tgwsproxy";

/**
 * Роуты и часть модулей ещё не переведены на TS: импорт .js без объявлений не
 * проходит strict-сборку, поэтому здесь require с указанием ожидаемой формы
 * (как в server/ts/config.ts). После их перевода строки заменятся обычными
 * импортами, а тип роутера станет настоящим.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const chatRouter = require("./routes/chat") as express.Router;
const settingsRouter = require("./routes/settings") as express.Router;
const backupRouter = require("./routes/backup") as express.Router;
const metaRouter = require("./routes/meta") as express.Router;
const catalogRouter = require("./routes/catalog") as express.Router;
const appsRouter = require("./routes/apps") as express.Router;
const convertRouter = require("./routes/convert") as express.Router;
const videoRouter = require("./routes/video") as express.Router;
const compressorRouter = require("./routes/compressor") as express.Router;
const upscaleRouter = require("./routes/upscale") as express.Router;
const ttsRouter = require("./routes/tts") as express.Router;
const archiveRouter = require("./routes/archive") as express.Router;
const proxyRouter = require("./routes/proxy") as express.Router;
const proxyCoreRouter = require("./routes/proxyCore") as express.Router;
const booksRouter = require("./routes/books") as express.Router;
const musicRouter = require("./routes/music") as express.Router;
const moviesRouter = require("./routes/movies") as express.Router;
const myspaceRouter = require("./routes/myspace") as express.Router;
const myspaceTasksRouter = require("./routes/myspace-tasks") as express.Router;
const lectureRouter = require("./routes/lecture") as express.Router;
const zapretRouter = require("./routes/zapret") as express.Router;
const tgwsRouter = require("./routes/tgws") as express.Router;
const tasksRouter = require("./routes/tasks") as express.Router;
const passwordVaultRouter = require("./routes/passwordVault") as express.Router;
const diskScanRouter = require("./routes/diskScan") as express.Router;
const bookmarksRouter = require("./routes/bookmarks") as express.Router;
const pdfRouter = require("./routes/pdf") as express.Router;
const gamesRouter = require("./routes/games") as express.Router;
const netToolsRouter = require("./routes/netTools") as express.Router;
const notesGitRouter = require("./routes/notesGit") as express.Router;
const perPageProxy = require("./middleware/perPageProxy") as {
  perPageProxyMiddleware: express.RequestHandler;
};
const lecture = require("./lecture") as {
  recoverInterrupted(): void;
  backfillNotesFiles(): void;
};
const proxy = require("./proxy") as { stopProxy(): void };
/* eslint-enable @typescript-eslint/no-require-imports */
// Глобальные перехватчики процесса: необработанные исключения и отклонённые
// промисы попадают в полный журнал (logs/audit.log), а значит — в файл,
// который собирает кнопка «Собрать логи» в Настройках.
process.on("uncaughtException", (err) => {
  logger.error("process.uncaughtException", {
    message: err?.message || String(err),
    stack: String(err?.stack || "").slice(0, 4000),
  });
});
process.on("unhandledRejection", (reason) => {
  const r = reason as { message?: unknown; stack?: unknown } | null;
  logger.error("process.unhandledRejection", {
    message: String(r?.message || reason).slice(0, 1000),
    stack: String(r?.stack || "").slice(0, 4000),
  });
});

// Токен для локального API. Electron делает его при старте и кидает в preload
// (additionalArguments), фронт подставляет в заголовок x-moonapp-token.
// Без токена (dev, node server/index.js) сервер ничего не проверяет,
// но слушает строго 127.0.0.1.
let AUTH_TOKEN: string | null = null;

/**
 * Пути /api, которые сознательно отдаются без токена: их грузит сам движок
 * (теги <img>/<video>), а не fetch с заголовками. Проверка безопасности —
 * внутри роутов (жёсткая валидация параметров).
 */
const RESOURCE_PATHS = [
  "/api/movies/image",
  // Торрент-плеер: <video>/<track> не умеют передавать заголовок x-moonapp-token,
  // поэтому эти пути не защищены токеном, а валидируются внутри роутов (infoHash —
  // строго 40 hex, index/audio/track — целые в допустимом диапазоне, start — секунды).
  // Без этой записи стрим торрента в собранной сборке получал 401.
  "/api/movies/torrent/stream",
  "/api/movies/torrent/remux",
  "/api/movies/torrent/subtitles",
];

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!AUTH_TOKEN) return next();
  // Раньше статика dist/ (в т.ч. SPA-фолбэк index.html) отдавалась без проверки —
  // любой процесс, узнавший порт (он теперь ещё и случайный, см. findFreePort в
  // electron/main.js), мог просто открыть http://127.0.0.1:<port> в обычном
  // браузере и получить интерфейс приложения. Токен теперь нужен на ВСЕХ путях;
  // Electron-окно получает его не через <script>, а через session.webRequest
  // (electron/main.js → onBeforeSendHeaders), поэтому само приложение работает
  // как раньше, а сторонний браузер получает 401 на любой URL.
  // Ресурсные URL отдаются браузеру как <img src>/<video src>, поэтому заголовок
  // x-moonapp-token передать нельзя. Такие пути валидируются по allowlist сами
  // (пример: /api/movies/image — только image.tmdb.org, size из списка, path /file.jpg).
  if (
    RESOURCE_PATHS.some(
      (p) => req.path === p || req.path.startsWith(p + "/") || req.path.startsWith(p + "?"),
    )
  ) {
    return next();
  }
  if (req.get("x-moonapp-token") !== AUTH_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
// Стартовые книги (как раньше MOCK_BOOKS).
function seedBooks(): void {
  if (stmts.bookAll.all().length > 0) return;
  // Кортеж (а не массив) — чтобы spread ниже соответствовал порядку колонок.
  const books: [string, string, number, string, string, string][] = [
    [
      "The Quiet Algorithm",
      "N. Halvorsen",
      2019,
      "EPUB,PDF",
      "amber",
      "A field guide to reasoning about systems that think in silence.",
    ],
    [
      "Slow Static",
      "R. Adeyemi",
      2021,
      "EPUB",
      "violet",
      "Essays on signal, noise, and the long half-life of information.",
    ],
    [
      "Copper & Circuit",
      "M. Duval",
      2016,
      "PDF,MOBI",
      "teal",
      "A short history of the workbench, from hand tools to relay.",
    ],
    [
      "Foundations of Drift",
      "S. Okafor",
      2023,
      "EPUB,PDF",
      "amber",
      "Distributed consensus through the lens of migratory systems.",
    ],
    [
      "Glass Rooms",
      "T. Lindqvist",
      2020,
      "MOBI",
      "violet",
      "A design memoir on transparency and interfaces.",
    ],
  ];
  for (const b of books) stmts.bookInsert.run(...b);
  logger.info("seed.books", { count: books.length });
}
function createApp(): express.Express {
  seedBooks();
  // Fail-safe лекций: сессии, оборванные падением приложения (status=recording,
  // но процесса записи нет), помечаем interrupted и чиним header raw.wav.
  try {
    lecture.recoverInterrupted();
  } catch {
    /* журнал уже внутри */
  }
  // Заметки лекций синхронизируются с .md в storage/notes при каждом изменении
  // (кнопка, маркер, ИИ-конспект). У лекций, записанных ДО этой синхронизации,
  // файла ещё нет — заводим при старте. Ошибка не должна мешать запуску: лекции
  // работают и без зеркала, поэтому здесь только лог.
  try {
    lecture.backfillNotesFiles();
  } catch {
    /* зеркало не критично */
  }

  const app = express();

  // Без открытого CORS (same-origin через Vite-proxy / раздачу dist),
  // лимит тела запроса урезан с 50mb до 2mb, и токен на всех /api-роутах.
  // CSP на статику (API отвечает JSON — заголовок не нужен). Инлайн-скрипты
  // запрещены: бандл Vite — внешние файлы. Это второй рубеж после DOMPurify.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/events")) {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; " +
          "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; object-src 'none'; " +
          // frame-src: трейлеры — официальные YouTube-ролики TMDB (iframe плеера).
          // Картинки TMDB приходят через /api/movies/image (img-src 'self'), поэтому
          // внешние image.tmdb.org в CSP не нужны.
          "frame-src https://www.youtube.com https://www.youtube-nocookie.com; base-uri 'self'",
      );
    }
    next();
  });
  app.use(authMiddleware);
  app.use(express.json({ limit: "2mb" }));
  // Per-page проксирование: по заголовку X-App-Page размечаем req.appPage /
  // req.proxy / req.proxyUrl (см. server/middleware/perPageProxy.js).
  app.use(perPageProxy.perPageProxyMiddleware);
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/chat", chatRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/backup", backupRouter);
  app.use("/api", metaRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/apps", appsRouter);
  app.use("/api/convert", convertRouter);
  app.use("/api/video", videoRouter);
  app.use("/api/compressor", compressorRouter);
  app.use("/api/upscale", upscaleRouter);
  app.use("/api/tts", ttsRouter);
  app.use("/api/archive", archiveRouter);
  app.use("/api/proxy", proxyRouter);
  app.use("/api/proxycore", proxyCoreRouter);
  app.use("/api/books", booksRouter);
  app.use("/api/music", musicRouter);
  app.use("/api/movies", moviesRouter);
  app.use("/api/myspace", myspaceRouter);
  app.use("/api/myspace/tasks", myspaceTasksRouter);
  app.use("/api/lecture", lectureRouter);
  app.use("/api/zapret", zapretRouter);
  app.use("/api/tgws", tgwsRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/passwords", passwordVaultRouter);
  app.use("/api/diskscan", diskScanRouter);
  app.use("/api/bookmarks", bookmarksRouter);
  app.use("/api/pdf", pdfRouter);
  app.use("/api/games", gamesRouter);
  app.use("/api/nettools", netToolsRouter);
  app.use("/api/notesgit", notesGitRouter);

  // Раздача собранного фронта (dist), если он собран.
  const dist = path.join(__dirname, "..", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/events")) return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  // Глобальный ловец ошибок: четыре аргумента обязательны — так express
  // понимает, что это именно обработчик ошибок, а не обычный middleware.
  app.use(
    (err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error("route.error", { path: req.path, error: err.message });
      res.status(500).json({ error: err.message });
    },
  );
  backups.startAuto();

  // Фоновое обновление подписок прокси (первичный проход + раз в 6 часов).
  try {
    proxySubs.startAutoSync();
  } catch (e) {
    logger.warn("proxycore.autosync.failed", { error: (e as Error).message });
  }

  // LibreHardwareMonitor запускается сам, если это включено в настройках и он установлен.
  monitor.autoStartLhmIfConfigured();

  // tgws.autoStart: локальный MTProto-прокси для Telegram Desktop (страница
  // Bypass). Поднимаем без ожидания — старт приложения не должен ждать чужой
  // бинарь, а статус страница всё равно опрашивает сама.
  void tgws.autoStart();

  // store.wingetAutoIndex: при старте один раз индексируем полный каталог winget,
  // если локальный кэш ещё не собран (иначе UI показывает только курируемый seed).
  try {
    if (settings.get("store").wingetAutoIndex !== false && !(winget.indexStatus().cached > 0)) {
      void winget.startIndexing();
    }
  } catch {
    /* индексация не критична для старта */
  }

  // monitor.autoStart: прогреваем телеметрию сразу после старта — первый
  // getSnapshot собирает данные (WMI/nvidia-smi/LHM), чтобы UI мониторинга
  // открылся уже с готовыми значениями, а не с нулями.
  try {
    if (settings.get("monitor").autoStart === true) void monitor.getSnapshot();
  } catch {
    /* сбор телеметрии не должен ломать старт */
  }

  // После рестарта прокси всегда выключен (состояние «включён» в настройках не хранится).
  try {
    proxy.stopProxy();
  } catch {
    /* прокси не поднят — это нормальный случай */
  }

  return app;
}
function startServer(port: number = config.PORT, opts: { token?: string } = {}): http.Server {
  AUTH_TOKEN = opts.token || process.env.MOONAPP_TOKEN || null;
  if (!AUTH_TOKEN) {
    logger.warn("server.no_token", { hint: "standalone/dev mode: API без аутентификации" });
  }

  const app = createApp();
  // ВАЖНО: только loopback! Иначе к API (установка ПО, запуск файлов, ключи)
  // получит доступ вся локальная сеть.
  const server = app.listen(port, "127.0.0.1", () => {
    logger.info("server.start", { port, auth: !!AUTH_TOKEN });
    console.log(`[server] listening on http://127.0.0.1:${port}`);
  });
  server.on("error", (e) => {
    logger.error("server.error", { error: e.message });
    console.error(`[server] failed to start: ${e.message}`);
  });
  return server;
}

// Запуск напрямую: node server/index.js
if (require.main === module) {
  startServer();
}

export { createApp, startServer, db };
