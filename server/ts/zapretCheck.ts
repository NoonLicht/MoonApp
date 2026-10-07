/**
 * Выделено из zapret.ts при разбиении крупного файла (поведение не менялось).
 */
import fs from "fs";
import { stmts } from "./db";
import path from "path";
import logger from "./logger";
import { runElevated } from "./elevate";
import { exec } from "child_process";
import { ensureUserLists, listStrategies, strategyId, vendorBatIndex } from "./zapretStrategies";
import { CONSOLE_LOG, DIRS, engineStatus, findEngineDir, installDir, queryService } from "./zapret";
import { USER_LISTS } from "./zapretLists";

/* ------------------------- Консольные прогоны (проверка конфигов / service.bat) ------------------------- */

/**
 * Проверка конфигов идёт тем же путём, что пункт 12 service.bat («Run Tests») —
 * utils/test zapret.ps1. Отличия только в обвязке:
 *   • ответы на интерактивные вопросы подаются через stdin (1 = standard, 1 = все конфиги);
 *   • stdout/stderr пишутся в CONSOLE_LOG, откуда их читает UI (стриминг в правой панели);
 *   • быстрый режим — те же тесты, но с короткими таймаутами (TEST_CURL_TIMEOUT/TEST_MAX_PARALLEL).
 * Результаты каждой конфигурации ложатся в БД (bypass_check_results) — «огоньки» на
 * плитках конфигов живут до следующей полной проверки.
 */

const CONSOLE_MAX_LINES = 500;

/** Общий поток вывода для правой панели-консоли (проверка/диагностика/списки). */
const consoleState: Record<string, any> = {
  mode: null, // null | "check" | "diag" | "lists"
  label: "",
  running: false,
  startedAt: 0,
  finishedAt: 0,
  exitCode: null,
  error: "",
  log: [],
  cursor: 0, // сколько байт CONSOLE_LOG уже прочитано
  best: null,
  bestId: null, // id конфига, который vendor-скрипт назвал лучшим
  results: [],
  progress: { done: 0, total: 0, current: null },
};

/** Сбросить консоль под новый прогон. */
function consoleReset(mode: any, label: any) {
  Object.assign(consoleState, {
    mode,
    label,
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    exitCode: null,
    error: "",
    log: [],
    cursor: 0,
    best: null,
    bestId: null,
    results: [],
    progress: { done: 0, total: mode === "check" ? listStrategies().length : 0, current: null },
  });
  try {
    fs.writeFileSync(CONSOLE_LOG, "", "utf8");
  } catch {
    /* ignore */
  }
}

function consolePush(line: any) {
  consoleState.log.push(line);
  if (consoleState.log.length > CONSOLE_MAX_LINES) {
    consoleState.log.splice(0, consoleState.log.length - CONSOLE_MAX_LINES);
  }
}

/** Дописать строки в лог напрямую (когда пишем не через cmd) и сразу отдать в буфер. */
function consoleWriteDirect(lines: any, persist: any) {
  try {
    fs.appendFileSync(CONSOLE_LOG, (lines || []).map((l: any) => `${l}\r\n`).join(""), "utf8");
  } catch {
    /* ignore */
  }
  consoleDrain(persist !== false);
}

// Маркеры vendor-скрипта utils/test zapret.ps1.
const CHECK_CFG_RE = /^\s*\[(\d+)\/(\d+)\]\s+(.+?\.bat)\s*$/;
const CHECK_FAILED_RE = /Strategy failed to start/i;
const CHECK_ANALYTICS_RE =
  /^\s*(.+?\.bat)\s*:\s*HTTP OK:\s*(\d+),\s*ERR:\s*(\d+),\s*UNSUP:\s*(\d+),\s*Ping OK:\s*(\d+),\s*Fail:\s*(\d+)/;
const CHECK_BEST_RE = /^\s*Best (?:config|strategy):\s*(.+?)\s*$/i;

/**
 * Огонёк конфига. Зелёный = конфиг рабочий: стартовал, и ни один HTTP/TLS-тест не упал
 * (error === 0, есть хотя бы один успешный тест). UNSUP — «метод не поддержан целью»,
 * это не ошибка; таймауты ICMP тоже игнорируем: пинг часто режет firewall, а для обхода
 * важны HTTP/TLS. Всё остальное — красный.
 */
