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
import crypto from "crypto";
import fs from "fs";
import express from "express";
import type http from "http";
import config from "./config";
import logger from "./logger";
import { db, stmts } from "./db";
import * as backups from "./backup";
import settings from "./settings";
import * as monitor from "./monitor";
import * as security from "./security";
import * as passwordVault from "./passwordVault";
import * as winget from "./winget";
import * as proxySubs from "./proxySubscriptions";
import * as tgws from "./tgwsproxy";

import chatRouter from "./routes/chat";
import settingsRouter from "./routes/settings";
import backupRouter from "./routes/backup";
import metaRouter from "./routes/meta";
import catalogRouter from "./routes/catalog";
import appsRouter from "./routes/apps";
import convertRouter from "./routes/convert";
import videoRouter from "./routes/video";
import compressorRouter from "./routes/compressor";
import upscaleRouter from "./routes/upscale";
import ttsRouter from "./routes/tts";
import archiveRouter from "./routes/archive";
import proxyRouter from "./routes/proxy";
import proxyCoreRouter from "./routes/proxyCore";
import booksRouter from "./routes/books";
import musicRouter from "./routes/music";
import moviesRouter from "./routes/movies";
import myspaceRouter from "./routes/myspace";
import myspaceTasksRouter from "./routes/myspace-tasks";
import lectureRouter from "./routes/lecture";
import zapretRouter from "./routes/zapret";
import tgwsRouter from "./routes/tgws";
import tasksRouter from "./routes/tasks";
import passwordVaultRouter from "./routes/passwordVault";
import diskScanRouter from "./routes/diskScan";
import bookmarksRouter from "./routes/bookmarks";
import pdfRouter from "./routes/pdf";
import gamesRouter from "./routes/games";
import netToolsRouter from "./routes/netTools";
import notesGitRouter from "./routes/notesGit";
import appTimeTrackerRouter from "./routes/appTimeTracker";
import automationRouter from "./routes/automation";
import budgetRouter from "./routes/budget";
import quickNotesRouter from "./routes/quickNotes";
import m3eRouter from "./routes/m3e";
import killSwitchRouter from "./routes/killSwitch";
import tuningRouter from "./routes/tuning";
import privacyRouter from "./routes/privacy";
import linutilRouter from "./routes/linutil";
import translateRouter from "./routes/translate";
import llamacppRouter from "./routes/llamacpp";
import ocrRouter from "./routes/ocr";
import screenshotsRouter from "./routes/screenshots";
import officeRouter from "./routes/office";
import * as perPageProxy from "./middleware/perPageProxy";
import * as lecture from "./lecture";
import * as proxy from "./proxy";
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

// Токен для локального API. Electron делает его при старте и отдаёт в preload
// через ipcRenderer.sendSync (app:get-token), фронт подставляет в заголовок x-moonapp-token.
// Без токена (dev, node server/index.js) сервер ничего не проверяет,
// но слушает строго 127.0.0.1.
let AUTH_TOKEN: string | null = null;

/**
 * Сравнение токена за постоянное время: обычный `!==` выдаёт длину общего
 * префикса через тайминг ответа.
 */
function tokenMatches(given: string | undefined): boolean {
  if (!AUTH_TOKEN || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(AUTH_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

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
  // Ресурсных исключений нет: <img>/<video>/<track> окна приложения тоже идут
  // через session.webRequest.onBeforeSendHeaders (electron/ts/main.ts), поэтому
  // заголовок подставляется и им. Без токена не отдаётся ничего.
  if (!tokenMatches(req.get("x-moonapp-token"))) {
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
  // доски Canvas хранят вставленные картинки прямо в JSON — им нужен лимит побольше
  app.use("/api/myspace/holst", express.json({ limit: "40mb" }));
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
  app.use("/api/apptracker", appTimeTrackerRouter);
  app.use("/api/automation", automationRouter);
  app.use("/api/budget", budgetRouter);
  app.use("/api/quicknotes", quickNotesRouter);
  app.use("/api/m3e", m3eRouter);
  app.use("/api/killswitch", killSwitchRouter);
  app.use("/api/tuning", tuningRouter);
  app.use("/api/privacy", privacyRouter);
  app.use("/api/linutil", linutilRouter);
  app.use("/api/translate", translateRouter);
  app.use("/api/llamacpp", llamacppRouter);
  app.use("/api/ocr", ocrRouter);
  app.use("/api/screenshots", screenshotsRouter);
  app.use("/api/office", officeRouter);

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

  // Разовая (идемпотентная) миграция секретов/паролей со старого захардкоженного
  // резервного AES-ключа (был виден в открытом репозитории на GitHub) на
  // текущий случайный/safeStorage — см. security.ts → migrateLegacySecrets,
  // passwordVault.ts → migrateLegacyEncryption. Дёшево гонять на каждом
  // старте: уже мигрированные записи просто не расшифровываются старым
  // ключом и пропускаются.
  try {
    const migratedSecrets = security.migrateLegacySecrets();
    const migratedPasswords = passwordVault.migrateLegacyEncryption();
    if (migratedSecrets || migratedPasswords) {
      logger.info("security.migration_done", { migratedSecrets, migratedPasswords });
    }
  } catch (e) {
    logger.warn("security.migration_failed", { error: (e as Error).message });
  }

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
  // В Electron токен обязателен: без него любой локальный процесс получил бы
  // доступ к API (запуск файлов, ключи, установка ПО). Без Electron (dev,
  // node server/index.js) допускается открытый режим на loopback.
  if (!AUTH_TOKEN && process.versions.electron) {
    throw new Error("server.token_required: API-токен не передан");
  }
  if (!AUTH_TOKEN) {
    logger.warn("server.no_token", { hint: "standalone/dev mode: API без аутентификации" });
  }

  const app = createApp();
  // ВАЖНО: только loopback! Иначе к API (установка ПО, запуск файлов, ключи)
  // получит доступ вся локальная сеть.
  const server = app.listen(port, "127.0.0.1", () => {
    logger.info("server.start", { port, auth: !!AUTH_TOKEN });
    console.log(`[server] listening on http://127.0.0.1:${port}`);
    // Снимает правило блокировки kill-switch, если оно осталось от
    // предыдущего (аварийно завершённого) запуска — см. killSwitch.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    void (require("./killSwitch") as { startupCleanup(): Promise<void> }).startupCleanup();
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
