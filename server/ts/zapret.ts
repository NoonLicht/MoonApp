/**
 * DPI Bypass движок — обёртка Flowseal/zapret-discord-youtube.
 *
 * Движок кладётся в <app>/resources/zapret/ (или server/vendor/zapret/, или
 * путь из настроек zapret.dir): winws.exe, service.bat, general*.bat, bin/, lists/.
 *
 * Два режима:
 *   process — winws.exe как управляемый child process (spawn);
 *   service — service.bat service_install/remove через UAC (elevate.js).
 */
import __m___config from "./config";
import path from "path";
import settings from "./settings";
import fs from "fs";
import { runElevated } from "./elevate";
import logger from "./logger";
import { exec, execFile } from "child_process";
import { stmts } from "./db";
import { localVersion } from "./zapretInstall";
import {
  ensureUserLists,
  listStrategies,
  missingListFiles,
  parseBatConfig,
  readGameFilter,
  strategyId,
  tokenizeArgs,
  writeGameFilter,
} from "./zapretStrategies";
export {
  listStrategies,
  listBatFiles,
  extractWinwsArgs,
  tokenizeArgs,
  parseBatConfig,
  USER_LIST_DEFAULTS,
  ensureUserLists,
  missingListFiles,
  strategyId,
  vendorOrder,
  vendorBatIndex,
  readGameFilter,
  writeGameFilter,
  strategyGroup,
} from "./zapretStrategies";
export { targets, runDiagnostics, autoTune } from "./zapretDiagnostics";
export {
  USER_LISTS,
  readList,
  writeList,
  syncCustomDomains,
  listPayloads,
  clearDiscordCache,
  flushDns,
} from "./zapretLists";
export {
  lightOk,
  lightGreen,
  finalizeLights,
  startConfigCheck,
  stopConfigCheck,
  checkStatus,
  parseCheckOutput,
  runServiceDiagnostics,
  fixUserLists,
} from "./zapretCheck";
export {
  GITHUB_REPO,
  checkUpdate,
  installEngine,
  installStatus,
  localVersion,
} from "./zapretInstall";

export const { DIRS } = __m___config;

const SERVICE_NAME = "zapret";
export const GAME_TCP_PORTS = "1024-65535";
export const GAME_UDP_PORTS = "1024-65535";
/** Лог elevated-процесса winws (в консоль elevated-окна не заглянуть). */
const WINWS_LOG = path.join(DIRS.logs, "zapret_winws.log");
/** Общий лог консольных прогонов (проверка конфигов / диагностика service.bat). */
export const CONSOLE_LOG = path.join(DIRS.logs, "zapret_console.log");

/* ------------------------- Каталог движка ------------------------- */

export function cfg() {
  return settings.get("zapret");
}

/** Каталог установки движка (куда качаем релиз с GitHub). */
function installDir() {
  const c = cfg();
  if (c.dir && String(c.dir).trim()) return path.resolve(String(c.dir).trim());
  return DIRS.zapret;
}

/** winws.exe в релизе лежит в bin/ — поддерживаем оба варианта + вложенную папку. */
export function probeEngineDir(p: any) {
  if (!p) return null;
  if (fs.existsSync(path.join(p, "bin", "winws.exe"))) return p;
  if (fs.existsSync(path.join(p, "winws.exe"))) return p;
  // Распакованный релиз лежит во вложенной папке (zapret-discord-youtube-<ver>/).
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(p, e.name, "bin", "winws.exe"))) return path.join(p, e.name);
    }
  } catch {
    /* нет доступа/нет папки */
  }
  return null;
}

export function findEngineDir() {
  const c = cfg();
  const candidates = [
    c.dir && String(c.dir).trim() && path.resolve(String(c.dir).trim()),
    process.env.MOONAPP_ZAPRET && path.resolve(process.env.MOONAPP_ZAPRET),
    DIRS.zapret,
    path.join(__dirname, "..", "resources", "zapret"),
    path.join(__dirname, "vendor", "zapret"),
    path.join(__dirname, "..", "zapret"),
  ].filter(Boolean);
  for (const p of candidates) {
    const found = probeEngineDir(p);
    if (found) return found;
  }
  return null;
}

