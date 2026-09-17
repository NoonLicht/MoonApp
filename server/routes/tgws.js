"use strict";

/**
 * HTTP-интерфейс блока «TG WS Proxy» на странице Bypass.
 *
 * Логика — в server/tgwsproxy.js (TS-исходник server/ts/tgwsproxy.ts):
 * блок умеет скачать движок Flowseal/tg-ws-proxy, запустить локальный
 * MTProto-прокси для Telegram Desktop и остановить его. Здесь только HTTP:
 * коды ошибок машиночитаемые, чтобы UI показал понятный текст на своём языке.
 */
const express = require("express");
const tgws = require("../tgwsproxy");
const logger = require("../logger");

const router = express.Router();

/**
 * Код ошибки → HTTP-статус.
 *  409 — состояние мешает операции (занятый порт, идёт скачивание);
 *  400 — неверный ввод (порт, секрет); 404 — движка нет (нужно скачать).
 */
function statusForCode(code) {
  switch (code) {
    case "tgws_not_installed":
      return 404;
    case "tgws_port_busy":
    case "tgws_download_busy":
      return 409;
    case "tgws_bad_port":
    case "tgws_bad_secret":
      return 400;
    default:
      return 500;
  }
}

function fail(res, e, context) {
  const msg = String((e && e.message) || e);
  logger.error(`tgws.${context}_failed`, { error: msg });
  res.status(statusForCode(msg)).json({ error: msg, code: msg });
}

// Статус: найден ли движок, запущен ли, порт/секрет/ссылка и хвост лога.
router.get("/status", async (req, res) => {
  try {
    res.json(await tgws.statusLive());
  } catch (e) {
    fail(res, e, "status");
  }
});

// Скачать движок (force=1 — перекачать даже если файл уже есть).
router.post("/install", async (req, res) => {
  try {
    const r = await tgws.install(req.body?.force === true);
    res.json({ ...(await tgws.statusLive()), ...r });
  } catch (e) {
    fail(res, e, "install");
  }
});

router.post("/start", async (req, res) => {
  try {
    const b = req.body || {};
    // Патч настроек и запуск одной операцией: в UI кнопка «Запустить» рядом с
    // полями порта/хоста — отдельный POST /settings оставлял бы окно, в котором
    // прокси работает со старыми значениями.
    res.json(
      await tgws.start({
        host: b.host,
        port: b.port === undefined ? undefined : Number(b.port),
        secret: typeof b.secret === "string" ? b.secret : undefined,
        autoStart: typeof b.autoStart === "boolean" ? b.autoStart : undefined,
      }),
    );
  } catch (e) {
    fail(res, e, "start");
  }
});

router.post("/stop", async (req, res) => {
  try {
    res.json(await tgws.stop());
  } catch (e) {
    fail(res, e, "stop");
  }
});

// Настройки блока: хост, порт, путь к exe, автозапуск.
router.post("/settings", async (req, res) => {
  try {
    res.json(await tgws.configure(req.body || {}));
  } catch (e) {
    fail(res, e, "settings");
  }
});

// Новый случайный секрет (кнопка «Новый секрет»).
router.post("/secret", async (req, res) => {
  try {
    res.json(await tgws.rotateSecret());
  } catch (e) {
    fail(res, e, "secret");
  }
});

module.exports = router;