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
import { db } from "./db";
import * as backups from "./backup";
import settings from "./settings";
import * as security from "./security";
import * as passwordVault from "./passwordVault";
import * as proxySubs from "./proxySubscriptions";
import * as bodyLimits from "./bodyLimits";
import * as problems from "./problemLog";

import settingsRouter from "./routes/settings";
import featuresRouter from "./routes/features";
import * as features from "./features";
import { registerFeatureServices } from "./featureServices";
import metaRouter from "./routes/meta";
import * as companion from "./companion";
import * as perPageProxy from "./middleware/perPageProxy";
import * as proxy from "./proxy";
import { INTERNAL_KEY, INTERNAL_STREAM_PREFIX } from "./internalKey";
// Глобальные перехватчики процесса: необработанные исключения и отклонённые
// промисы попадают в полный журнал (logs/audit.log), а значит — в файл,
// который собирает кнопка «Собрать логи» в Настройках.
process.on("uncaughtException", (err) => {
  logger.error("process.uncaughtException", {
    message: err?.message || String(err),
    stack: String(err?.stack || "").slice(0, 4000),
  });
  problems.reportProblem({ source: "process", error: err });
});
process.on("unhandledRejection", (reason) => {
  const r = reason as { message?: unknown; stack?: unknown } | null;
  logger.error("process.unhandledRejection", {
    message: String(r?.message || reason).slice(0, 1000),
    stack: String(r?.stack || "").slice(0, 4000),
  });
  problems.reportProblem({
    source: "process",
    level: "warn",
    error: reason instanceof Error ? reason : new Error(String(r?.message || reason)),
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
  if (
    req.path.startsWith(INTERNAL_STREAM_PREFIX) &&
    typeof req.query.ik === "string" &&
    req.query.ik === INTERNAL_KEY
  ) {
    return next();
  }
  if (!tokenMatches(req.get("x-moonapp-token"))) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
function createApp(): express.Express {
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
  // Лимит JSON-тела зависит от маршрута (см. bodyLimits.ts): доски, заметки и импорты — больше.
  const jsonParsers = new Map<string, express.RequestHandler>();
  app.use((req, res, next) => {
    const limit = bodyLimits.jsonLimitFor(req.path);
    let parser = jsonParsers.get(limit);
    if (!parser) {
      parser = express.json({ limit });
      jsonParsers.set(limit, parser);
    }
    parser(req, res, next);
  });
  // Per-page проксирование: по заголовку X-App-Page размечаем req.appPage /
  // req.proxy / req.proxyUrl (см. server/middleware/perPageProxy.js).
  app.use(perPageProxy.perPageProxyMiddleware);
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/settings", settingsRouter);
  app.use("/api", metaRouter);
  app.use("/api/features", featuresRouter);
  // Роуты подключаются лениво: модуль читается при первом запросе, а у отключённой страницы —
  // никогда (см. features.ts). Порядок строк важен: он совпадает с порядком подключения express.
  const LAZY_ROUTES: [string, string][] = [
    ["/api/chat", "chat"],
    ["/api/backup", "backup"],
    ["/api/catalog", "catalog"],
    ["/api/monitor", "monitor"],
    ["/api/apps", "apps"],
    ["/api/convert", "convert"],
    ["/api/video", "video"],
    ["/api/compressor", "compressor"],
    ["/api/upscale", "upscale"],
    ["/api/photo", "photo"],
    ["/api/word", "word"],
    ["/api/tts", "tts"],
    ["/api/archive", "archive"],
    ["/api/proxy", "proxy"],
    ["/api/proxycore", "proxyCore"],
    ["/api/books", "books"],
    ["/api/music", "music"],
    ["/api/movies", "movies"],
    ["/api/myspace", "myspace"],
    ["/api/myspace/tasks", "myspace-tasks"],
    ["/api/lecture", "lecture"],
    ["/api/zapret", "zapret"],
    ["/api/tgws", "tgws"],
    ["/api/tasks", "tasks"],
    ["/api/passwords", "passwordVault"],
    ["/api/diskscan", "diskScan"],
    ["/api/fileinsights", "fileInsights"],
    ["/api/interchange", "interchange"],
    ["/api/chat-tools", "chatTools"],
    ["/api/automation-rules", "automationRules"],
    ["/api/note-tools", "noteTools"],
    ["/api/clipboard-history", "clipboardHistory"],
    ["/api/folder-versions", "folderVersions"],
    ["/api/chat-fork", "chatFork"],
    ["/api/app-modes", "appModes"],
    ["/api/audio-clean", "audioClean"],
    ["/api/lyrics", "lyrics"],
    ["/api/context-menu", "contextMenu"],
    ["/api/plugins", "plugins"],
    ["/api/p2p", "p2p"],
    ["/api/ai-shield", "aiShield"],
    ["/api/ghost", "ghost"],
    ["/api/exam", "exam"],
    ["/api/voice-vault", "voiceVault"],
    ["/api/attention", "attention"],
    ["/api/drift", "drift"],
    ["/api/gaps", "gaps"],
    ["/api/mind", "mind"],
    ["/api/self-contracts", "contracts"],
    ["/api/scan", "scan"],
    ["/api/montage", "montage"],
    ["/api/diagnostics", "diagnostics"],
    ["/api/canvas-ai", "canvasAi"],
    ["/api/ai-bindings", "aiBindings"],
    ["/api/bookmarks", "bookmarks"],
    ["/api/pdf", "pdf"],
    ["/api/games", "games"],
    ["/api/nettools", "netTools"],
    ["/api/notesgit", "notesGit"],
    ["/api/apptracker", "appTimeTracker"],
    ["/api/automation", "automation"],
    ["/api/budget", "budget"],
    ["/api/quicknotes", "quickNotes"],
    ["/api/m3e", "m3e"],
    ["/api/killswitch", "killSwitch"],
    ["/api/tuning", "tuning"],
    ["/api/privacy", "privacy"],
    ["/api/linutil", "linutil"],
    ["/api/translate", "translate"],
    ["/api/llamacpp", "llamacpp"],
    ["/api/semantic", "semantic"],
    ["/api/ocr", "ocr"],
    ["/api/screenshots", "screenshots"],
    ["/api/dragout", "dragOut"],
    ["/api/office", "office"],
    ["/api/diary", "diary"],
    ["/api/rss", "rss"],
    ["/api/mail", "mail"],
    ["/api/companion", "companion"],
  ];
  for (const [mount, file] of LAZY_ROUTES) {
    app.use(
      mount,
      features.lazyRouter(mount, () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const m = require(`./routes/${file}`) as { default?: express.RequestHandler };
        return (m.default ?? m) as express.RequestHandler;
      }),
    );
  }

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
      const status = bodyLimits.statusOf(err);
      const error = bodyLimits.publicMessage(err);
      // 4xx от разбора тела — не сбой приложения, в журнал проблем их не несём.
      if (status >= 500) {
        logger.error("route.error", { path: req.path, error: err.message });
        problems.reportProblem({ source: "route", error: err, context: { path: req.path } });
      } else {
        logger.warn("route.rejected", { path: req.path, status, error: err.message });
      }
      res.status(status).json({ error });
    },
  );
  backups.startAuto();

  // Веб-компаньон поднимается только если пользователь включил его в настройках.
  companion.autoStart();

  // Фоновое обновление подписок прокси (первичный проход + раз в 6 часов).
  try {
    proxySubs.startAutoSync();
  } catch (e) {
    logger.warn("proxycore.autosync.failed", { error: (e as Error).message });
  }

  // Службы страниц (лекции, RSS, почта, мониторинг, автоматизации, Telegram-прокси, индекс
  // магазина) стартуют только для включённых страниц — см. features.ts / featureServices.ts.
  registerFeatureServices();
  features.reconcileServices();
  // Модули включённых роутов читаются в фоне, чтобы первый запрос не ждал; отключённые — нет.
  features.warmRoutes();

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

/**
 * Токен для запуска без Electron (`node server/index.js` + `npm run dev`).
 * Раньше такой сервер работал вовсе без аутентификации: любой локальный процесс
 * мог дёрнуть API (менеджер паролей, запуск файлов, установка ПО). Теперь токен
 * генерируется на каждый запуск и кладётся в storage/.dev-token — его читает
 * Vite-прокси (vite.config.ts) и подставляет в заголовок всех /api и /events,
 * включая <img>/<video>. Открытый режим остаётся только по явному
 * MOONAPP_INSECURE_DEV=1.
 */
function devToken(): string | undefined {
  if (process.env.MOONAPP_TOKEN || process.env.MOONAPP_INSECURE_DEV === "1") return undefined;
  const token = crypto.randomBytes(32).toString("hex");
  const file = path.join(config.DIRS.storage, ".dev-token");
  fs.writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

// Запуск напрямую: node server/index.js
if (require.main === module) {
  startServer(config.PORT, { token: devToken() });
}

export { createApp, startServer, db };