function engineStatus() {
  const dir = findEngineDir();
  const winws = dir
    ? fs.existsSync(path.join(dir, "bin", "winws.exe"))
      ? path.join(dir, "bin", "winws.exe")
      : path.join(dir, "winws.exe")
    : null;
  const info = localVersion();
  return {
    found: !!dir,
    dir,
    installDir: installDir(),
    winws,
    binDir: dir ? path.dirname(winws as string) : path.join(installDir(), "bin"),
    serviceBat: dir ? path.join(dir, "service.bat") : null,
    listsDir: dir ? path.join(dir, "lists") : null,
    version: info.tag || null,
    gameFilter: readGameFilter(),
  };
}

/* ------------------------- Запуск / остановка ------------------------- */

let child: any = null; // текущий процесс winws (режим process)
const lastLog: any[] = []; // хвост вывода winws
export let activeProfile: any = null; // { strategyId, customArgs, mode }

function logLine(line: any) {
  lastLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (lastLog.length > 200) lastLog.splice(0, lastLog.length - 200);
}

/** Собрать аргументы winws для стратегии: токены .bat + кастомные args. */
function buildArgs(strategyId: any, customArgs: any) {
  const strat = listStrategies().find((s) => s.id === strategyId);
  const base = strat ? parseBatConfig(strat.filePath).tokens : [];
  const extra = tokenizeArgs(customArgs || "");
  return { strat, tokens: [...base, ...extra] };
}

/** Экранирование токена для cmd: пробелы → кавычки. */
function quoteForCmd(t: any) {
  return /\s/.test(t) ? `"${t.replace(/"/g, "")}"` : t;
}

