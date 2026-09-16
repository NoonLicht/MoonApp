/**
 * Подписки встроенного прокси: обновление списка узлов и фоновый авто-синк.
 *
 * Вынесено из роутов, потому что обновление нужно и по HTTP (/api/proxycore/...),
 * и по таймеру (каждые 6 часов + первичный проход при старте сервера).
 *
 * Важно: при обновлении активный (выбранный) узел сохраняется, если тот же
 * сервер снова присутствует в подписке — текущее соединение не «слетает».
 *
 * TS-исходник, как server/ts/security.ts: компилируется в
 * server/proxySubscriptions.js командой `npm run compile:server`.
 */
import logger from "./logger";

/**
 * db.js и proxyCore.js ещё не переведены на TS, а импорт .js без объявлений
 * ломает strict-сборку. Поэтому здесь require с минимальным контрактом — как
 * в server/ts/config.ts для electron/storagePath. После их перевода на TS
 * строки заменятся обычными импортами.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stmts } = require("./db") as { stmts: Record<string, any> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyCore = require("./proxyCore") as {
  fetchText(url: string): Promise<string>;
  parseSubscription(text: string): { nodes: ProxyNode[]; format: string };
};

export const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Узел подписки в том виде, в каком он приходит из парсера proxyCore. */
export interface ProxyNode {
  protocol?: string;
  server?: string;
  port?: number | null;
  tag?: string;
}

/** Строка подписки из БД (нужны только url и дата обновления). */
export interface SubscriptionRow {
  id: number;
  url: string;
  last_updated?: string | number | null;
  auto_update_enabled?: number | null;
}

/** last_updated («YYYY-MM-DD HH:MM:SS», UTC) → мс или null. */
export function parseUpdated(ts: unknown): number | null {
  const s = String(ts || "").trim();
  if (!s) return null;
  const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : null;
}

/** Устарела ли подписка (нет даты → считаем устаревшей). */
export function isStale(
  sub: { last_updated?: unknown } | null | undefined,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  const at = parseUpdated(sub && sub.last_updated);
  if (at === null) return true;
  return nowMs - at > maxAgeMs;
}

/** Ключ узла, устойчивый к перезаписи подписки: protocol|server|port. */
export function nodeKey(node: ProxyNode | null | undefined): string {
  if (!node) return "";
  return `${node.protocol || ""}|${node.server || ""}|${node.port == null ? "" : node.port}`;
}

/** Ключ узла из строки config_json (битый JSON → null). */
function nodeKeyFromJson(configJson: string): string | null {
  try {
    return nodeKey(JSON.parse(configJson));
  } catch {
    return null;
  }
}

/** Итог обновления подписки: сколько узлов пришло и что удалось сохранить. */
export interface RefreshResult {
  added: number;
  total: number;
  format: string;
  restored: boolean;
  hidden: number;
}

/**
 * Перекачать подписку и заменить её узлы. `fetchText` внедряется для тестов.
 */
export async function refreshSubscription(
  id: number,
  { fetchText }: { fetchText?: (url: string) => Promise<string> } = {},
): Promise<RefreshResult> {
  const sub: SubscriptionRow | undefined = stmts.psubGet.get(id);
  if (!sub) throw new Error("subscription_not_found");
  const doFetch = fetchText || proxyCore.fetchText;

  // Запоминаем выбор и «удалённые» узлы, чтобы восстановить состояние после
  // перезаписи: выбор не должен слетать, а скрытые узлы не должны всплывать.
  const prevSelected: { config_json: string } | null =
    stmts.pnodeForSub.all(id).find((n: { is_selected?: number }) => n.is_selected) || null;
  const hiddenKeys = new Set(
    stmts.pnodeExcludedForSub
      .all(id)
      .map((n: { config_json: string }) => nodeKeyFromJson(n.config_json))
      .filter(Boolean),
  );

  const text = await doFetch(sub.url);
  const parsed = proxyCore.parseSubscription(text);

  stmts.pnodeDeleteForSub.run(id);
  const inserted: { id: number; node: ProxyNode }[] = [];
  for (const n of parsed.nodes) {
    const r = stmts.pnodeInsert.run(id, n.tag || n.server, n.protocol, JSON.stringify(n));
    inserted.push({ id: r.lastInsertRowid, node: n });
  }

  // Возвращаем метку «скрыт» тем узлам, которые пользователь убрал раньше.
  let hidden = 0;
  for (const x of inserted) {
    if (hiddenKeys.has(nodeKey(x.node))) {
      stmts.pnodeUpdate.run(x.id, { is_excluded: 1 });
      hidden++;
    }
  }

  // Выбор восстанавливаем только среди видимых узлов.
  let restored = false;
  if (prevSelected) {
    let prev: ProxyNode | null = null;
    try {
      prev = JSON.parse(prevSelected.config_json);
    } catch {
      prev = null;
    }
    if (prev && !hiddenKeys.has(nodeKey(prev))) {
      const match = inserted.find((x) => nodeKey(x.node) === nodeKey(prev));
      if (match) {
        stmts.pnodeUpdate.run(match.id, { is_selected: 1 });
        restored = true;
      }
    }
  }

  stmts.psubTouch.run(id);
  logger.action("proxycore.subscription.refresh", { id, added: inserted.length, restored, hidden });
  return {
    added: inserted.length,
    total: inserted.length,
    format: parsed.format,
    restored,
    hidden,
  };
}

/** Итог одной подписки в авто-синке (успех или текст ошибки). */
export interface SyncOutcome extends Partial<RefreshResult> {
  id: number;
  error?: string;
}

/**
 * Обновить подписки с auto_update_enabled, устаревшие старше maxAgeMs.
 * force=true — обновить все, независимо от даты.
 */
export async function syncDueSubscriptions({
  maxAgeMs = SIX_HOURS_MS,
  force = false,
  fetchText,
  nowMs = Date.now(),
}: {
  maxAgeMs?: number;
  force?: boolean;
  fetchText?: (url: string) => Promise<string>;
  nowMs?: number;
} = {}): Promise<SyncOutcome[]> {
  const subs: SubscriptionRow[] = stmts.psubAll
    .all()
    .filter((s: SubscriptionRow) => !!s.auto_update_enabled);
  const out: SyncOutcome[] = [];
  for (const s of subs) {
    if (!force && !isStale(s, maxAgeMs, nowMs)) continue;
    try {
      out.push({ id: s.id, ...(await refreshSubscription(s.id, { fetchText })) });
    } catch (e) {
      logger.warn("proxycore.subscription.sync_failed", { id: s.id, error: (e as Error).message });
      out.push({ id: s.id, error: (e as Error).message });
    }
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;

/** Фоновый авто-синк: первичный проход + интервал (не держит процесс живым). */
export function startAutoSync({
  intervalMs = SIX_HOURS_MS,
  initialDelayMs = 15000,
}: { intervalMs?: number; initialDelayMs?: number } = {}): void {
  if (timer) return;
  const kickoff = setTimeout(() => {
    void syncDueSubscriptions();
  }, initialDelayMs);
  if (kickoff.unref) kickoff.unref();
  timer = setInterval(() => {
    void syncDueSubscriptions();
  }, intervalMs);
  if (timer.unref) timer.unref();
  logger.info("proxycore.autosync.start", { intervalMs });
}

export function stopAutoSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
