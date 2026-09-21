/**
 * TG WS Proxy — локальный MTProto-прокси для Telegram Desktop
 * (Flowseal/tg-ws-proxy): перегоняет трафик Telegram через WebSocket-соединения
 * к дата-центрам Telegram и тем самым обходит замедление MTProto.
 *
 * Почему сторонний бинарь: разбор MTProto-obfuscation пакетов и WebSocket-мосты
 * к DC — это отдельный проект; наша задача та же, что с zapret/sing-box:
 * скачать, настроить, запустить и показать состояние.
 *
 * Особенности интеграции:
 *  - Бинарь живёт в storage/tgwsproxy (там можно писать); в релизе он может
 *    лежать и в server/vendor/tgwsproxy — оттуда тоже подхватываем.
 *  - Запускаем с --portable: конфиг и логи остаются в storage/tgwsproxy/
 *    TgWsProxy_data, а не размазываются по %APPDATA% пользователя.
 *  - Конфиг (host/port/secret) пишем сами: без него движок берёт порт 1443 и
 *    случайный секрет на каждый старт, из-за чего настройки в Telegram Desktop
 *    ломались бы при каждом перезапуске.
 *  - Маркер .first_run_done_mtproto гасит окно первичной инструкции: запуск из
 *    нашего интерфейса не должен открывать чужое окно поверх приложения.
 *  - Готовность определяем подключением к host:port (бинарь собран PyInstaller,
 *    распаковка занимает секунды) — по логам это было бы медленнее и хрупче.
 *  - Стоп — kill дерева процессов: у трей-приложения нет CLI-команды выхода.
 *
 * TS-исходник, как server/ts/torrent.ts: компилируется в server/tgwsproxy.js
 * командой `npm run compile:server`, поэтому `require("../tgwsproxy")` из
 * server/routes/tgws.js работает без изменений.
 */
import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import config from "./config";
import logger from "./logger";
import settings from "./settings";
import { downloadToFile } from "./download";

const { DIRS } = config;

const REPO = "Flowseal/tg-ws-proxy";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Каталог скачанного движка (внутри storage — доступен на запись). */
const HOME = path.join(DIRS.storage, "tgwsproxy");
/** Файл с версией/именем ассета скачанного бинаря. */
const META_FILE = path.join(HOME, "install.json");
/** Куда наш таймаут на скачивание: 20 МБ с GitHub качаются быстро. */
const DL_TIMEOUT_MS = 10 * 60 * 1000;
/** Сколько ждать, пока прокси начнёт слушать порт (распаковка + старт). */
const READY_TIMEOUT_MS = 60_000;
/** Максимум строк лога, которые держим в памяти для UI. */
const LOG_LINES = 400;

/* ------------------------------- Типы ------------------------------- */

export interface TgwsStatus {
  /** Бинарь найден (скачан или вшит в сборку). */
  installed: boolean;
  exePath: string;
  /** Версия скачанного релиза (пусто для вшитого бинаря). */
  version: string;
  /** Прокси сейчас запущен нами. */
  running: boolean;
  pid: number;
  /** Процесс жив, но порт ещё не поднялся (PyInstaller распаковывается). */
  starting: boolean;
  host: string;
  port: number;
  /** Секрет прокси (без префикса dd) — его вводят в Telegram Desktop. */
  secret: string;
  /** Готовая ссылка tg://proxy… для авто-настройки Telegram. */
  link: string;
  /** port должен быть свободен: занят — чужой процесс или наш не убрался. */
  portBusy: boolean;
  uptimeMs: number;
  /** Поднимать прокси при старте приложения (настройка блока). */
  autoStart: boolean;
  /** Идёт скачивание движка: UI показывает прогресс. */
  downloading: boolean;
  /** Прогресс скачивания, 0..100. */
  progress: number;
  /** Последняя ошибка запуска/скачивания (для баннера в UI). */
  error: string;
  /** Последние строки лога движка (наш stdout + его proxy.log). */
  log: string[];
}

interface TgwsCfg {
  exePath: string;
  host: string;
  port: number;
  secret: string;
  autoStart: boolean;
}

interface InstallMeta {
  asset?: string;
  version?: string;
  installedAt?: string;
}

/* --------------------------- Состояние и лог --------------------------- */

let child: ChildProcess | null = null;
let startedAt = 0;
/** true — процесс поднят, но порт ещё не отвечает. */
let starting = false;
let lastError = "";
let downloading = false;
let progress = 0;
/** Кольцевой буфер лога: UI читает его, файл целиком тянуть не нужно. */
const logLines: string[] = [];

