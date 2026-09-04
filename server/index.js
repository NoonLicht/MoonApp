const path = require("path");
const fs = require("fs");
const express = require("express");
const config = require("./config");
const logger = require("./logger");
const { db, stmts } = require("./db");
const backups = require("./backup");
const settings = require("./settings");

const chatRouter = require("./routes/chat");
const settingsRouter = require("./routes/settings");
const backupRouter = require("./routes/backup");
const metaRouter = require("./routes/meta");
const catalogRouter = require("./routes/catalog");
const appsRouter = require("./routes/apps");
const convertRouter = require("./routes/convert");
const videoRouter = require("./routes/video");
const proxyRouter = require("./routes/proxy");
const booksRouter = require("./routes/books");
const musicRouter = require("./routes/music");
const myspaceRouter = require("./routes/myspace");
const monitor = require("./monitor");
const proxy = require("./proxy");

// Токен для локального API. Electron делает его при старте и кидает в preload
// (additionalArguments), фронт подставляет в заголовок x-pa-token.
// Без токена (dev, node server/index.js) сервер ничего не проверяет,
// но слушает строго 127.0.0.1.
let AUTH_TOKEN = null;

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const protectedPath = req.path.startsWith("/api") || req.path.startsWith("/events");
  if (!protectedPath) return next(); // статика dist/ не секрет
  if (req.get("x-pa-token") !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}


// Стартовые книги (как раньше MOCK_BOOKS).
function seedBooks() {
  if (stmts.bookAll.all().length > 0) return;
  const books = [
    ["The Quiet Algorithm", "N. Halvorsen", 2019, "EPUB,PDF", "amber", "A field guide to reasoning about systems that think in silence."],
    ["Slow Static", "R. Adeyemi", 2021, "EPUB", "violet", "Essays on signal, noise, and the long half-life of information."],
    ["Copper & Circuit", "M. Duval", 2016, "PDF,MOBI", "teal", "A short history of the workbench, from hand tools to relay."],
    ["Foundations of Drift", "S. Okafor", 2023, "EPUB,PDF", "amber", "Distributed consensus through the lens of migratory systems."],
    ["Glass Rooms", "T. Lindqvist", 2020, "MOBI", "violet", "A design memoir on transparency and interfaces."],
  ];
  for (const b of books) stmts.bookInsert.run(...b);
  logger.info("seed.books", { count: books.length });
}

function createApp() {
  seedBooks();

  const app = express();

  // Без открытого CORS (same-origin через Vite-proxy / раздачу dist),
  // лимит тела запроса урезан с 50mb до 2mb, и токен на всех /api-роутах.
  app.use(authMiddleware);
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.use("/api/chat", chatRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/backup", backupRouter);
  app.use("/api", metaRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/apps", appsRouter);
  app.use("/api/convert", convertRouter);
  app.use("/api/video", videoRouter);
  app.use("/api/proxy", proxyRouter);
  app.use("/api/books", booksRouter);
  app.use("/api/music", musicRouter);
  app.use("/api/myspace", myspaceRouter);

  // Раздача собранного фронта (dist), если он собран.
  const dist = path.join(__dirname, "..", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/events")) return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  // Глобальный ловец ошибок
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error("route.error", { path: req.path, error: err.message });
    res.status(500).json({ error: err.message });
  });

  backups.startAuto();

  // LibreHardwareMonitor запускается сам, если это включено в настройках и он установлен.
  monitor.autoStartLhmIfConfigured();

  // После рестарта прокси всегда выключен (состояние «включён» в настройках не хранится).
  try { proxy.stopProxy(); } catch {}

  return app;
}

function startServer(port = config.PORT, opts = {}) {
  AUTH_TOKEN = opts.token || process.env.PERSONAL_APP_TOKEN || null;
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

module.exports = { createApp, startServer, db };