export function lightOk(r: any) {
  return !!r && !r.failedToStart && (r.error || 0) === 0 && (r.okCount || 0) > 0;
}

/**
 * Итоговый цвет плитки после полной проверки: рабочий конфиг ИЛИ лучший по версии
 * vendor-скрипта («Best config: …») — его страница тоже подсвечивает зелёным.
 */
export function lightGreen(r: any, bestId: any) {
  if (!r || r.failedToStart || (r.okCount || 0) <= 0) return false;
  if ((r.error || 0) === 0) return true;
  return !!bestId && r.strategyId === bestId;
}

/** Докрасить огоньки после прогона (лучший конфиг тоже зелёный) и сохранить в БД. */
export function finalizeLights() {
  const bestId = consoleState.bestId;
  try {
    for (const row of stmts.bcrAll.all()) {
      const green = lightGreen(
        {
          strategyId: row.strategy_id,
          okCount: row.ok_count,
          error: row.error,
          unsup: row.unsup,
        },
        bestId,
      );
      if (green !== (Number(row.ok) === 1)) stmts.bcrSetOk.run(green ? 1 : 0, row.id);
    }
  } catch {
    /* БД недоступна — не критично */
  }
}

/** Результат конфига по имени .bat-файла (id совпадает с id стратегии в UI). */
function resultFor(file: any) {
  const sid = strategyId(file);
  let r = consoleState.results.find((x: any) => x.strategyId === sid);
  if (!r) {
    r = {
      strategyId: sid,
      file,
      okCount: 0,
      error: 0,
      unsup: 0,
      pingOk: 0,
      pingFail: 0,
      finished: false,
      failedToStart: false,
    };
    consoleState.results.push(r);
  }
  return r;
}

/** Сохранить огонёк конфига в БД (живёт до следующей полной проверки). */
function saveLight(r: any, persist: any) {
  if (persist === false) return;
  try {
    stmts.bcrUpsert.run(r.strategyId, {
      file: r.file,
      ok: lightOk(r) ? 1 : 0,
      ok_count: r.okCount || 0,
      error: r.error || 0,
      unsup: r.unsup || 0,
      ping_ok: r.pingOk || 0,
      ping_fail: r.pingFail || 0,
      checked_at: new Date().toISOString(),
      run_started_at: consoleState.startedAt
        ? new Date(consoleState.startedAt).toISOString()
        : null,
    });
  } catch {
    /* БД недоступна — не критично */
  }
}

/** Разбор одной строки вывода vendor-скрипта. */
function parseCheckLine(line: any, persist: any) {
  let m = CHECK_CFG_RE.exec(line);
  if (m) {
    const file = m[3].trim();
    consoleState.progress.total = Math.max(consoleState.progress.total, parseInt(m[2], 10));
    consoleState.progress.current = file;
    consoleState.progress.done = Math.max(0, parseInt(m[1], 10) - 1);
    resultFor(file);
    return;
  }
  const cur = consoleState.results[consoleState.results.length - 1];
  if (CHECK_FAILED_RE.test(line) && cur) {
    cur.failedToStart = true;
    cur.error = Math.max(cur.error || 0, 1);
    cur.finished = true;
    consoleState.progress.done = consoleState.results.filter((x: any) => x.finished).length;
    saveLight(cur, persist);
    return;
  }
  m = CHECK_ANALYTICS_RE.exec(line);
  if (m) {
    const r = resultFor(m[1].trim());
    r.okCount = parseInt(m[2], 10);
    r.error = parseInt(m[3], 10);
    r.unsup = parseInt(m[4], 10);
    r.pingOk = parseInt(m[5], 10);
    r.pingFail = parseInt(m[6], 10);
    r.finished = true;
    consoleState.progress.done = consoleState.results.filter((x: any) => x.finished).length;
    saveLight(r, persist);
    return;
  }
  m = CHECK_BEST_RE.exec(line);
  if (m) setBest(m[1]);
}

/** Запомнить конфиг, который vendor-скрипт назвал лучшим (файл .bat + id плитки). */
function setBest(file: any) {
  const name = String(file || "").trim();
  if (!name) return;
  consoleState.best = name;
  consoleState.bestId = strategyId(name);
}