/**
 * Приложение закрывается — гасим движок: иначе он останется висеть в трее, а
 * его single-instance mutex не даст поднять прокси в следующий раз.
 * В 'exit' асинхронные операции уже невозможны, поэтому kill процесса, а не
 * taskkill-дерево: MTProto-прокси работает потоком внутри самого процесса,
 * поэтому гибель процесса гасит и прокси.
 *
 * Слушатель вешаем РОВНО один раз на процесс, а актуальное состояние берём из
 * globalThis: модуль перезагружается в тестах (require-кэш сбрасывается), и без
 * этого счётчик слушателей рос бы до MaxListenersExceededWarning.
 */
interface TgwsGlobal {
  stopHookRegistered?: boolean;
  stopCurrent?: () => void;
}
const G = globalThis as unknown as TgwsGlobal;
G.stopCurrent = () => {
  try {
    child?.kill();
  } catch {
    /* на выходе разбираться уже не с чем */
  }
};
if (!G.stopHookRegistered) {
  G.stopHookRegistered = true;
  process.on("exit", () => {
    try {
      G.stopCurrent?.();
    } catch {
      /* ignore */
    }
  });
}

function pushLog(line: string) {
  const text = String(line || "").replace(/\r$/, "");
  if (!text.trim()) return;
  logLines.push(text);
  if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES);
}

/** Каталог «портативного» режима: конфиг и логи движка живут здесь. */
function portableDir(exePath: string): string {
  return path.join(path.dirname(exePath), "TgWsProxy_data");
}

function cfgPath(exePath: string): string {
  return path.join(portableDir(exePath), "config.json");
}

/** Настройки применения, приведённые к безопасным значениям. */
function tgwsCfg(): TgwsCfg {
  let raw: Partial<TgwsCfg> = {};
  try {
    raw = (settings.get("tgws") || {}) as Partial<TgwsCfg>;
  } catch {
    /* настройки могут быть недоступны в тестах */
  }
  const port = Math.trunc(Number(raw.port));
  return {
    exePath: String(raw.exePath || "").trim(),
    host: String(raw.host || "").trim() || "127.0.0.1",
    // Диапазон 1024..65535: порты ниже заняты службами, выше — не существуют.
    port: Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : 1443,
    secret: String(raw.secret || "").trim(),
    autoStart: raw.autoStart === true,
  };
}

/** Сохранить секцию настроек (секрет генерируем один раз — см. ensureSecret). */
function saveCfg(patch: Partial<TgwsCfg>): TgwsCfg {
  try {
    // settings.set принимает ВСЁ дерево патчем (deep merge), а не (секция, патч):
    // поэтому передаём объект с секцией tgws.
    settings.set({ tgws: { ...(settings.get("tgws") || {}), ...patch } });
  } catch (e) {
    logger.warn("tgws.settings_save_failed", { error: (e as Error).message });
  }
  return tgwsCfg();
}

/**
 * Секрет прокси: 32 hex-символа (16 байт) — формат MTProto-прокси Telegram.
 * Храним у себя, а не отдаём движку случайный: иначе при каждом перезапуске он
 * генерировал бы новый, и в Telegram Desktop настройка переставала работать.
 */
function ensureSecret(cfg: TgwsCfg): string {
  if (/^[0-9a-f]{32}$/i.test(cfg.secret)) return cfg.secret;
  const secret = crypto.randomBytes(16).toString("hex");
  saveCfg({ secret });
  return secret;
}

/* ------------------------- Поиск и установка ------------------------- */

/** Имя ассета релиза под текущую архитектуру Windows. */
function assetName(): string {
  // ARM64-сборки есть только для Windows 10+; x64 — основной вариант.
  return process.arch === "arm64" ? "TgWsProxy_windows_arm64.exe" : "TgWsProxy_windows.exe";
}

/** Имя файла, под которым бинарь лежит у нас (для всех архитектур одно). */
const EXE_NAME = "TgWsProxy.exe";

/**
 * Кандидаты на движок, в порядке приоритета:
 *  1) путь из настроек (пользователь может указать свой бинарь);
 *  2) скачанный нами в storage/tgwsproxy;
 *  3) вшитый в сборку server/vendor/tgwsproxy (next to compiled tgwsproxy.js).
 */
function exeCandidates(cfg = tgwsCfg()): string[] {
  const list: string[] = [];
  if (cfg.exePath) list.push(cfg.exePath);
  list.push(path.join(HOME, EXE_NAME));
  list.push(config.vendorPath("tgwsproxy", EXE_NAME));
  list.push(config.vendorPath("tgwsproxy", assetName()));
  return list;
}

