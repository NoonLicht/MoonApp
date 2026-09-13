"use strict";

/**
 * Подписки встроенного прокси: обновление списка узлов и фоновый авто-синк.
 *
 * Вынесено из роутов, потому что обновление нужно и по HTTP (/api/proxycore/...),
 * и по таймеру (каждые 6 часов + первичный проход при старте сервера).
 *
 * Важно: при обновлении активный (выбранный) узел сохраняется, если тот же
 * сервер снова присутствует в подписке — текущее соединение не «слетает».
 */

const { stmts } = require("./db");
const proxyCore = require("./proxyCore");
const logger = require("./logger");

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** last_updated («YYYY-MM-DD HH:MM:SS», UTC) → мс или null. */
function parseUpdated(ts) {
  const s = String(ts || "").trim();
  if (!s) return null;
  const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : null;
}

/** Устарела ли подписка (нет даты → считаем устаревшей). */
function isStale(sub, maxAgeMs, nowMs = Date.now()) {
  const at = parseUpdated(sub && sub.last_updated);
  if (at === null) return true;
  return nowMs - at > maxAgeMs;
}

/** Ключ узла, устойчивый к перезаписи подписки: protocol|server|port. */
function nodeKey(node) {
  if (!node) return "";
  return `${node.protocol || ""}|${node.server || ""}|${node.port == null ? "" : node.port}`;
}

/** Ключ узла из строки config_json (битый JSON → null). */
function nodeKeyFromJson(configJson) {
  try { return nodeKey(JSON.parse(configJson)); } catch { return null; }
}

/**
 * Перекачать подписку и заменить её узлы. `fetchText` внедряется для тестов.
 * → { added, total, format, restored, hidden }
 */
async function refreshSubscription(id, { fetchText } = {}) {
  const sub = stmts.psubGet.get(id);
  if (!sub) throw new Error("subscription_not_found");
  const doFetch = fetchText || proxyCore.fetchText;

  // Запоминаем выбор и «удалённые» узлы, чтобы восстановить состояние после
  // перезаписи: выбор не должен слетать, а скрытые узлы не должны всплывать.
  const prevSelected = stmts.pnodeForSub.all(id).find((n) => n.is_selected) || null;
  const hiddenKeys = new Set(
    stmts.pnodeExcludedForSub.all(id).map((n) => nodeKeyFromJson(n.config_json)).filter(Boolean)
  );

  const text = await doFetch(sub.url);
  const parsed = proxyCore.parseSubscription(text);

  stmts.pnodeDeleteForSub.run(id);
  const inserted = [];
  for (const n of parsed.nodes) {
    const r = stmts.pnodeInsert.run(id, n.tag || n.server, n.protocol, JSON.stringify(n));
    inserted.push({ id: r.lastInsertRowid, node: n });
  }

  // Возвращаем метку «скрыт» тем узлам, которые пользователь убрал раньше.
  let hidden = 0;
  for (const x of inserted) {
    if (hiddenKeys.has(nodeKey(x.node))) { stmts.pnodeUpdate.run(x.id, { is_excluded: 1 }); hidden++; }
  }

  // Выбор восстанавливаем только среди видимых узлов.
  let restored = false;
  if (prevSelected) {
    let prev = null;
    try { prev = JSON.parse(prevSelected.config_json); } catch { prev = null; }
    if (prev && !hiddenKeys.has(nodeKey(prev))) {
      const match = inserted.find((x) => nodeKey(x.node) === nodeKey(prev));
      if (match) { stmts.pnodeUpdate.run(match.id, { is_selected: 1 }); restored = true; }
    }
  }

  stmts.psubTouch.run(id);
  logger.action("proxycore.subscription.refresh", { id, added: inserted.length, restored, hidden });
  return { added: inserted.length, total: inserted.length, format: parsed.format, restored, hidden };
}

/**
 * Обновить подписки с auto_update_enabled, устаревшие старше maxAgeMs.
 * force=true — обновить все, независимо от даты.
 */
async function syncDueSubscriptions({ maxAgeMs = SIX_HOURS_MS, force = false, fetchText, nowMs = Date.now() } = {}) {
  const subs = stmts.psubAll.all().filter((s) => !!s.auto_update_enabled);
  const out = [];
  for (const s of subs) {
    if (!force && !isStale(s, maxAgeMs, nowMs)) continue;
    try {
      out.push({ id: s.id, ...(await refreshSubscription(s.id, { fetchText })) });
    } catch (e) {
      logger.warn("proxycore.subscription.sync_failed", { id: s.id, error: e.message });
      out.push({ id: s.id, error: e.message });
    }
  }
  return out;
}

let timer = null;

/** Фоновый авто-синк: первичный проход + интервал (не держит процесс живым). */
function startAutoSync({ intervalMs = SIX_HOURS_MS, initialDelayMs = 15000 } = {}) {
  if (timer) return;
  const kickoff = setTimeout(() => { void syncDueSubscriptions(); }, initialDelayMs);
  if (kickoff.unref) kickoff.unref();
  timer = setInterval(() => { void syncDueSubscriptions(); }, intervalMs);
  if (timer.unref) timer.unref();
  logger.info("proxycore.autosync.start", { intervalMs });
}

function stopAutoSync() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { SIX_HOURS_MS, nodeKey, parseUpdated, isStale, refreshSubscription, syncDueSubscriptions, startAutoSync, stopAutoSync };