/** Дочитать новые строки лога в буфер консоли (стриминг для поллинга UI). */
function consoleDrain(persist = true) {
  try {
    const size = fs.statSync(CONSOLE_LOG).size;
    if (size < consoleState.cursor) consoleState.cursor = 0; // лог перезаписан
    if (size === consoleState.cursor) return;
    const fd = fs.openSync(CONSOLE_LOG, "r");
    const len = size - consoleState.cursor;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, consoleState.cursor);
    fs.closeSync(fd);
    consoleState.cursor = size;
    const text = buf
      .toString("utf8")
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI-цвета (в файл обычно не попадают)
      .replace(/\r/g, "");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (!line) continue;
      consolePush(line);
      if (consoleState.mode === "check") parseCheckLine(line, persist);
    }
  } catch {
    /* лога ещё нет */
  }
}

/** Финальный разбор файла результатов vendor-скрипта (utils/test results/*.txt). */
function parseCheckResultsFile(dir?: any) {
  const engine = dir || findEngineDir();
  if (!engine) return 0;
  const resultsDir = path.join(engine, "utils", "test results");
  let newest = null;
  try {
    for (const f of fs.readdirSync(resultsDir)) {
      if (!/^test_results_.*\.txt$/i.test(f)) continue;
      const p = path.join(resultsDir, f);
      const st = fs.statSync(p);
      if (st.mtimeMs < (consoleState.startedAt || 0)) continue; // только свежий прогон
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { p, mtimeMs: st.mtimeMs };
    }
  } catch {
    return 0;
  }
  if (!newest) return 0;
  let n = 0;
  try {
    const lines = fs.readFileSync(newest.p, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const m =
        /^\s*(.+?\.bat)\s*:\s*HTTP OK:\s*(\d+),\s*ERR:\s*(\d+),\s*UNSUP:\s*(\d+),\s*Ping OK:\s*(\d+),\s*Fail:\s*(\d+)\s*$/.exec(
          line,
        );
      if (m) {
        const r = resultFor(m[1].trim());
        r.okCount = parseInt(m[2], 10);
        r.error = parseInt(m[3], 10);
        r.unsup = parseInt(m[4], 10);
        r.pingOk = parseInt(m[5], 10);
        r.pingFail = parseInt(m[6], 10);
        r.finished = true;
        saveLight(r, true);
        n++;
        continue;
      }
      const b = CHECK_BEST_RE.exec(line);
      if (b) setBest(b[1]);
    }
  } catch {
    /* ignore */
  }
  return n;
}

/**
 * Прогнать строки вывода через парсер огоньков (используется стримингом и тестами).
 * @param {string[]} lines строки вывода
 * @param {{ persist?: boolean }} [opts] persist=false — не писать в БД (тесты)
 */
export function parseCheckOutput(lines: any, opts: Record<string, any> = {}) {
  consoleState.mode = "check";
  consoleState.results = [];
  consoleState.best = null;
  consoleState.bestId = null;
  consoleState.progress = { done: 0, total: 0, current: null };
  for (const l of lines || []) parseCheckLine(String(l), opts.persist !== false);
  return checkStatus();
}

/** Завершение любого консольного прогона (общий хвост для check/diag). */
function finishRun(r: any, mode: any) {
  consoleDrain(mode === "check");
  if (mode === "check") {
    try {
      parseCheckResultsFile();
    } catch {
      /* ignore */
    }
    finalizeLights();
  }
  consoleState.running = false;
  consoleState.finishedAt = Date.now();
  consoleState.exitCode = r && Number.isFinite(r.exitCode) ? r.exitCode : null;
  if (r && r.error === "uac_cancelled") consoleState.error = "uac_cancelled";
  else if (mode === "check") {
    // Остановку пользователем не перетираем, а прогон без результатов — это ошибка.
    const kept = consoleState.error === "stopped_by_user" ? "stopped_by_user" : "";
    consoleState.error = consoleState.results.length
      ? kept
      : r && r.error
        ? String(r.error)
        : "no_results";
  } else if (r && r.error && !consoleState.error) consoleState.error = String(r.error);
  if (mode === "check") {
    consoleState.progress.done = consoleState.results.filter((x: any) => x.finished).length;
  }
  logger.action("zapret.console.done", {
    mode,
    exitCode: consoleState.exitCode,
    error: consoleState.error,
    results: consoleState.results.length,
  });
}