/** Найденный бинарь или null (без сети и запуска процессов). */
export function detectExe(): { path: string; bundled: boolean } | null {
  const cfg = tgwsCfg();
  const candidates = exeCandidates(cfg);
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        // Путь из настроек и скачанный нами — «свои», вшитый в сборку идёт
        // последним кандидатом: его версия может быть старше скачанной.
        return { path: p, bundled: i >= candidates.length - 2 };
      }
    } catch {
      /* недоступный путь — просто следующий кандидат */
    }
  }
  return null;
}

function readMeta(): InstallMeta {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8")) as InstallMeta;
  } catch {
    return {};
  }
}

function writeMeta(meta: InstallMeta): void {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    logger.warn("tgws.meta_write_failed", { error: (e as Error).message });
  }
}

/** Последний релиз движка: тег и ассет под нашу архитектуру. */
async function fetchRelease(): Promise<{
  version: string;
  url: string;
  size: number;
  sha256: string;
}> {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "MoonApp" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`github_http_${res.status}`);
  const rel = (await res.json()) as {
    tag_name?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string }[];
  };
  const want = assetName();
  const asset = (rel.assets || []).find((a) => a.name === want);
  if (!asset?.browser_download_url) throw new Error("release_asset_not_found");
  return {
    version: String(rel.tag_name || "").replace(/^v/, ""),
    url: asset.browser_download_url,
    size: Number(asset.size || 0),
    // GitHub отдаёт digest вида sha256:<hex> — если есть, сверяем хеш.
    sha256: String(asset.digest || "").replace(/^sha256:/i, ""),
  };
}
/** sha256 файла (для проверки скачанного бинаря). */
function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/**
 * Скачать движок с GitHub в storage/tgwsproxy. Возвращает путь к бинарю.
 * Прогресс доступен через status().progress — UI показывает его в блоке.
 */
export async function install(force = false): Promise<{ exePath: string; version: string }> {
  if (downloading) throw new Error("tgws_download_busy");
  const target = path.join(HOME, EXE_NAME);
  const current = detectExe();
  if (!force && current && !current.bundled) {
    return { exePath: current.path, version: readMeta().version || "" };
  }

  downloading = true;
  progress = 0;
  lastError = "";
  try {
    const rel = await fetchRelease();
    const tmp = `${target}.part`;
    const bytes = await downloadToFile(rel.url, tmp, {
      userAgent: "MoonApp",
      timeoutMs: DL_TIMEOUT_MS,
      httpErrorText: (status) => `github_http_${status}`,
      onProgress: (p) => {
        progress = p.total > 0 ? Math.round((p.received / p.total) * 100) : 0;
      },
    });
    if (rel.sha256) {
      const got = sha256File(tmp);
      if (got !== rel.sha256) {
        fs.rmSync(tmp, { force: true });
        throw new Error("download_hash_mismatch");
      }
    }
    // Подменяем файл целиком: движок — один exe, обновлять его «на месте»
    // нельзя (Windows не даст перезаписать запущенный файл, а частично
    // записанный бинарь выглядел бы как рабочий).
    fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
    writeMeta({ asset: assetName(), version: rel.version, installedAt: new Date().toISOString() });
    logger.action("tgws.installed", { version: rel.version, bytes });
    return { exePath: target, version: rel.version };
  } catch (e) {
    lastError = String((e as Error).message || e);
    logger.error("tgws.install_failed", { error: lastError });
    throw e;
  } finally {
    downloading = false;
  }
}

/* ------------------------ Конфиг и запуск движка ------------------------ */

/**
 * Подготовить конфиг движка в портативном каталоге.
 *
 * Ключи только те, что перечислены в его default_config (host/port/secret),
 * плюс флаги, которые нам важны: без проверки обновлений (мы сами качаем
 * движок кнопкой) и без «verbose». Остальное движок дополнит своими
 * значениями по умолчанию сам.
 */