/** Хвост лога winws (elevated-процесс пишет вывод в файл). */
function readWinwsLog(lines = 40) {
  try {
    const txt = fs.readFileSync(WINWS_LOG, "utf8").replace(/\r/g, "");
    return txt.split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/** Пауза. */
export function sleep(ms: any) {
  return new Promise<any>((r) => setTimeout(r, ms));
}

/**
 * Запуск winws.exe на постоянной основе (standalone-режим).
 *
 * winws.exe требует прав администратора (драйвер WinDivert), поэтому поднимаем
 * его одним elevated-скриптом: остановка прежнего процесса/службы + запуск
 * нового с записью вывода в storage/logs/zapret_winws.log (один UAC-запрос).
 */
async function startElevatedProcess(st: any, tokens: any, strategyId: any) {
  const script = [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${st.binDir}"`,
    `net stop ${SERVICE_NAME} >nul 2>&1`,
    "taskkill /IM winws.exe /F >nul 2>&1",
    "ping -n 2 127.0.0.1 >nul",
    `if exist "${WINWS_LOG}" del /f /q "${WINWS_LOG}"`,
    `"${st.winws}" ${tokens.map(quoteForCmd).join(" ")} 1> "${WINWS_LOG}" 2>&1`,
  ].join("\r\n");
  cleanOldRunScripts();
  const file = path.join(DIRS.tmp, `zapret_run_${Date.now()}.cmd`);
  fs.writeFileSync(file, script, "utf8");
  logLine(`start (elevated): ${strategyId} · ${tokens.length} args`);
  const r = await runElevated(file, [], {
    wait: false,
    timeoutMs: 120000,
    softTimeoutMs: 15000,
    workingDir: st.binDir,
  });
  if (!r.ok)
    throw new Error(r.error === "uac_cancelled" ? "uac_cancelled" : r.error || "elevate_failed");
  // Ждём старта после подтверждения UAC: до 10 попыток по 1.5 c — нужно время
  // и на ответ в диалоге UAC, и на инициализацию драйвера WinDivert.
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const det = await detectRunningWinws(st);
    if (det.started) return { pid: det.pid, killed: det.killed, pending: false };
  }
  if (r.pending) {
    // UAC ещё не подтверждён — движок поднимется сам, как только пользователь ответит.
    logLine("ожидание подтверждения UAC");
    return { pid: null, killed: 0, pending: true };
  }
  // Хвост лога в текст ошибки: помечаем «…», если строк было больше, чем помещается.
  const allTail = readWinwsLog(8).join(" ");
  const tail = allTail.length > 300 ? `…${allTail.slice(-300)}` : allTail;
  throw new Error(`winws_not_started${tail ? ": " + tail : ""}`);
}

/** Удаляем старые временные скрипты запуска (Win хранит их занятыми недолго). */
function cleanOldRunScripts() {
  try {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const f of fs.readdirSync(DIRS.tmp)) {
      if (!/^zapret_(run|service_|kill)/.test(f)) continue;
      const p = path.join(DIRS.tmp, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch {
        /* занят */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Маркеры успешного старта в логе winws. Лог перед каждым запуском удаляется,
 * поэтому их наличие означает, что стартовал именно наш процесс.
 */
function winwsLogStarted() {
  return /windivert initialized|capture is started/i.test(readWinwsLog(80).join("\n"));
}

/**
 * Решение «движок стартовал» (чистая функция — покрыта тестами в tests/bypass.test.ts).
 *
 * Почему нельзя полагаться только на путь процесса: winws.exe требует прав
 * администратора, а у elevated-процесса путь недоступен обычному процессу —
 * и Get-Process ($_.Path), и CIM (ExecutablePath) отдают пустую строку, при этом
 * PID в tasklist виден. Раньше из-за этого исправный запуск помечался ошибкой
 * winws_not_started. Поэтому: путь проверяем, когда он есть; иначе (чужие winws
 * перед стартом гасятся тем же скриптом) считаем процесс своим, а самым надёжным
 * признаком считаем маркеры в логе.
 *
 * @param {{ procs: {pid:number, path:string}[], engineDir: string|null, logStarted: boolean }} input
 */
function decideWinwsStarted(input: any) {
  const procs = Array.isArray(input.procs) ? input.procs : [];
  const ours = procs.filter((p: any) => isOurWinws(p.path, input.engineDir));
  if (ours.length) {
    return {
      started: true,
      pid: ours[0].pid,
      killed: Math.max(0, procs.length - ours.length),
      reason: "path",
    };
  }
  if (input.logStarted) {
    return { started: true, pid: procs.length ? procs[0].pid : null, killed: 0, reason: "log" };
  }
  const unknown = procs.filter((p: any) => !p.path);
  if (unknown.length) {
    return {
      started: true,
      pid: unknown[0].pid,
      killed: Math.max(0, procs.length - unknown.length),
      reason: "elevated_path_unknown",
    };
  }
  return { started: false, pid: null, killed: 0, reason: "not_found" };
}

/** Опросить систему и решить, стартовал ли наш winws. */
async function detectRunningWinws(st: any) {
  const procs = await listWinwsProcesses();
  const det = decideWinwsStarted({ procs, engineDir: st && st.dir, logStarted: winwsLogStarted() });
  if (det.started && det.reason === "elevated_path_unknown") {
    logLine(`winws без доступного пути (elevated) — считаем своим: pid ${det.pid}`);
  }
  return det;
}

/**
 * Скрипт-оболочка «запустить конфиг ровно как вручную».
 *
 * Зачем так: .bat движка сам делает пред-шаги (status_zapret / load_game_filter /
 * load_user_lists) и поднимает winws через `start /min`, поэтому поведение
 * совпадает с двойным кликом по .bat — включая служебное окно «zapret: <конфиг>».
 * Раньше мы собирали командную строку winws сами; аргументы совпадали, но
 * получалось запустить движок без окон и пред-шагов.
 *
 * `<nul` защищает от возможного `pause` внутри vendor-скрипта: окно не зависнет.
 *
 * @param {string} batPath  абсолютный путь к .bat конфига
 * @param {string} engineDir каталог движка (рабочий каталог)
 */
function buildBatLaunchScript(batPath: any, engineDir: any) {
  return [
    "@echo off",
    "chcp 65001 >nul",
    // У приложения своя кнопка «Проверить обновления», а vendor-проверка может
    // задержать старт winws на ~9 c сетевым запросом — отключаем её.
    'set "NO_UPDATE_CHECK=1"',
    `cd /d "${engineDir}"`,
    // Два winws конфликтуют за драйвер WinDivert — начинаем с чистого листа.
    "taskkill /IM winws.exe /F >nul 2>&1",
    `net stop ${SERVICE_NAME} >nul 2>&1`,
    "ping -n 2 127.0.0.1 >nul",
    `call "${batPath}" <nul`,
  ].join("\r\n");
}

/** Ждать появления процесса winws (до timeoutMs). */
async function waitForWinws(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const procs = await listWinwsProcesses();
    if (procs.length) return { pid: procs[0].pid, count: procs.length };
    if (Date.now() >= deadline) return { pid: null, count: 0 };
    await sleep(1000);
  }
}

/**
 * Запуск выбранного конфига через сам .bat движка (один UAC-запрос).
 * Возвращает { pid, pending }: pending=true, если UAC ещё не подтверждён.
 */
async function launchBatElevated(strat: any, st: any) {
  cleanOldRunScripts();
  const file = path.join(DIRS.tmp, `zapret_run_${Date.now()}.cmd`);
  fs.writeFileSync(file, buildBatLaunchScript(strat.filePath, st.dir), "utf8");
  logLine(`start (bat): ${path.basename(strat.filePath)}`);
  const r = await runElevated(file, [], {
    wait: false,
    timeoutMs: 120000,
    softTimeoutMs: 15000,
    workingDir: st.dir,
  });
  if (!r.ok)
    throw new Error(r.error === "uac_cancelled" ? "uac_cancelled" : r.error || "elevate_failed");
  // Всё лишнее уже погашено оболочкой, поэтому появившийся winws — наш.
  const det = await waitForWinws(25000);
  if (det.pid) return { pid: det.pid, pending: false };
  if (r.pending) return { pid: null, pending: true };
  throw new Error("winws_not_started");
}

async function start(opts: Record<string, any> = {}) {
  const st = engineStatus();
  if (!st.found) throw new Error("engine_not_found");
  const c = cfg();
  const mode = opts.mode || c.mode || "process";
  const strategyId = opts.strategyId || c.defaultStrategy || "general";
  const customArgs = String(opts.customArgs || "").trim();
  const strat = listStrategies().find((s) => s.id === strategyId);
  if (!strat) throw new Error("unknown_strategy");
  const { tokens } = buildArgs(strategyId, customArgs);

  // Пользовательские списки движка обязаны существовать, иначе winws падает с
  // "cannot access ipset file ... failed to register ipset" (их создаёт service.bat).
  try {
    ensureUserLists();
  } catch {
    /* движок может быть не развёрнут */
  }
  writeGameFilter();

  if (mode === "service") {
    // Служба ставится из тех же аргументов, что и .bat (binPath).
    if (!tokens.length) throw new Error("no_winws_args");
    const missing = missingListFiles(tokens);
    if (missing.length) throw new Error(`missing_lists: ${missing.join(", ")}`);
    child = null;
    await installService(strategyId, tokens);
    activeProfile = { strategyId, customArgs, mode: "service" };
  } else if (customArgs) {
    // Свои аргументы winws задать через .bat нельзя — собираем командную строку сами.
    if (!tokens.length) throw new Error("no_winws_args");
    const missing = missingListFiles(tokens);
    if (missing.length) throw new Error(`missing_lists: ${missing.join(", ")}`);
    child = null;
    const res = await startElevatedProcess(st, tokens, strategyId);
    if (res.pending) logLine("подтвердите UAC — движок стартует автоматически");
    else
      logLine(
        `winws pid ${res.pid}${res.killed > 0 ? ` (остановлено сторонних: ${res.killed})` : ""}`,
      );
    activeProfile = { strategyId, customArgs, mode: "process", pending: !!res.pending };
  } else {
    // Простой запуск: тот же .bat, что пользователь запускал бы двойным кликом.
    child = null;
    const res = await launchBatElevated(strat, st);
    if (res.pending) logLine("подтвердите UAC — движок стартует автоматически");
    else logLine(`winws pid ${res.pid}`);
    activeProfile = { strategyId, customArgs, mode: "process", pending: !!res.pending };
  }
  setDefaultProfile(strategyId, customArgs, mode, strat.filePath);
  logger.action("zapret.start", {
    strategyId,
    mode,
    customArgs: !!customArgs,
    tokens: tokens.length,
  });
  return status();
}

/** Выполнить cmd-скрипт с правами администратора (один UAC-запрос). */
async function runElevatedScript(body: any, name: any, timeoutMs: any) {
  const file = path.join(DIRS.tmp, `${name}_${Date.now()}.cmd`);
  try {
    fs.writeFileSync(file, body, "utf8");
    return await runElevated(file, [], {
      timeoutMs: timeoutMs || 120000,
      workingDir: engineStatus().dir || DIRS.tmp,
    });
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Токен в строку для binPath службы: пробелы → \"...\" (для sc create). */
function serviceArg(t: any) {
  return /\s/.test(t) ? `\\"${t.replace(/"/g, "")}\\"` : t;
}

/**
 * Установка winws как службы Windows (UAC).
 * * Штатный `service.bat service_install` интерактивен (просит выбрать .bat через
 * set /p), поэтому создаём службу сами тем же способом, что и официальный скрипт:
 *   sc create zapret binPath= "\"<winws.exe>\" <аргументы стратегии>" start= auto
 *   reg add HKLM\...\Services\zapret /v zapret-discord-youtube /d "<имя конфига>"
 * Реестровый ключ нужен, чтобы service.bat/статус знали активную стратегию.
 */
async function installService(strategyId: any, tokens: any) {
  const st = engineStatus();
  // Служба стартует winws напрямую — списки должны существовать до binPath.
  try {
    ensureUserLists();
  } catch {
    /* ignore */
  }
  const missingSvc = missingListFiles(tokens);
  if (missingSvc.length) throw new Error(`missing_lists: ${missingSvc.join(", ")}`);
  const strat = listStrategies().find((s) => s.id === strategyId);
  const script = [
    "@echo off",
    "chcp 65001 >nul",
    `net stop ${SERVICE_NAME} >nul 2>&1`,
    `sc delete ${SERVICE_NAME} >nul 2>&1`,
    `sc create ${SERVICE_NAME} binPath= "\\"${st.winws}\\" ${tokens.map(serviceArg).join(" ")}" DisplayName= "zapret" start= auto`,
    "if errorlevel 1 (echo CREATE_FAILED & exit /b 1)",
    `sc description ${SERVICE_NAME} "Zapret DPI bypass software" >nul`,
    "taskkill /IM winws.exe /F >nul 2>&1",
    "ping -n 2 127.0.0.1 >nul",
    `sc start ${SERVICE_NAME}`,
    `reg add "HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}" /v zapret-discord-youtube /t REG_SZ /d "${strat ? strat.file : ""}" /f >nul`,
    "echo SERVICE_OK",
  ].join("\r\n");
  const r = await runElevatedScript(script, "zapret_service_install", 180000);
  if (!r.ok) throw new Error(r.error || "service_install_failed");
  logLine("service installed: " + (strat ? strat.file : ""));
  return true;
}

/** Удаление службы + остановка драйвера WinDivert (по образцу service.bat). */
async function removeService() {
  const script = [
    "@echo off",
    "chcp 65001 >nul",
    `net stop ${SERVICE_NAME} >nul 2>&1`,
    `sc delete ${SERVICE_NAME} >nul 2>&1`,
    "taskkill /IM winws.exe /F >nul 2>&1",
    "net stop WinDivert >nul 2>&1",
    "sc delete WinDivert >nul 2>&1",
    `reg delete "HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}" /f >nul 2>&1`,
    "echo SERVICE_REMOVED",
  ].join("\r\n");
  const r = await runElevatedScript(script, "zapret_service_remove", 120000);
  if (!r.ok) throw new Error(r.error || "service_remove_failed");
  return true;
}

/** Список процессов winws.exe: [{ pid, path }] (для точечной остановки). */
function listWinwsProcesses() {
  return new Promise<any>((resolve) => {
    exec(
      "powershell -NoProfile -Command \"Get-Process winws -EA SilentlyContinue | ForEach-Object { ($_.Id.ToString() + '|' + $_.Path) }\"",
      { windowsHide: true, timeout: 15000 },
      (err, out) => {
        if (err) return resolve([]);
        resolve(
          String(out || "")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const [pid, p] = l.split("|");
              return { pid: parseInt(pid, 10), path: p || "" };
            })
            .filter((x) => x.pid),
        );
      },
    );
  });
}

/** Является ли путь процесса нашим движком (а не чужой копией zapret). */
function isOurWinws(p: any, engineDir: any) {
  if (!engineDir || !p) return false;
  try {
    return path.resolve(p).toLowerCase().startsWith(path.resolve(engineDir).toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Остановка DPI-обхода.
 * @param {{ killForeign?: boolean }} opts killForeign=true убивает любой winws
 * (нужно перед стартом: два winws конфликтуют за WinDivert-драйвер).
 */
async function stop(opts: Record<string, any> = {}) {
  const killForeign = opts.killForeign !== false;
  const engineDir = findEngineDir();
  let stopped = false;
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    stopped = true;
  }
  child = null;
  // winws запущен elevated — обычный taskkill может не сработать (Access denied).
  try {
    const procs = await listWinwsProcesses();
    const targets = procs.filter((p: any) => (killForeign ? true : isOurWinws(p.path, engineDir)));
    for (const p of targets) {
      await new Promise<void>((r) =>
        execFile("taskkill", ["/PID", String(p.pid), "/F"], { windowsHide: true }, () => r()),
      );
    }
    if (targets.length) stopped = true;
    if (targets.length) {
      await sleep(700);
      const left = await listWinwsProcesses();
      if (left.length) {
        // Первый заход не удался (elevated-процесс) — повторяем с UAC.
        await runElevatedScript(
          ["@echo off", "taskkill /IM winws.exe /F >nul 2>&1", "echo OK"].join("\r\n"),
          "zapret_kill",
          60000,
        );
      }
    }
  } catch {
    /* ignore */
  }
  // Если установлена служба — УДАЛЯЕМ её (аналог пункта 2 service.bat
  // «Remove Services»). Просто `net stop` оставил бы winws автозапускаемым и
  // держащим драйвер WinDivert, из-за чего следующий запуск конфликтовал бы.
  try {
    const svc = await queryService();
    if (svc.installed) {
      try {
        await removeService();
        stopped = true;
      } catch {
        /* нет прав / уже удалена — не критично */
      }
    }
  } catch {
    /* ignore */
  }
  if (stopped) logger.action("zapret.stop", {});
  return status();
}

function setDefaultProfile(strategyId: any, customArgs: any, mode: any, batchFilePath: any) {
  try {
    stmts.bpClearActive.run();
    stmts.bpInsert.run(
      `auto: ${strategyId} (${mode})`,
      batchFilePath || "",
      customArgs || "",
      1,
      mode === "service",
    );
  } catch {
    /* некритично */
  }
}

/** Состояние службы zapret + активная стратегия из реестра (без UAC). */
export function queryService() {
  return new Promise<any>((resolve) => {
    execFile("sc", ["query", SERVICE_NAME], { windowsHide: true }, (err, stdout) => {
      const installed = !err && /STATE/.test(stdout || "");
      const running = installed && /RUNNING/.test(stdout || "");
      execFile(
        "reg",
        [
          "query",
          `HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}`,
          "/v",
          "zapret-discord-youtube",
        ],
        { windowsHide: true },
        (e2, out2) => {
          const m = /zapret-discord-youtube\s+REG_SZ\s+(.+)/i.exec(out2 || "");
          resolve({
            installed,
            running,
            strategyFile: m ? m[1].trim() : "",
            raw: (stdout || "").trim().slice(-200),
          });
        },
      );
    });
  });
}

async function status() {
  const svc = await queryService();
  let winwsRunning = false,
    winwsPid = null,
    memKb = null;
  try {
    const out = await new Promise<any>((res) =>
      exec('tasklist /FI "IMAGENAME eq winws.exe" /FO CSV /NH', { windowsHide: true }, (e, o) =>
        res(o || ""),
      ),
    );
    const m = out.match(/"winws\.exe","(\d+)"/i);
    if (m) {
      winwsRunning = true;
      winwsPid = parseInt(m[1], 10);
    }
    const memM = out.match(/"([\d\s,.]+)\s+K"/i);
    if (memM) memKb = parseInt(memM[1].replace(/[^\d]/g, ""), 10);
  } catch {
    /* ignore */
  }
  return {
    active: winwsRunning || svc.running,
    process: { running: winwsRunning, pid: winwsPid, memKb },
    service: svc,
    mode: child ? "process" : svc.running ? "service" : cfg().mode || "process",
    profile: activeProfile,
    log: activeProfile?.mode === "process" ? readWinwsLog(40) : lastLog.slice(-40),
    engine: engineStatus(),
    strategy: activeProfile?.strategyId || (svc.strategyFile ? strategyId(svc.strategyFile) : null),
    version: localVersion().tag,
    gameFilter: readGameFilter(),
  };
}

async function serviceAction(action: any, strategyId: any) {
  const st = engineStatus();
  if (action === "status") return { ok: true, ...(await queryService()) };
  if (!st.found) throw new Error("engine_not_found");
  if (action === "install") {
    // Установка службы для выбранного профиля; без выбора — дефолтная стратегия.
    const id = strategyId || cfg().defaultStrategy || "general";
    if (!listStrategies().some((s) => s.id === id)) throw new Error("strategy_not_found");
    const tokens = buildArgs(id, "").tokens;
    await installService(id, tokens);
  } else if (action === "remove") {
    await removeService();
  } else {
    throw new Error("unknown_service_action");
  }
  logger.action("zapret.service", { action, strategyId: strategyId || null });
  return { ok: true, ...(await queryService()) };
}
export {
  engineStatus,
  start,
  stop,
  status,
  serviceAction,
  decideWinwsStarted,
  detectRunningWinws,
  buildBatLaunchScript,
  waitForWinws,
  installDir,
};
