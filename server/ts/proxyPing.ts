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
 *
 * TS-исходник, как server/ts/security.ts: компилируется в server/proxyPing.js
 * командой `npm run compile:server`.
 */
import logger from "./logger";
// db переведён на TS (server/ts/db.ts), поэтому здесь обычный импорт с типами:
// stmts не Record<string, any>, а конкретные методы с Row из стора.
import { stmts } from "./db";

/**
 * proxyCore.js ещё не переведён на TS: импорт .js без объявлений ломает
 * strict-сборку, поэтому здесь require с минимальным контрактом
 * (как в server/ts/config.ts). После его перевода — обычный импорт.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyCore = require("./proxyCore") as {
  pingNode(
    node: unknown,
    opts: { timeout: number },
  ): Promise<{ ok: boolean; ttfbMs: number | null; country: string | null; error?: string }>;
};

// Верхняя граница, чтобы случайно не запустить пинг на сотни узлов разом.
export const MAX_NODES = 200;

/** Узел, отобранный для пинга (строки из БД). */
export interface NodeRow {
  id: number;
  name?: string | null;
  sub_id?: number | null;
  is_excluded?: number | null;
  ping_ms?: number | null;
  country_code?: string | null;
  config_json: string;
}

/** Результат одного пинга (в хвосте статуса для UI). */
export interface PingResult {
  id: number;
  name: string;
  ok: boolean;
  ttfbMs: number | null;
  error: string;
}

/** Состояние очереди пинга (поллится из UI). */
export interface PingStatus {
  running: boolean;
  total: number;
  done: number;
  ok: number;
  failed: number;
  currentId: number | null;
  currentName: string;
  startedAt: number;
  finishedAt: number;
  error: string;
  results: PingResult[];
}

/** Функция пинга одного узла (в тестах подменяется). */
export type Pinger = (
  node: unknown,
  opts: { timeout: number },
) => Promise<{ ok: boolean; ttfbMs: number | null; country: string | null; error?: string }>;

interface InternalState extends PingStatus {
  cancelRequested: boolean;
}

let PING: InternalState = {
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

let currentRun: Promise<PingStatus | void> | null = null;

/** Текущее состояние пинга (для поллинга из UI). */
export function getStatus(): PingStatus {
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
export function isRunning(): boolean {
  return PING.running;
}

/**
 * Дождаться окончания текущего прогона (для тестов и graceful shutdown).
 * При ошибке очереди прогон завершается без значения — вызывающих интересует
 * факт завершения, а текст ошибки лежит в getStatus().error.
 */
export function awaitCurrent(): Promise<PingStatus | void> {
  return currentRun || Promise.resolve(getStatus());
}

/** Запросить остановку после текущего узла. */
export function cancel(): PingStatus {
  if (!PING.running) return getStatus();
  PING.cancelRequested = true;
  return getStatus();
}

/**
 * Отобрать узлы для пинга.
 * subId — только узлы подписки; ids — конкретные узлы; onlyMissing — те, у кого
 * ещё нет результата. Скрытые (is_excluded) никогда не пингуем.
 */
export function selectNodes({
  subId = null,
  ids = null,
  onlyMissing = false,
}: {
  subId?: number | null;
  ids?: Array<number | string> | null;
  onlyMissing?: boolean;
} = {}): NodeRow[] {
  // Стор (server/ts/db.ts) отдаёт строки как Row — доменных типов он не знает,
  // поэтому схему строки узла объявляем здесь приведением.
  let rows = stmts.pnodeAll.all().filter((n) => !n.is_excluded) as NodeRow[];
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
export function start({
  subId = null,
  ids = null,
  onlyMissing = false,
  timeout = 6000,
  pinger,
}: {
  subId?: number | null;
  ids?: Array<number | string> | null;
  onlyMissing?: boolean;
  timeout?: number;
  pinger?: Pinger;
} = {}): PingStatus {
  if (PING.running) return getStatus();

  const rows = selectNodes({ subId, ids, onlyMissing });
  PING = {
    running: true,
    total: rows.length,
    done: 0,
    ok: 0,
    failed: 0,
    currentId: null,
    currentName: "",
    startedAt: Date.now(),
    finishedAt: 0,
    error: "",
    cancelRequested: false,
    results: [],
  };
  if (rows.length === 0) {
    PING = { ...PING, running: false, finishedAt: Date.now() };
    return getStatus();
  }

  const doPing: Pinger = pinger || proxyCore.pingNode;
  currentRun = runQueue(rows, doPing, timeout)
    .catch((e) => {
      PING = { ...PING, running: false, error: (e as Error).message, finishedAt: Date.now() };
      logger.error("proxycore.ping.error", { error: (e as Error).message });
    })
    .finally(() => {
      currentRun = null;
    });

  return getStatus();
}

/** Последовательный обход очереди с записью результата в БД. */
async function runQueue(rows: NodeRow[], doPing: Pinger, timeout: number): Promise<PingStatus> {
  logger.action("proxycore.ping.start", { total: rows.length });
  for (const row of rows) {
    if (PING.cancelRequested) break;

    let node: { server?: string } | null = null;
    try {
      node = JSON.parse(row.config_json);
    } catch {
      /* битый config_json — остаётся null */
    }

    PING.currentId = row.id;
    PING.currentName = row.name || (node && node.server) || "";

    let res: { ok: boolean; ttfbMs: number | null; country: string | null; error?: string };
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
    if (res.ok) PING.ok++;
    else PING.failed++;
    PING.results.push({
      id: row.id,
      name: PING.currentName,
      ok: !!res.ok,
      ttfbMs: res.ttfbMs,
      error: res.error || "",
    });
  }

  PING = { ...PING, running: false, currentId: null, currentName: "", finishedAt: Date.now() };
  logger.action("proxycore.ping.done", {
    total: PING.total,
    done: PING.done,
    ok: PING.ok,
    failed: PING.failed,
    cancelled: PING.cancelRequested,
  });
  return getStatus();
}