/** Запустить elevated-скрипт (один UAC) с выводом в CONSOLE_LOG. */
function runConsoleScript(body: any, mode: any, opts: Record<string, any> = {}) {
  const file = path.join(DIRS.tmp, `zapret_${mode}_${Date.now()}.cmd`);
  fs.writeFileSync(file, body, "utf8");
  runElevated(file, [], {
    wait: true,
    timeoutMs: opts.timeoutMs || 20 * 60 * 1000,
    workingDir: opts.workingDir || DIRS.tmp,
  })
    .then((r) => finishRun(r, mode))
    .catch((e) => finishRun({ ok: false, error: String(e.message || e) }, mode));
}

/**
 * Проверка всех конфигов «как пункт 12 service.bat», но неинтерактивно и быстро:
 * стандартные тесты по utils/targets.txt для всех general*.bat.
 *
 * @param {{ fast?: boolean, timeoutSec?: number, parallel?: number, strategyId?: string }} [opts]
 *   strategyId — проверить ТОЛЬКО выбранный конфиг (иначе проверяются все).
 */
export async function startConfigCheck(opts: Record<string, any> = {}) {
  if (consoleState.running) return checkStatus();
  const st = engineStatus();
  if (!st.found) throw new Error("engine_not_found");
  // vendor-скрипт отказывается работать при установленной службе zapret.
  const svc = await queryService();
  if (svc.installed) throw new Error("service_installed");
  const script = path.join(st.dir, "utils", "test zapret.ps1");
  if (!fs.existsSync(script)) throw new Error("check_script_not_found");
  try {
    ensureUserLists();
  } catch {
    /* ignore */
  }

  const fast = opts.fast !== false;
  // Ответы vendor-скрипту: 1 = standard tests (HTTP/ping); затем либо 1 = все
  // конфиги, либо 2 = выбранные + номер конфига (проверка одного).
  let answers = "1\r\n1\r\n";
  let scope = "all configs";
  if (opts.strategyId) {
    const strat = listStrategies().find((s) => s.id === opts.strategyId);
    if (!strat) throw new Error("strategy_not_found");
    const idx = vendorBatIndex(strat.file);
    if (!idx) throw new Error("strategy_not_found");
    answers = `1\r\n2\r\n${idx}\r\n`;
    scope = `single config: ${strat.file} (#${idx})`;
  }
  const answersFile = path.join(DIRS.tmp, "zapret_check_answers.txt");
  fs.writeFileSync(answersFile, answers, "utf8");
  consoleReset("check", path.join("utils", "test zapret.ps1"));
  try {
    stmts.bcrClear.run();
  } catch {
    /* ignore */
  } // старые огоньки гасим до новой проверки
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${st.dir}"`,
    ...(fast
      ? [
          `set "TEST_CURL_TIMEOUT=${opts.timeoutSec || 2}"`,
          `set "TEST_MAX_PARALLEL=${opts.parallel || 16}"`,
        ]
      : []),
    'set "NO_UPDATE_CHECK=1"',
    `echo [PA] ${fast ? "fast" : "full"} check: ${scope}, standard tests`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" < "${answersFile}" >> "${CONSOLE_LOG}" 2>&1`,
    "echo [PA] powershell exit %ERRORLEVEL%",
  ].join("\r\n");
  logger.action("zapret.check.start", {
    fast,
    configs: opts.strategyId ? 1 : listStrategies().length,
    strategyId: opts.strategyId || null,
  });
  runConsoleScript(body, "check", { workingDir: st.dir });
  return checkStatus();
}

/** Остановить проверку: гасим vendor-PowerShell и winws, поднятый проверкой. */
export async function stopConfigCheck() {
  if (!consoleState.running) return checkStatus();
  const st = engineStatus();
  consoleState.error = "stopped_by_user";
  consoleState.running = false;
  consoleState.finishedAt = Date.now();
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    "echo [PA] остановка проверки...",
    // %% в .cmd-файле даёт литеральный % (иначе cmd съест '%test zapret.ps1%').
    "wmic process where \"name='powershell.exe' and commandline like '%%test zapret.ps1%%'\" delete >nul 2>&1",
    "taskkill /IM winws.exe /F >nul 2>&1",
    "echo [PA] stopped",
  ].join("\r\n");
  try {
    const file = path.join(DIRS.tmp, `zapret_check_stop_${Date.now()}.cmd`);
    fs.writeFileSync(file, body, "utf8");
    await runElevated(file, [], { wait: true, timeoutMs: 90000, workingDir: st.dir || DIRS.tmp });
  } catch {
    /* ignore */
  }
  consoleDrain(false);
  logger.action("zapret.check.stop", {});
  return checkStatus();
}

