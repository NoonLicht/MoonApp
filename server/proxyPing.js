"use strict";

/**
 * «Пропинговать все» — последовательный реальный пинг узлов подписок.
 *
 * Почему отдельный модуль: proxyCore умеет пинговать ОДИН узел (поднимает
 * временное ядро и меряет TTFB), а здесь — очередь, прогресс и запись результата
 * в БД. Это ещё и разрывает цикл зависимостей (db ← здесь → proxyCore).
 *
 * Пингуем по одному узлу: каждый требует запуска sing-box, параллельный запуск
 * десятков процессов только мешает друг другу и греет машину.
 * Прогресс отдаётся в UI через getStatus() (HTTP-ответ возвращается сразу).
 */

const { stmts } = require("./db");
const proxyCore = require("./proxyCore");
const logger = require("./logger");

// Верхняя граница, чтобы случайно не запустить пинг на сотни узлов разом.
const MAX_NODES = 200;

let PING = {
  running: false,
  total: 0,
  done: 0,
  ok: 0,
  failed: 0,
  currentId: null,
  currentName: "",
  startedAt: 0,
  finishedAt: 0,
  error: "",
  cancelRequested: false,
  results: [],
};

let currentRun = null;

/** Текущее состояние пинга (для поллинга из UI). */
function getStatus() {
  return {
    running: PING.running,
    total: PING.total,
    done: PING.done,
    ok: PING.ok,
    failed: PING.failed,
    currentId: PING.currentId,
    currentName: PING.currentName,
    startedAt: PING.startedAt,
    finishedAt: PING.finishedAt,
    error: PING.error,
    // Хвост результатов: UI показывает последние проверенные узлы.
    results: PING.results.slice(-12),
  };
}

/** true, если пинг сейчас идёт (повторный запуск игнорируется). */
function isRunning() {
  return PING.running;
}

/** Дождаться окончания текущего прогона (для тестов и graceful shutdown). */
function awaitCurrent() {
  return currentRun || Promise.resolve(getStatus());
}

/** Запросить остановку после текущего узла. */
function cancel() {
  if (!PING.running) return getStatus();
  PING.cancelRequested = true;
  return getStatus();
}

/**
 * Отобрать узлы для пинга.
 * subId — только узлы подписки; ids — конкретные узлы; onlyMissing — те, у кого
 * ещё нет результата. Скрытые (is_excluded) никогда не пингуем.
 */
function selectNodes({ subId = null, ids = null, onlyMissing = false } = {}) {
  let rows = stmts.pnodeAll.all().filter((n) => !n.is_excluded);
  if (subId != null) rows = rows.filter((n) => n.sub_id === Number(subId));
  if (Array.isArray(ids)) {
    // Пустой массив = «ничего не выбрано» (а не «все узлы»): иначе случайная
    // пустая выборка из UI запускала бы пинг всей базы.
    const want = new Set(ids.map(Number));
    rows = rows.filter((n) => want.has(n.id));
  }
  if (onlyMissing) rows = rows.filter((n) => n.ping_ms == null);
  return rows.slice(0, MAX_NODES);
}

/**
 * Запустить пинг (в фоне). Возвращает стартовый статус сразу.
 * `pinger` инъектируется в тестах вместо реального proxyCore.pingNode.
 */
function start({ subId = null, ids = null, onlyMissing = false, timeout = 6000, pinger } = {}) {
  if (PING.running) return getStatus();

  const rows = selectNodes({ subId, ids, onlyMissing });
  PING = {
    running: true, total: rows.length, done: 0, ok: 0, failed: 0,
    currentId: null, currentName: "", startedAt: Date.now(), finishedAt: 0,
    error: "", cancelRequested: false, results: [],
  };
  if (rows.length === 0) {
    PING = { ...PING, running: false, finishedAt: Date.now() };
    return getStatus();
  }

  const doPing = pinger || proxyCore.pingNode;
  currentRun = runQueue(rows, doPing, timeout)
    .catch((e) => {
      PING = { ...PING, running: false, error: e.message, finishedAt: Date.now() };
      logger.error("proxycore.ping.error", { error: e.message });
    })
    .finally(() => { currentRun = null; });

  return getStatus();
}

/** Последовательный обход очереди с записью результата в БД. */
async function runQueue(rows, doPing, timeout) {
  logger.action("proxycore.ping.start", { total: rows.length });
  for (const row of rows) {
    if (PING.cancelRequested) break;

    let node = null;
    try { node = JSON.parse(row.config_json); } catch { node = null; }

    PING.currentId = row.id;
    PING.currentName = row.name || (node && node.server) || "";

    let res;
    if (!node) {
      res = { ok: false, ttfbMs: null, country: null, error: "bad_config" };
    } else {
      res = await doPing(node, { timeout });
    }

    // Неудачный пинг обнуляет прошлое значение: «300ms» из кэша вводило бы в заблуждение.
    stmts.pnodeUpdate.run(row.id, {
      ping_ms: res.ok && res.ttfbMs != null ? res.ttfbMs : null,
      country_code: res.country || row.country_code || "",
    });

    PING.done++;
    if (res.ok) PING.ok++; else PING.failed++;
    PING.results.push({ id: row.id, name: PING.currentName, ok: !!res.ok, ttfbMs: res.ttfbMs, error: res.error || "" });
  }

  PING = { ...PING, running: false, currentId: null, currentName: "", finishedAt: Date.now() };
  logger.action("proxycore.ping.done", { total: PING.total, done: PING.done, ok: PING.ok, failed: PING.failed, cancelled: PING.cancelRequested });
  return getStatus();
}

module.exports = { MAX_NODES, getStatus, isRunning, start, cancel, selectNodes, awaitCurrent };