function ensureEngineConfig(exePath: string, cfg: TgwsCfg, secret: string): string {
  const dir = portableDir(exePath);
  fs.mkdirSync(dir, { recursive: true });
  const file = cfgPath(exePath);
  const next = {
    host: cfg.host,
    port: cfg.port,
    secret,
    verbose: false,
    check_updates: false,
    appearance: "auto",
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  // Маркер гасит окно первичной инструкции: пользователь уже в нашем UI, а
  // чужое окно поверх приложения выглядит как ошибка. Подробную инструкцию
  // мы показываем сами (ссылка tg://proxy + поля host/port/secret).
  try {
    fs.writeFileSync(path.join(dir, ".first_run_done_mtproto"), "", "utf8");
  } catch {
    /* маркер — не критичен */
  }
  return file;
}

/** Свободен ли TCP-порт на host (true = можно слушать). */
export function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/** Порт уже слушает кто-то (наш прокси после старта или чужой процесс). */
function portOpen(host: string, port: number, timeout = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Ждать, пока прокси начнёт слушать порт (или процесс умрёт). */
async function waitReady(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!child) return false; // процесс завершился — ждать нечего
    if (await portOpen(host, port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Дописать в буфер лога содержимое proxy.log движка (хвост). */
function suckEngineLog(exePath: string) {
  try {
    const file = path.join(portableDir(exePath), "proxy.log");
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, "utf8");
    const tail = text.split(/\r?\n/).slice(-LOG_LINES);
    logLines.splice(0, logLines.length);
    for (const line of tail) pushLog(line);
  } catch {
    /* лог движка — необязательная роскошь */
  }
}

/**
 * Запустить прокси. Если бинаря нет — кидаем not_installed (UI предложит
 * скачать). Возвращает итоговый статус.
 */
export async function start(patchIn: Partial<TgwsCfg> = {}): Promise<TgwsStatus> {
  if (child) return await statusLive();
  lastError = "";
  // undefined-значения отбрасываем: маршрут передаёт все поля формы, часть —
  // пустыми, и без фильтра они затёрли бы уже сохранённые настройки.
  const patch = Object.fromEntries(
    Object.entries(patchIn).filter(([, v]) => v !== undefined),
  ) as Partial<TgwsCfg>;
  const cfg = Object.keys(patch).length ? saveCfg(patch) : tgwsCfg();
  const found = detectExe();
  if (!found) throw new Error("tgws_not_installed");

  // Порт занят — почти всегда прежний экземпляр прокси, который остался от
  // прошлого запуска (его поднял кто-то другой или наш процесс был убит).
  if (!(await portFree(cfg.host, cfg.port))) {
    lastError = "tgws_port_busy";
    throw new Error("tgws_port_busy");
  }

  const secret = ensureSecret(cfg);
  const cfgFile = ensureEngineConfig(found.path, cfg, secret);
  pushLog(`[ui] start ${found.path} (config: ${cfgFile})`);

  const proc = (() => {
    try {
      return spawn(found.path, ["--portable"], {
        cwd: path.dirname(found.path),
        windowsHide: false, // трей-приложение: окно гасим, иконку не прячем
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // На Windows spawn кидает синхронно, если файл не является исполняемым:
      // превращаем это в понятный код вместо «spawn UNKNOWN» в UI.
      lastError = `tgws_spawn_failed: ${(e as Error).message}`;
      pushLog(`[ui] ${lastError}`);
      logger.error("tgws.spawn_failed", { error: lastError });
      starting = false;
      throw new Error(lastError, { cause: e });
    }
  })();
  child = proc;
  startedAt = Date.now();
  starting = true;

  const onData = (buf: Buffer) => pushLog(buf.toString("utf8"));
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("error", (e) => {
    // spawn падает мгновенно (ENOENT/испорченный exe) — фиксируем понятно.
    lastError = `tgws_spawn_failed: ${e.message}`;
    pushLog(`[ui] ${lastError}`);
    logger.error("tgws.spawn_failed", { error: e.message });
    child = null;
    starting = false;
  });
  proc.on("exit", (code, signal) => {
    pushLog(`[ui] exit code=${code} signal=${signal || ""}`);
    if (child === proc) {
      child = null;
      starting = false;
    }
  });

  const ready = await waitReady(cfg.host, cfg.port, READY_TIMEOUT_MS);
  starting = false;
  if (!ready) {
    // Процесс мог остаться живым, но не поднял порт: гасим, чтобы не оставлять
    // в системе непонятный фоновый exe, и сообщаем код ошибки в UI.
    const st = status();
    const dead = !child;
    // Если spawn уже упал (ENOENT, испорченный exe), его сообщение точнее —
    // не затираем его общим «процесс завершился».
    if (!lastError) lastError = dead ? "tgws_exited" : "tgws_not_listening";
    pushLog(`[ui] ${lastError} (pid=${st.pid})`);
    logger.error("tgws.start_failed", { error: lastError, pid: st.pid });
    if (!dead) await stop();
    suckEngineLog(found.path);
    throw new Error(lastError);
  }

  suckEngineLog(found.path);
  logger.action("tgws.started", {
    pid: proc.pid,
    host: cfg.host,
    port: cfg.port,
    bundled: found.bundled,
  });
  return await statusLive();
}

/** Остановить прокси: трей-приложение не умеет выходить по команде — kill. */
export async function stop(): Promise<TgwsStatus> {
  const proc = child;
  if (!proc || !proc.pid) {
    child = null;
    starting = false;
    return await statusLive();
  }
  const pid = proc.pid;
  pushLog(`[ui] stop pid=${pid}`);
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    proc.once("exit", finish);
    try {
      // Дерево процессов: у PyInstaller-сборки может быть дочерний процесс,
      // и kill одного лишь родителя оставил бы прокси слушать порт.
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
      else proc.kill("SIGTERM");
    } catch (e) {
      logger.warn("tgws.kill_failed", { error: (e as Error).message });
    }
    setTimeout(finish, 5000);
  });
  child = null;
  starting = false;
  logger.action("tgws.stopped", { pid });
  return await statusLive();
}

/** Поднять прокси при старте приложения, если так просил пользователь. */
export async function autoStart(): Promise<void> {
  const cfg = tgwsCfg();
  if (!cfg.autoStart || child || !detectExe()) return;
  try {
    await start();
  } catch (e) {
    // Автозапуск не должен мешать старту приложения: сообщаем и живём дальше.
    logger.warn("tgws.autostart_failed", { error: (e as Error).message });
  }
}
/* ------------------------------- Статус ------------------------------- */

/** Ссылка для авто-настройки Telegram Desktop (префикс dd — MTProto-прокси). */
function tgLink(host: string, port: number, secret: string): string {
  if (!secret) return "";
  const server = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `tg://proxy?server=${server}&port=${port}&secret=dd${secret}`;
}

function baseStatus(): TgwsStatus {
  const cfg = tgwsCfg();
  const found = detectExe();
  const secret = /^[0-9a-f]{32}$/i.test(cfg.secret) ? cfg.secret.toLowerCase() : "";
  return {
    installed: !!found,
    exePath: found?.path || cfg.exePath,
    version: readMeta().version || "",
    running: !!child,
    pid: child?.pid || 0,
    starting,
    host: cfg.host,
    port: cfg.port,
    secret,
    link: tgLink(cfg.host, cfg.port, secret),
    portBusy: false, // заполняет statusLive: проверка порта требует сети
    uptimeMs: child && startedAt ? Date.now() - startedAt : 0,
    autoStart: cfg.autoStart,
    downloading,
    progress,
    error: lastError,
    log: [...logLines],
  };
}

/** Статус для UI: синхронные поля + реальная занятость порта. */
export async function statusLive(): Promise<TgwsStatus> {
  const st = baseStatus();
  st.portBusy = !(await portFree(st.host, st.port));
  return st;
}

/** Синхронный статус (без проверки порта) — для внутренних вызовов и тестов. */
export function status(): TgwsStatus {
  return baseStatus();
}

/**
 * Сохранить настройки блока без запуска движка.
 * Секрет: пусто — сбросить (сгенерируем новый при запуске), иначе только
 * 32 hex-символа, как требует MTProto-прокси Telegram.
 */
export async function configure(patch: Partial<TgwsCfg>): Promise<TgwsStatus> {
  const next: Partial<TgwsCfg> = {};
  if (typeof patch.host === "string") next.host = patch.host.trim() || "127.0.0.1";
  if (patch.port !== undefined) {
    const port = Math.trunc(Number(patch.port));
    if (!Number.isFinite(port) || port < 1024 || port > 65535) throw new Error("tgws_bad_port");
    next.port = port;
  }
  if (typeof patch.exePath === "string") next.exePath = patch.exePath.trim();
  if (typeof patch.autoStart === "boolean") next.autoStart = patch.autoStart;
  if (typeof patch.secret === "string") {
    const s = patch.secret.trim().replace(/^dd/i, "");
    if (!s) next.secret = "";
    else if (!/^[0-9a-f]{32}$/i.test(s)) throw new Error("tgws_bad_secret");
    else next.secret = s.toLowerCase();
  }
  saveCfg(next);
  logger.action("tgws.configured", { keys: Object.keys(next) });
  return await statusLive();
}

/** Сгенерировать новый секрет (кнопка «новый секрет» в UI). */
export async function rotateSecret(): Promise<TgwsStatus> {
  saveCfg({ secret: crypto.randomBytes(16).toString("hex") });
  return await statusLive();
}