/** Пункт 11 service.bat — «Run Diagnostics» (BFE, системный прокси, TCP timestamps). */
export async function runServiceDiagnostics() {
  if (consoleState.running) throw new Error("busy");
  const st = engineStatus();
  if (!st.found) throw new Error("engine_not_found");
  const bat = path.join(st.dir, "service.bat");
  if (!fs.existsSync(bat)) throw new Error("service_bat_not_found");
  consoleReset("diag", "service.bat → Run Diagnostics");
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${st.dir}"`,
    "echo [PA] service.bat: Run Diagnostics",
    // 11 = диагностика, пустая строка = pause, 0 = выход из меню.
    `(echo 11&echo.&echo 0)| "${bat}" admin >> "${CONSOLE_LOG}" 2>&1`,
    "echo [PA] exit %ERRORLEVEL%",
  ].join("\r\n");
  logger.action("zapret.diag.start", {});
  runConsoleScript(body, "diag", { workingDir: st.dir, timeoutMs: 5 * 60 * 1000 });
  return checkStatus();
}

/**
 * Пункт service.bat `load_user_lists` + наши дефолты: создаёт/чинит
 * lists\*-user.txt (лечит "cannot access ipset file ..."). Без UAC.
 */
export async function fixUserLists() {
  if (consoleState.running) throw new Error("busy");
  const st = engineStatus();
  if (!st.found) throw new Error("engine_not_found");
  consoleReset("lists", "service.bat → Load User Lists");
  const bat = path.join(st.dir, "service.bat");
  const lines = [`[PA] user lists → ${st.listsDir || ""}`];
  if (fs.existsSync(bat)) {
    const out = await new Promise<any>((resolve) => {
      exec(
        `cmd /c ""${bat}" load_user_lists"`,
        { cwd: st.dir, windowsHide: true, timeout: 30000 },
        (e, o, er) => resolve({ e, o, er }),
      );
    });
    for (const l of String(out.o || "").split(/\r?\n/)) if (l.trim()) lines.push(l);
    if (out.e) lines.push(`[WARN] ${out.e.message}`);
  } else {
    lines.push("[WARN] service.bat не найден — создаём дефолты сами");
  }
  const created = ensureUserLists();
  const listsDir = st.listsDir || path.join(installDir(), "lists");
  for (const name of USER_LISTS) {
    let size = -1;
    try {
      size = fs.statSync(path.join(listsDir, name)).size;
    } catch {
      /* нет файла */
    }
    lines.push(`${size >= 0 ? "[OK]" : "[MISSING]"} ${name}${size >= 0 ? ` (${size} B)` : ""}`);
  }
  lines.push(created.length ? `[PA] создано: ${created.join(", ")}` : "[PA] все списки на месте");
  consoleWriteDirect(lines, true);
  consoleState.running = false;
  consoleState.finishedAt = Date.now();
  consoleState.exitCode = 0;
  consoleState.progress.done = consoleState.progress.total;
  logger.action("zapret.userLists.fix", { created });
  return checkStatus();
}

/** Состояние консоли + огоньки конфигов для страницы (поллинг UI). */
export function checkStatus() {
  if (consoleState.running) consoleDrain(true);
  const lights: Record<string, any> = {};
  try {
    for (const row of stmts.bcrAll.all()) lights[row.strategy_id] = row;
  } catch {
    /* ignore */
  }
  const state = consoleState.running
    ? "working"
    : !consoleState.mode
      ? "idle"
      : consoleState.error
        ? "error"
        : "done";
  return {
    state,
    mode: consoleState.mode,
    label: consoleState.label,
    running: consoleState.running,
    startedAt: consoleState.startedAt,
    finishedAt: consoleState.finishedAt,
    exitCode: consoleState.exitCode,
    error: consoleState.error,
    best: consoleState.best,
    bestId: consoleState.bestId,
    progress: { ...consoleState.progress },
    results: consoleState.results.map((r: any) => ({ ...r })),
    log: consoleState.log.slice(-250),
    logCursor: consoleState.cursor,
    lights,
  };
}
