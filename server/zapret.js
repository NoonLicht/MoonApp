"use strict";

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

const fs = require("fs");
const path = require("path");
const { spawn, exec, execFileSync } = require("child_process");
const https = require("https");
const dgram = require("dgram");
const { DIRS } = require("./config");
const { stmts } = require("./db");
const settings = require("./settings");
const logger = require("./logger");
const { runElevated } = require("./elevate");

const SERVICE_NAME = "zapret";
const GAME_TCP_PORTS = "1024-65535";
const GAME_UDP_PORTS = "1024-65535";
/** Лог elevated-процесса winws (в консоль elevated-окна не заглянуть). */
const WINWS_LOG = path.join(DIRS.logs, "zapret_winws.log");
/** Общий лог консольных прогонов (проверка конфигов / диагностика service.bat). */
const CONSOLE_LOG = path.join(DIRS.logs, "zapret_console.log");

/* ------------------------- Каталог движка ------------------------- */

function cfg() { return settings.get("zapret"); }

/** Каталог установки движка (куда качаем релиз с GitHub). */
function installDir() {
  const c = cfg();
  if (c.dir && String(c.dir).trim()) return path.resolve(String(c.dir).trim());
  return DIRS.zapret;
}

/** winws.exe в релизе лежит в bin/ — поддерживаем оба варианта + вложенную папку. */
function probeEngineDir(p) {
  if (!p) return null;
  if (fs.existsSync(path.join(p, "bin", "winws.exe"))) return p;
  if (fs.existsSync(path.join(p, "winws.exe"))) return p;
  // Распакованный релиз лежит во вложенной папке (zapret-discord-youtube-<ver>/).
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(p, e.name, "bin", "winws.exe"))) return path.join(p, e.name);
    }
  } catch { /* нет доступа/нет папки */ }
  return null;
}

function findEngineDir() {
  const c = cfg();
  const candidates = [
    c.dir && String(c.dir).trim() && path.resolve(String(c.dir).trim()),
    process.env.PERSONAL_APP_ZAPRET && path.resolve(process.env.PERSONAL_APP_ZAPRET),
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
    ? (fs.existsSync(path.join(dir, "bin", "winws.exe")) ? path.join(dir, "bin", "winws.exe") : path.join(dir, "winws.exe"))
    : null;
  const info = localVersion();
  return {
    found: !!dir,
    dir,
    installDir: installDir(),
    winws,
    binDir: dir ? path.dirname(winws) : path.join(installDir(), "bin"),
    serviceBat: dir ? path.join(dir, "service.bat") : null,
    listsDir: dir ? path.join(dir, "lists") : null,
    version: info.tag || null,
    gameFilter: readGameFilter(),
  };
}

/* ------------------------- Пользовательские списки движка ------------------------- */

/** Дефолты пользовательских списков — копия service.bat (:load_user_lists). */
const USER_LIST_DEFAULTS = {
  "ipset-exclude-user.txt": "203.0.113.113/32",
  "list-general-user.txt": "# Never leave this file empty\ndomain.example.abc",
  "list-exclude-user.txt": "domain.example.abc",
};

/** Каталог lists/ (движок может быть ещё не развёрнут — тогда берём installDir). */
function listsDirPath(dir) {
  if (dir) return dir;
  const st = engineStatus();
  return st.listsDir || path.join(installDir(), "lists");
}

/**
 * Гарантировать существование пользовательских списков движка.
 *
 * Без них winws падает с "cannot access ipset file ... failed to register ipset":
 * конфиги general*.bat ссылаются на lists\ipset-exclude-user.txt и т.п., а создаёт
 * их только service.bat (:load_user_lists) — мы же запускаем winws напрямую.
 * Приоритет — вендорный `service.bat load_user_lists` (работает без UAC),
 * fallback — пишем те же дефолты сами.
 *
 * @param {string} [dir] каталог lists/ (для тестов)
 * @returns {string[]} имена созданных файлов
 */
function ensureUserLists(dir) {
  const target = listsDirPath(dir);
  const engine = findEngineDir();
  const vendorBat = engine ? path.join(engine, "service.bat") : null;
  if (vendorBat && fs.existsSync(vendorBat)) {
    try {
      execFileSync("cmd.exe", ["/c", vendorBat, "load_user_lists"], {
        cwd: engine, windowsHide: true, timeout: 20000,
      });
    } catch { /* нет движка / не отработал — добьём дефолтами ниже */ }
  }
  const created = [];
  for (const name of Object.keys(USER_LIST_DEFAULTS)) {
    try {
      const p = path.join(target, name);
      // Пустой ipset-файл winws тоже не принимает — пишем sentinel.
      const bad = !fs.existsSync(p) || (name.startsWith("ipset") && fs.statSync(p).size === 0);
      if (!bad) continue;
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(p, USER_LIST_DEFAULTS[name] + "\n", "utf8");
      created.push(name);
    } catch { /* нет доступа к каталогу */ }
  }
  if (created.length) logger.action("zapret.userLists.create", { files: created });
  return created;
}

/**
 * Файлы (.txt/.bin/.list/.dat), на которые ссылаются аргументы winws и которых нет.
 * Нужен, чтобы вместо "winws_not_started: <хвост лога>" показать, чего не хватает.
 *
 * @param {string[]} tokens аргументы winws (из .bat + кастомные)
 * @param {string} [dir] каталог lists/ (для тестов)
 */
function missingListFiles(tokens, dir) {
  const base = listsDirPath(dir);
  const missing = [];
  for (const t of tokens || []) {
    const m = /^--([a-z0-9-]+)=(.+)$/i.exec(String(t));
    if (!m) continue;
    const val = m[2].replace(/^"|"$/g, "").trim();
    if (!/\.(txt|bin|list|dat)$/i.test(val)) continue; // только файловые аргументы
    const p = path.isAbsolute(val) ? val : path.join(base, val);
    try { if (!fs.existsSync(p)) missing.push(path.basename(p)); } catch { missing.push(path.basename(p)); }
  }
  return [...new Set(missing)];
}

/* ------------------------- Стратегии (general*.bat) ------------------------- */

/** Группы конфигов Flowseal: base / alt / fake-tls-auto / simple-fake / exp. */
function strategyGroup(fileName) {
  const suffix = (fileName.match(/\(([^)]*)\)/) || [])[1];
  if (!suffix) return "base";
  const s = suffix.trim().toUpperCase();
  if (/^ALT/.test(s)) return "alt";
  if (/^FAKE TLS AUTO/.test(s)) return "fake-tls-auto";
  if (/^SIMPLE FAKE/.test(s)) return "simple-fake";
  return "exp";
}

/** Слаг-id конфига: general, alt, alt2..alt13, exp, fake-tls-auto… (стабильный). */
function strategyId(fileName) {
  const suffix = (fileName.match(/\(([^)]*)\)/) || [])[1];
  if (!suffix) return "general";
  return suffix.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Порядок для UI: general → ALT (по номеру) → FAKE TLS AUTO → SIMPLE FAKE → прочее. */
function strategySortKey(s) {
  const label = String(s.label || "");
  const m = /(\d+)/.exec(label);
  // Базовый вариант группы идёт первым, затем ALT, ALT2, ALT3…
  const rank = m ? parseInt(m[1], 10) : (/ALT/i.test(label) ? 1 : 0);
  const order = { base: 0, alt: 1, "fake-tls-auto": 2, "simple-fake": 3, exp: 4 };
  return (order[s.group] ?? 9) * 1000 + rank;
}

/** Все конфиги-стратегии (general*.bat) с готовыми аргументами winws. */
function listStrategies() {
  const st = engineStatus();
  if (!st.found) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(st.dir)) {
      if (!/\.bat$/i.test(f)) continue;
      if (!/^general.*\.bat$/i.test(f)) continue; // service.bat и utils игнорируем
      out.push({
        id: strategyId(f),
        name: f.replace(/\.bat$/i, ""),
        label: (f.match(/\(([^)]*)\)/) || [])[1] || "default",
        group: strategyGroup(f),
        file: f,
        filePath: path.join(st.dir, f),
        args: extractWinwsArgs(path.join(st.dir, f)),
        winwsCmd: `"${st.winws}" ${extractWinwsArgs(path.join(st.dir, f))}`,
      });
    }
  } catch { /* ignore */ }
  out.sort((a, b) => strategySortKey(a) - strategySortKey(b));
  out.forEach((s, i) => { s.index = i + 1; });
  return out;
}

/** Все .bat в каталоге движка (включая служебные) — для браузера конфигов. */
function listBatFiles() {
  const st = engineStatus();
  if (!st.found) return [];
  try {
    return fs.readdirSync(st.dir)
      .filter((f) => /\.bat$/i.test(f))
      .map((f) => ({
        name: f.replace(/\.bat$/i, ""),
        file: f,
        sizeKb: Math.round(fs.statSync(path.join(st.dir, f)).size / 102.4) / 10,
        kind: /^general/i.test(f) ? "strategy" : "service",
        args: /^general/i.test(f) ? extractWinwsArgs(path.join(st.dir, f)) : "",
      }));
  } catch { return []; }
}


/**
 * Разбор .bat-конфига Flowseal → { vars, tokens }.
 *
 * Конфиг выглядит так:
 *   set "BIN=%~dp0bin\"      set "LISTS=%~dp0lists\"
 *   start "zapret: %~n0" /min "%BIN%winws.exe" --wf-tcp=80,443,%GameFilterTCP% ^
 *     --filter-udp=443 --hostlist="%LISTS%list-general.txt" ...
 *
 * Возвращаем аргументы с абсолютными путями (готовы и для spawn, и для binPath
 * службы) + карту переменных для превью.
 */
function parseBatConfig(batPath) {
  const dir = path.dirname(batPath);
  const result = { vars: {}, tokens: [], raw: "" };
  let raw;
  try { raw = fs.readFileSync(batPath, "utf8").replace(/\r/g, ""); }
  catch { return result; }
  const joined = raw.replace(/\^\s*\n/g, " "); // склейка переносов bat
  result.raw = joined;

  const varRe = /^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"?\s*$/gim;
  let vm;
  while ((vm = varRe.exec(joined))) result.vars[vm[1].toUpperCase()] = vm[2];

  const line = joined.split("\n").find((l) => /winws(\.exe)?/i.test(l));
  if (!line) return result;
  const cut = line.search(/winws(\.exe)?/i);
  let argsPart = line.slice(cut).replace(/^winws(\.exe)?"?/i, "").trim();

  const gf = cfg();
  const gfTcp = gf.gameFilterTcp ? GAME_TCP_PORTS : "12";
  const gfUdp = gf.gameFilterUdp ? GAME_UDP_PORTS : "12";
  const builtin = {
    "%~DP0": dir + path.sep,
    BIN: dir + path.sep + "bin" + path.sep,
    LISTS: dir + path.sep + "lists" + path.sep,
    GAMEFILTERTCP: gfTcp,
    GAMEFILTERUDP: gfUdp,
    GAMEFILTER: gfTcp !== "12" || gfUdp !== "12" ? GAME_TCP_PORTS : "12",
  };
  const all = { ...result.vars, ...builtin };
  argsPart = argsPart.replace(/%~dp0/gi, () => builtin["%~DP0"]);
  argsPart = argsPart.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (mm, name) => {
    const v = all[String(name).toUpperCase()];
    if (v === undefined) return "";
    return String(v).replace(/%~dp0/gi, builtin["%~DP0"]).replace(/^"(.*)"$/, "$1");
  });
  argsPart = argsPart.replace(/%/g, "");

  const tokens = splitWinArgs(argsPart).map((t) => t.replace(/,+$/, "")); // хвостовые запятые от %GameFilter%
  result.tokens = tokens.filter((t) => t !== "");
  return result;
}

/** Windows-токенизация: кавычки группируют, сами кавычки в токен не попадают. */
function splitWinArgs(s) {
  const out = [];
  let cur = "";
  let inQ = false;
  let has = false;
  for (const ch of String(s || "")) {
    if (ch === '"') { inQ = !inQ; has = true; continue; }
    if (!inQ && /\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ""; has = false; }
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out.filter((t) => t && t !== "^");
}

/** Командная строка winws для превью/подстановки. */
function extractWinwsArgs(batPath) {
  return parseBatConfig(batPath).tokens.join(" ");
}

/** Токенизация произвольной строки аргументов (для кастомных args из UI). */
function tokenizeArgs(s) {
  return splitWinArgs(s);
}

/* ------------------------- GameFilter (utils/game_filter.enabled) ------------------------- */

/** Файл-флаг GameFilter: содержимое all | tcp | udp (см. service.bat). */
function gameFilterFile(dir) {
  const d = dir || findEngineDir() || installDir();
  return path.join(d, "utils", "game_filter.enabled");
}

function readGameFilter() {
  const c = cfg();
  if (c.gameFilterTcp && c.gameFilterUdp) return "all";
  if (c.gameFilterTcp) return "tcp";
  if (c.gameFilterUdp) return "udp";
  return "off";
}

/** Записать/удалить флаг GameFilter (движок читает его при старте). */
function writeGameFilter() {
  const mode = readGameFilter();
  const f = gameFilterFile();
  try {
    if (mode === "off") { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }
    else { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, mode, "utf8"); }
  } catch { /* движок может быть не установлен */ }
  return mode;
}

/* ------------------------- Загрузка/обновление с GitHub ------------------------- */

/**
 * Движок берём напрямую из релизов Flowseal/zapret-discord-youtube
 * (ассет *.zip распаковываем adm-zip'ом). Пользовательские списки
 * (lists/*-user.txt) и флаг GameFilter при обновлении сохраняются.
 */
const GITHUB_REPO = "Flowseal/zapret-discord-youtube";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;
const GITHUB_DL = `https://github.com/${GITHUB_REPO}/releases/download`;
const GH_HEADERS = { "User-Agent": "personal-app", Accept: "application/vnd.github+json" };
const VERSION_FILE = ".pa-bypass.json";

let installState = { state: "idle", progress: 0, phase: "", error: "", tag: null, at: 0 };
let releaseCache = null;

/** Установленная версия: .pa-bypass.json → LOCAL_VERSION в service.bat. */
function localVersion() {
  const dir = findEngineDir();
  if (!dir) return { tag: null, installedAt: null, dir: null };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, VERSION_FILE), "utf8"));
    if (j && j.tag) return { tag: String(j.tag), installedAt: j.installedAt || null, dir };
  } catch { /* нет файла — смотрим service.bat */ }
  try {
    const m = /set\s+"LOCAL_VERSION=([^"]+)"/i.exec(fs.readFileSync(path.join(dir, "service.bat"), "utf8"));
    if (m) return { tag: m[1].trim(), installedAt: null, dir };
  } catch { /* ignore */ }
  return { tag: null, installedAt: null, dir };
}

/** Последний релиз на GitHub (кэш 10 минут). */
async function fetchLatestRelease(force = false) {
  if (!force && releaseCache && Date.now() - releaseCache.at < 10 * 60 * 1000) return releaseCache;
  const res = await fetch(`${GITHUB_API}/releases/latest`, {
    headers: GH_HEADERS, redirect: "follow", signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`github_http_${res.status}`);
  const data = await res.json();
  const zip = (data.assets || []).find((a) => /\.zip$/i.test(a.name || ""));
  if (!zip) throw new Error("no_zip_asset");
  releaseCache = {
    tag: data.tag_name,
    name: data.name || data.tag_name,
    publishedAt: data.published_at,
    notes: String(data.body || "").slice(0, 2000),
    zipName: zip.name,
    zipUrl: zip.browser_download_url,
    sizeBytes: zip.size || 0,
    htmlUrl: data.html_url,
    at: Date.now(),
  };
  return releaseCache;
}

/** Проверка обновлений: что установлено vs что в последнем релизе. */
async function checkUpdate() {
  const local = localVersion();
  const out = {
    engine: engineStatus(),
    installed: local.tag,
    installedAt: local.installedAt,
    latest: null,
    hasUpdate: false,
    downloadUrl: null,
    assetName: null,
    sizeBytes: 0,
    publishedAt: null,
    htmlUrl: `https://github.com/${GITHUB_REPO}/releases`,
    notes: "",
    error: "",
    repo: GITHUB_REPO,
  };
  try {
    const rel = await fetchLatestRelease();
    out.latest = rel.tag;
    out.downloadUrl = rel.zipUrl;
    out.assetName = rel.zipName;
    out.sizeBytes = rel.sizeBytes;
    out.publishedAt = rel.publishedAt;
    out.notes = rel.notes;
    out.htmlUrl = rel.htmlUrl;
    out.hasUpdate = !local.tag || local.tag !== rel.tag;
  } catch (e) {
    out.error = String(e.message || e);
  }
  return out;
}

/** Прогресс установки/обновления для UI-поллинга. */
function installStatus() {
  return { ...installState, engine: engineStatus(), installed: localVersion().tag };
}

/** Рекурсивное копирование каталога (без зависимостей). */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else { try { fs.copyFileSync(from, to); } catch { /* занятый файл пропускаем */ } }
  }
}

/**
 * Скачать и установить/обновить движок с GitHub (асинхронно, с прогрессом).
 * Пользовательские списки и флаг GameFilter сохраняются.
 * @param {{ tag?: string, force?: boolean }} opts
 */
function installEngine(opts = {}) {
  if (installState.state === "working") return installState;
  installState = { state: "working", progress: 0, phase: "resolve", error: "", tag: opts.tag || null, at: Date.now() };
  const target = installDir();
  const tmpRoot = path.join(DIRS.tmp, `zapret_dl_${Date.now()}`);
  (async () => {
    try {
      // 1. Останавливаем движок: файлы релиза иначе залочены.
      //    killForeign=false — чужую копию zapret не трогаем (она в другой папке).
      installState.phase = "stop";
      try { await stop({ killForeign: false }); } catch { /* не запущен */ }

      // 2. Определяем релиз (или конкретный тег).
      installState.phase = "resolve";
      const rel = opts.tag
        ? { tag: opts.tag, zipName: `zapret-discord-youtube-${opts.tag}.zip`, zipUrl: `${GITHUB_DL}/${opts.tag}/zapret-discord-youtube-${opts.tag}.zip` }
        : await fetchLatestRelease(true);
      installState.tag = rel.tag;

      // 3. Скачиваем zip с прогрессом.
      installState.phase = "download";
      fs.mkdirSync(tmpRoot, { recursive: true });
      const zipPath = path.join(tmpRoot, rel.zipName || "release.zip");
      const res = await fetch(rel.zipUrl, {
        redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(300000),
      });
      if (!res.ok) throw new Error(`download_http_${res.status}`);
      const declared = Number(res.headers.get("content-length") || 0);
      let got = 0;
      const ws = fs.createWriteStream(zipPath);
      for await (const chunk of res.body) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        got += b.length;
        installState.progress = declared ? Math.min(100, Math.round((100 * got) / declared)) : 0;
        if (!ws.write(b)) await new Promise((r) => ws.once("drain", r));
      }
      await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));

      // 4. Распаковка (релиз лежит во вложенной папке zapret-discord-youtube-<ver>/).
      installState.phase = "extract";
      installState.progress = 0;
      const AdmZip = require("adm-zip");
      const raw = path.join(tmpRoot, "raw");
      new AdmZip(zipPath).extractAllTo(raw, true);
      const payload = probeEngineDir(raw) || raw;

      // 5. Сохраняем пользовательское: списки + флаг GameFilter.
      const keep = {};
      const oldEngine = findEngineDir();
      if (oldEngine) {
        for (const name of USER_LISTS) {
          try {
            const p = path.join(oldEngine, "lists", name);
            if (fs.existsSync(p)) keep[name] = fs.readFileSync(p, "utf8");
          } catch { /* ignore */ }
        }
        try {
          const gf = gameFilterFile(oldEngine);
          if (fs.existsSync(gf)) keep.__gameFilter = fs.readFileSync(gf, "utf8");
        } catch { /* ignore */ }
      }

      // 6. Заменяем каталог установки.
      installState.phase = "install";
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch { /* частично занят */ }
      fs.mkdirSync(target, { recursive: true });
      copyDir(payload, target);

      // 7. Возвращаем пользовательское + метка версии.
      for (const [name, content] of Object.entries(keep)) {
        if (name === "__gameFilter") continue;
        const p = path.join(target, "lists", name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
      }
      if (keep.__gameFilter) {
        const p = gameFilterFile(target);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, keep.__gameFilter, "utf8");
      } else {
        writeGameFilter();
      }
      // Пользовательские списки движка: их ждут конфиги general*.bat
      // (без них winws не стартует — "cannot access ipset file ...").
      try { ensureUserLists(); } catch { /* ignore */ }
      fs.writeFileSync(path.join(target, VERSION_FILE), JSON.stringify({
        tag: rel.tag, installedAt: new Date().toISOString(), source: GITHUB_REPO, asset: rel.zipName || "",
      }, null, 2), "utf8");

      installState = { state: "done", progress: 100, phase: "", error: "", tag: rel.tag, at: Date.now() };
      logger.action("zapret.install.done", { tag: rel.tag, dir: target });
    } catch (e) {
      installState = { state: "error", progress: 0, phase: "", error: String(e.message || e), tag: installState.tag, at: Date.now() };
      logger.error("zapret.install.error", { error: installState.error });
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }
    }
  })();
  return installState;
}

/* ------------------------- Запуск / остановка ------------------------- */

let child = null;         // текущий процесс winws (режим process)
let lastLog = [];         // хвост вывода winws
let activeProfile = null; // { strategyId, customArgs, mode }

function logLine(line) {
  lastLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (lastLog.length > 200) lastLog.splice(0, lastLog.length - 200);
}

/** Собрать аргументы winws для стратегии: токены .bat + кастомные args. */
function buildArgs(strategyId, customArgs) {
  const strat = listStrategies().find((s) => s.id === strategyId);
  const base = strat ? parseBatConfig(strat.filePath).tokens : [];
  const extra = tokenizeArgs(customArgs || "");
  return { strat, tokens: [...base, ...extra] };
}

/** Экранирование токена для cmd: пробелы → кавычки. */
function quoteForCmd(t) {
  return /\s/.test(t) ? `"${t.replace(/"/g, "")}"` : t;
}

/** Хвост лога winws (elevated-процесс пишет вывод в файл). */
function readWinwsLog(lines = 40) {
  try {
    const txt = fs.readFileSync(WINWS_LOG, "utf8").replace(/\r/g, "");
    return txt.split("\n").filter(Boolean).slice(-lines);
  } catch { return []; }
}

/** Пауза. */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Запуск winws.exe на постоянной основе (standalone-режим).
 *
 * winws.exe требует прав администратора (драйвер WinDivert), поэтому поднимаем
 * его одним elevated-скриптом: остановка прежнего процесса/службы + запуск
 * нового с записью вывода в storage/logs/zapret_winws.log (один UAC-запрос).
 */
async function startElevatedProcess(st, tokens, strategyId) {
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
    wait: false, timeoutMs: 120000, softTimeoutMs: 15000, workingDir: st.binDir,
  });
  if (!r.ok) throw new Error(r.error === "uac_cancelled" ? "uac_cancelled" : (r.error || "elevate_failed"));
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
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* занят */ }
    }
  } catch { /* ignore */ }
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
function decideWinwsStarted(input) {
  const procs = Array.isArray(input.procs) ? input.procs : [];
  const ours = procs.filter((p) => isOurWinws(p.path, input.engineDir));
  if (ours.length) {
    return { started: true, pid: ours[0].pid, killed: Math.max(0, procs.length - ours.length), reason: "path" };
  }
  if (input.logStarted) {
    return { started: true, pid: procs.length ? procs[0].pid : null, killed: 0, reason: "log" };
  }
  const unknown = procs.filter((p) => !p.path);
  if (unknown.length) {
    return { started: true, pid: unknown[0].pid, killed: Math.max(0, procs.length - unknown.length), reason: "elevated_path_unknown" };
  }
  return { started: false, pid: null, killed: 0, reason: "not_found" };
}

/** Опросить систему и решить, стартовал ли наш winws. */
async function detectRunningWinws(st) {
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
function buildBatLaunchScript(batPath, engineDir) {
  return [
    "@echo off",
    "chcp 65001 >nul",
    // У приложения своя кнопка «Проверить обновления», а vendor-проверка может
    // задержать старт winws на ~9 c сетевым запросом — отключаем её.
    "set \"NO_UPDATE_CHECK=1\"",
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
async function launchBatElevated(strat, st) {
  cleanOldRunScripts();
  const file = path.join(DIRS.tmp, `zapret_run_${Date.now()}.cmd`);
  fs.writeFileSync(file, buildBatLaunchScript(strat.filePath, st.dir), "utf8");
  logLine(`start (bat): ${path.basename(strat.filePath)}`);
  const r = await runElevated(file, [], {
    wait: false, timeoutMs: 120000, softTimeoutMs: 15000, workingDir: st.dir,
  });
  if (!r.ok) throw new Error(r.error === "uac_cancelled" ? "uac_cancelled" : (r.error || "elevate_failed"));
  // Всё лишнее уже погашено оболочкой, поэтому появившийся winws — наш.
  const det = await waitForWinws(25000);
  if (det.pid) return { pid: det.pid, pending: false };
  if (r.pending) return { pid: null, pending: true };
  throw new Error("winws_not_started");
}

async function start(opts = {}) {
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
  try { ensureUserLists(); } catch { /* движок может быть не развёрнут */ }
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
    else logLine(`winws pid ${res.pid}${res.killed > 0 ? ` (остановлено сторонних: ${res.killed})` : ""}`);
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
  logger.action("zapret.start", { strategyId, mode, customArgs: !!customArgs, tokens: tokens.length });
  return status();
}

/** Выполнить cmd-скрипт с правами администратора (один UAC-запрос). */
async function runElevatedScript(body, name, timeoutMs) {
  const file = path.join(DIRS.tmp, `${name}_${Date.now()}.cmd`);
  try {
    fs.writeFileSync(file, body, "utf8");
    return await runElevated(file, [], {
      timeoutMs: timeoutMs || 120000,
      workingDir: engineStatus().dir || DIRS.tmp,
    });
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

/** Токен в строку для binPath службы: пробелы → \"...\" (для sc create). */
function serviceArg(t) {
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
async function installService(strategyId, tokens) {
  const st = engineStatus();
  // Служба стартует winws напрямую — списки должны существовать до binPath.
  try { ensureUserLists(); } catch { /* ignore */ }
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
  return new Promise((resolve) => {
    exec("powershell -NoProfile -Command \"Get-Process winws -EA SilentlyContinue | ForEach-Object { ($_.Id.ToString() + '|' + $_.Path) }\"",
      { windowsHide: true, timeout: 15000 }, (err, out) => {
        if (err) return resolve([]);
        resolve(String(out || "").split(/\r?\n/)
          .map((l) => l.trim()).filter(Boolean)
          .map((l) => { const [pid, p] = l.split("|"); return { pid: parseInt(pid, 10), path: p || "" }; })
          .filter((x) => x.pid));
      });
  });
}

/** Является ли путь процесса нашим движком (а не чужой копией zapret). */
function isOurWinws(p, engineDir) {
  if (!engineDir || !p) return false;
  try {
    return path.resolve(p).toLowerCase().startsWith(path.resolve(engineDir).toLowerCase());
  } catch { return false; }
}

/**
 * Остановка DPI-обхода.
 * @param {{ killForeign?: boolean }} opts killForeign=true убивает любой winws
 * (нужно перед стартом: два winws конфликтуют за WinDivert-драйвер).
 */
async function stop(opts = {}) {
  const killForeign = opts.killForeign !== false;
  const engineDir = findEngineDir();
  let stopped = false;
  if (child && !child.killed) {
    try { child.kill(); } catch { /* ignore */ }
    stopped = true;
  }
  child = null;
  // winws запущен elevated — обычный taskkill может не сработать (Access denied).
  try {
    const procs = await listWinwsProcesses();
    const targets = procs.filter((p) => (killForeign ? true : isOurWinws(p.path, engineDir)));
    for (const p of targets) {
      await new Promise((r) => exec(`taskkill /PID ${p.pid} /F`, { windowsHide: true }, () => r()));
    }
    if (targets.length) stopped = true;
    if (targets.length) {
      await sleep(700);
      const left = await listWinwsProcesses();
      if (left.length) {
        // Первый заход не удался (elevated-процесс) — повторяем с UAC.
        await runElevatedScript(
          ["@echo off", "taskkill /IM winws.exe /F >nul 2>&1", "echo OK"].join("\r\n"),
          "zapret_kill", 60000
        );
      }
    }
  } catch { /* ignore */ }
  // Если работает служба — глушим её (UAC).
  try {
    const svc = await queryService();
    if (svc.installed && svc.running) {
      const r = await runElevatedScript(
        ["@echo off", `net stop ${SERVICE_NAME} >nul 2>&1`, "echo STOPPED"].join("\r\n"),
        "zapret_service_stop", 90000
      );
      stopped = stopped || r.ok;
    }
  } catch { /* ignore */ }
  if (stopped) logger.action("zapret.stop", {});
  return status();
}

function setDefaultProfile(strategyId, customArgs, mode, batchFilePath) {
  try {
    stmts.bpClearActive.run();
    stmts.bpInsert.run(`auto: ${strategyId} (${mode})`, batchFilePath || "", customArgs || "", 1, mode === "service");
  } catch { /* некритично */ }
}

/** Состояние службы zapret + активная стратегия из реестра (без UAC). */
function queryService() {
  return new Promise((resolve) => {
    exec(`sc query ${SERVICE_NAME}`, { windowsHide: true }, (err, stdout) => {
      const installed = !err && /STATE/.test(stdout || "");
      const running = installed && /RUNNING/.test(stdout || "");
      exec(`reg query "HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}" /v zapret-discord-youtube`,
        { windowsHide: true }, (e2, out2) => {
          const m = /zapret-discord-youtube\s+REG_SZ\s+(.+)/i.exec(out2 || "");
          resolve({
            installed,
            running,
            strategyFile: m ? m[1].trim() : "",
            raw: (stdout || "").trim().slice(-200),
          });
        });
    });
  });
}

async function status() {
  const svc = await queryService();
  let winwsRunning = false, winwsPid = null, memKb = null;
  try {
    const out = await new Promise((res) => exec('tasklist /FI "IMAGENAME eq winws.exe" /FO CSV /NH', { windowsHide: true }, (e, o) => res(o || "")));
    const m = out.match(/"winws\.exe","(\d+)"/i);
    if (m) { winwsRunning = true; winwsPid = parseInt(m[1], 10); }
    const memM = out.match(/"([\d\s,.]+)\s+K"/i);
    if (memM) memKb = parseInt(memM[1].replace(/[^\d]/g, ""), 10);
  } catch { /* ignore */ }
  return {
    active: winwsRunning || svc.running,
    process: { running: winwsRunning, pid: winwsPid, memKb },
    service: svc,
    mode: child ? "process" : (svc.running ? "service" : (cfg().mode || "process")),
    profile: activeProfile,
    log: (activeProfile?.mode === "process" ? readWinwsLog(40) : lastLog.slice(-40)),
    engine: engineStatus(),
    strategy: activeProfile?.strategyId || (svc.strategyFile ? strategyId(svc.strategyFile) : null),
    version: localVersion().tag,
    gameFilter: readGameFilter(),
  };
}

async function serviceAction(action) {
  const st = engineStatus();
  if (action === "status") return { ok: true, ...(await queryService()) };
  if (!st.found) throw new Error("engine_not_found");
  if (action === "install") {
    // Без выбранной стратегии ставим дефолтную (general).
    const tokens = buildArgs(cfg().defaultStrategy || "general", "").tokens;
    await installService(cfg().defaultStrategy || "general", tokens);
  } else if (action === "remove") {
    await removeService();
  } else {
    throw new Error("unknown_service_action");
  }
  logger.action("zapret.service", { action });
  return { ok: true, ...(await queryService()) };
}


/* ------------------------- Диагностика доступности ------------------------- */

const DEFAULT_TARGETS = [
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/generate_204", kind: "http" },
  { id: "googlevideo", name: "googlevideo (CDN)", url: "https://www.youtube.com", kind: "http" },
  { id: "discord-api", name: "Discord API", url: "https://discord.com/api/v9/gateway", kind: "http" },
  { id: "discord-gw", name: "Discord Gateway (WSS)", url: "https://gateway.discord.gg/?v=9&encver=1", kind: "http" },
  { id: "discord-voice", name: "Discord Voice (UDP/STUN)", kind: "udp" },
];

function parseCustomTargets() {
  const c = cfg();
  return String(c.customTargets || "")
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .map((url, i) => ({ id: `custom${i}`, name: url, url, kind: "http", custom: true }));
}

function targets() { return [...DEFAULT_TARGETS, ...parseCustomTargets()]; }

/** HTTP-проба с таймингом. ok = 2xx..4xx (жёсткая блокировка даёт RST/timeout). */
function httpProbe(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      const req = https.get(url, { timeout: timeoutMs, rejectUnauthorized: false, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode, latencyMs: Date.now() - t0, error: null });
      });
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: null, latencyMs: Date.now() - t0, error: "timeout" }); });
      req.on("error", (e) => resolve({ ok: false, status: null, latencyMs: Date.now() - t0, error: e.code || e.message }));
    } catch (e) {
      resolve({ ok: false, status: null, latencyMs: Date.now() - t0, error: e.message });
    }
  });
}

/** UDP/STUN-проба (голос Discord): STUN Binding Request на публичный STUN. */
function udpProbe(host = "stun.l.google.com", port = 19302, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = dgram.createSocket("udp4");
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0); msg.writeUInt16BE(0, 2);   // Binding Request
    msg.writeUInt32BE(0x2112a442, 4);                        // magic cookie
    for (let i = 8; i < 20; i++) msg[i] = Math.floor(Math.random() * 256);
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { sock.close(); } catch { /* ignore */ } resolve(r); } };
    sock.on("message", () => finish({ ok: true, latencyMs: Date.now() - t0, error: null }));
    sock.on("error", (e) => finish({ ok: false, latencyMs: Date.now() - t0, error: e.code || e.message }));
    sock.send(msg, port, host, (e) => { if (e) finish({ ok: false, latencyMs: Date.now() - t0, error: e.code || e.message }); });
    setTimeout(() => finish({ ok: false, latencyMs: Date.now() - t0, error: "timeout" }), timeoutMs);
  });
}

/** Прогнать всю матрицу проверок. */
async function runDiagnostics() {
  const results = [];
  for (const t of targets()) {
    const r = t.kind === "udp" ? await udpProbe() : await httpProbe(t.url);
    results.push({ ...t, ...r, packetDrop: !r.ok });
  }
  const okCount = results.filter((r) => r.ok).length;
  const oks = results.filter((r) => r.ok);
  const avgLatency = Math.round(oks.reduce((a, r) => a + r.latencyMs, 0) / Math.max(1, oks.length));
  return { allOk: results.length > 0 && okCount === results.length, okCount, total: results.length, avgLatency, results, at: Date.now() };
}


/* ------------------------- Auto-Tuner (1-click) ------------------------- */

let tuning = false;

/**
 * Прогнать стратегии по очереди: старт → диагностика → стоп.
 * Возвращает ранжированный результат; лучшую может применить сама (autoApplyBest).
 */
async function autoTune(opts = {}) {
  if (tuning) throw new Error("tuning_already_running");
  if (!engineStatus().found) throw new Error("engine_not_found");
  tuning = true;
  const apply = opts.apply !== undefined ? !!opts.apply : !!cfg().autoApplyBest;
  const previous = activeProfile ? { ...activeProfile } : null;
  try {
    const tried = [];
    for (const s of listStrategies()) {
      try {
        await start({ strategyId: s.id, mode: "process", customArgs: "" });
        await sleep(2500); // даём winws и WinDivert подняться
        const diag = await runDiagnostics();
        const score = diag.allOk ? 0 : (diag.okCount * -10) + (diag.avgLatency / 100);
        tried.push({ strategyId: s.id, allOk: diag.allOk, okCount: diag.okCount, total: diag.total, avgLatency: diag.avgLatency, score });
      } catch (e) {
        tried.push({ strategyId: s.id, allOk: false, error: String(e.message || e) });
      }
    }
    const ranked = tried.filter((t) => !t.error).sort((a, b) => (b.allOk - a.allOk) || (a.score - b.score));
    const best = ranked[0] || null;
    let applied = null;
    if (best && apply) {
      await start({ strategyId: best.strategyId, mode: "process", customArgs: "" });
      applied = best.strategyId;
    } else if (previous) {
      try { await start(previous); } catch { /* вернуть прежний профиль не вышло — не критично */ }
    } else {
      await stop();
    }
    logger.action("zapret.autoTune", { tried: tried.length, best: best?.strategyId || null, applied });
    return { tried, best: best?.strategyId || null, applied };
  } finally {
    tuning = false;
  }
}

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
const consoleState = {
  mode: null,       // null | "check" | "diag" | "lists"
  label: "",
  running: false,
  startedAt: 0,
  finishedAt: 0,
  exitCode: null,
  error: "",
  log: [],
  cursor: 0,        // сколько байт CONSOLE_LOG уже прочитано
  best: null,
  bestId: null,     // id конфига, который vendor-скрипт назвал лучшим
  results: [],
  progress: { done: 0, total: 0, current: null },
};

/** Сбросить консоль под новый прогон. */
function consoleReset(mode, label) {
  Object.assign(consoleState, {
    mode, label, running: true, startedAt: Date.now(), finishedAt: 0,
    exitCode: null, error: "", log: [], cursor: 0, best: null, bestId: null, results: [],
    progress: { done: 0, total: mode === "check" ? listStrategies().length : 0, current: null },
  });
  try { fs.writeFileSync(CONSOLE_LOG, "", "utf8"); } catch { /* ignore */ }
}

function consolePush(line) {
  consoleState.log.push(line);
  if (consoleState.log.length > CONSOLE_MAX_LINES) {
    consoleState.log.splice(0, consoleState.log.length - CONSOLE_MAX_LINES);
  }
}

/** Дописать строки в лог напрямую (когда пишем не через cmd) и сразу отдать в буфер. */
function consoleWriteDirect(lines, persist) {
  try {
    fs.appendFileSync(CONSOLE_LOG, (lines || []).map((l) => `${l}\r\n`).join(""), "utf8");
  } catch { /* ignore */ }
  consoleDrain(persist !== false);
}

// Маркеры vendor-скрипта utils/test zapret.ps1.
const CHECK_CFG_RE = /^\s*\[(\d+)\/(\d+)\]\s+(.+?\.bat)\s*$/;
const CHECK_FAILED_RE = /Strategy failed to start/i;
const CHECK_ANALYTICS_RE = /^\s*(.+?\.bat)\s*:\s*HTTP OK:\s*(\d+),\s*ERR:\s*(\d+),\s*UNSUP:\s*(\d+),\s*Ping OK:\s*(\d+),\s*Fail:\s*(\d+)/;
const CHECK_BEST_RE = /^\s*Best (?:config|strategy):\s*(.+?)\s*$/i;

/**
 * Огонёк конфига. Зелёный = конфиг рабочий: стартовал, и ни один HTTP/TLS-тест не упал
 * (error === 0, есть хотя бы один успешный тест). UNSUP — «метод не поддержан целью»,
 * это не ошибка; таймауты ICMP тоже игнорируем: пинг часто режет firewall, а для обхода
 * важны HTTP/TLS. Всё остальное — красный.
 */
function lightOk(r) {
  return !!r && !r.failedToStart && (r.error || 0) === 0 && (r.okCount || 0) > 0;
}

/**
 * Итоговый цвет плитки после полной проверки: рабочий конфиг ИЛИ лучший по версии
 * vendor-скрипта («Best config: …») — его страница тоже подсвечивает зелёным.
 */
function lightGreen(r, bestId) {
  if (!r || r.failedToStart || (r.okCount || 0) <= 0) return false;
  if ((r.error || 0) === 0) return true;
  return !!bestId && r.strategyId === bestId;
}

/** Докрасить огоньки после прогона (лучший конфиг тоже зелёный) и сохранить в БД. */
function finalizeLights() {
  const bestId = consoleState.bestId;
  try {
    for (const row of stmts.bcrAll.all()) {
      const green = lightGreen({
        strategyId: row.strategy_id, okCount: row.ok_count, error: row.error, unsup: row.unsup,
      }, bestId);
      if (green !== (Number(row.ok) === 1)) stmts.bcrSetOk.run(green ? 1 : 0, row.id);
    }
  } catch { /* БД недоступна — не критично */ }
}

/** Результат конфига по имени .bat-файла (id совпадает с id стратегии в UI). */
function resultFor(file) {
  const sid = strategyId(file);
  let r = consoleState.results.find((x) => x.strategyId === sid);
  if (!r) {
    r = {
      strategyId: sid, file, okCount: 0, error: 0, unsup: 0,
      pingOk: 0, pingFail: 0, finished: false, failedToStart: false,
    };
    consoleState.results.push(r);
  }
  return r;
}

/** Сохранить огонёк конфига в БД (живёт до следующей полной проверки). */
function saveLight(r, persist) {
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
      run_started_at: consoleState.startedAt ? new Date(consoleState.startedAt).toISOString() : null,
    });
  } catch { /* БД недоступна — не критично */ }
}

/** Разбор одной строки вывода vendor-скрипта. */
function parseCheckLine(line, persist) {
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
    consoleState.progress.done = consoleState.results.filter((x) => x.finished).length;
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
    consoleState.progress.done = consoleState.results.filter((x) => x.finished).length;
    saveLight(r, persist);
    return;
  }
  m = CHECK_BEST_RE.exec(line);
  if (m) setBest(m[1]);
}

/** Запомнить конфиг, который vendor-скрипт назвал лучшим (файл .bat + id плитки). */
function setBest(file) {
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
    const text = buf.toString("utf8")
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI-цвета (в файл обычно не попадают)
      .replace(/\r/g, "");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (!line) continue;
      consolePush(line);
      if (consoleState.mode === "check") parseCheckLine(line, persist);
    }
  } catch { /* лога ещё нет */ }
}

/** Финальный разбор файла результатов vendor-скрипта (utils/test results/*.txt). */
function parseCheckResultsFile(dir) {
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
  } catch { return 0; }
  if (!newest) return 0;
  let n = 0;
  try {
    const lines = fs.readFileSync(newest.p, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const m = /^\s*(.+?\.bat)\s*:\s*HTTP OK:\s*(\d+),\s*ERR:\s*(\d+),\s*UNSUP:\s*(\d+),\s*Ping OK:\s*(\d+),\s*Fail:\s*(\d+)\s*$/.exec(line);
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
  } catch { /* ignore */ }
  return n;
}

/**
 * Прогнать строки вывода через парсер огоньков (используется стримингом и тестами).
 * @param {string[]} lines строки вывода
 * @param {{ persist?: boolean }} [opts] persist=false — не писать в БД (тесты)
 */
function parseCheckOutput(lines, opts = {}) {
  consoleState.mode = "check";
  consoleState.results = [];
  consoleState.best = null;
  consoleState.bestId = null;
  consoleState.progress = { done: 0, total: 0, current: null };
  for (const l of lines || []) parseCheckLine(String(l), opts.persist !== false);
  return checkStatus();
}

/** Завершение любого консольного прогона (общий хвост для check/diag). */
function finishRun(r, mode) {
  consoleDrain(mode === "check");
  if (mode === "check") { try { parseCheckResultsFile(); } catch { /* ignore */ } finalizeLights(); }
  consoleState.running = false;
  consoleState.finishedAt = Date.now();
  consoleState.exitCode = r && Number.isFinite(r.exitCode) ? r.exitCode : null;
  if (r && r.error === "uac_cancelled") consoleState.error = "uac_cancelled";
  else if (mode === "check") {
    // Остановку пользователем не перетираем, а прогон без результатов — это ошибка.
    const kept = consoleState.error === "stopped_by_user" ? "stopped_by_user" : "";
    consoleState.error = consoleState.results.length
      ? kept
      : (r && r.error ? String(r.error) : "no_results");
  } else if (r && r.error && !consoleState.error) consoleState.error = String(r.error);
  if (mode === "check") {
    consoleState.progress.done = consoleState.results.filter((x) => x.finished).length;
  }
  logger.action("zapret.console.done", {
    mode, exitCode: consoleState.exitCode, error: consoleState.error, results: consoleState.results.length,
  });
}

/** Запустить elevated-скрипт (один UAC) с выводом в CONSOLE_LOG. */
function runConsoleScript(body, mode, opts = {}) {
  const file = path.join(DIRS.tmp, `zapret_${mode}_${Date.now()}.cmd`);
  fs.writeFileSync(file, body, "utf8");
  runElevated(file, [], {
    wait: true,
    timeoutMs: opts.timeoutMs || 20 * 60 * 1000,
    workingDir: opts.workingDir || DIRS.tmp,
  }).then((r) => finishRun(r, mode)).catch((e) => finishRun({ ok: false, error: String(e.message || e) }, mode));
}

/**
 * Проверка всех конфигов «как пункт 12 service.bat», но неинтерактивно и быстро:
 * стандартные тесты по utils/targets.txt для всех general*.bat.
 *
 * @param {{ fast?: boolean, timeoutSec?: number, parallel?: number }} [opts]
 */
async function startConfigCheck(opts = {}) {
  if (consoleState.running) return checkStatus();
  const st = engineStatus();
  if (!st.found) throw new Error("engine_not_found");
  // vendor-скрипт отказывается работать при установленной службе zapret.
  const svc = await queryService();
  if (svc.installed) throw new Error("service_installed");
  const script = path.join(st.dir, "utils", "test zapret.ps1");
  if (!fs.existsSync(script)) throw new Error("check_script_not_found");
  try { ensureUserLists(); } catch { /* ignore */ }

  const fast = opts.fast !== false;
  // Ответы vendor-скрипту: 1 = standard tests (HTTP/ping), 1 = все конфиги.
  const answersFile = path.join(DIRS.tmp, "zapret_check_answers.txt");
  fs.writeFileSync(answersFile, "1\r\n1\r\n", "utf8");
  consoleReset("check", path.join("utils", "test zapret.ps1"));
  try { stmts.bcrClear.run(); } catch { /* ignore */ } // старые огоньки гасим до новой проверки
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${st.dir}"`,
    ...(fast ? [`set "TEST_CURL_TIMEOUT=${opts.timeoutSec || 2}"`, `set "TEST_MAX_PARALLEL=${opts.parallel || 16}"`] : []),
    "set \"NO_UPDATE_CHECK=1\"",
    `echo [PA] ${fast ? "fast" : "full"} check: all configs, standard tests`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" < "${answersFile}" >> "${CONSOLE_LOG}" 2>&1`,
    "echo [PA] powershell exit %ERRORLEVEL%",
  ].join("\r\n");
  logger.action("zapret.check.start", { fast, configs: listStrategies().length });
  runConsoleScript(body, "check", { workingDir: st.dir });
  return checkStatus();
}

/** Остановить проверку: гасим vendor-PowerShell и winws, поднятый проверкой. */
async function stopConfigCheck() {
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
  } catch { /* ignore */ }
  consoleDrain(false);
  logger.action("zapret.check.stop", {});
  return checkStatus();
}

/** Пункт 11 service.bat — «Run Diagnostics» (BFE, системный прокси, TCP timestamps). */
async function runServiceDiagnostics() {
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
async function fixUserLists() {
  if (consoleState.running) throw new Error("busy");
  const st = engineStatus();
  if (!st.found) throw new Error("engine_not_found");
  consoleReset("lists", "service.bat → Load User Lists");
  const bat = path.join(st.dir, "service.bat");
  const lines = [`[PA] user lists → ${st.listsDir || ""}`];
  if (fs.existsSync(bat)) {
    const out = await new Promise((resolve) => {
      exec(`cmd /c ""${bat}" load_user_lists"`, { cwd: st.dir, windowsHide: true, timeout: 30000 },
        (e, o, er) => resolve({ e, o, er }));
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
    try { size = fs.statSync(path.join(listsDir, name)).size; } catch { /* нет файла */ }
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
function checkStatus() {
  if (consoleState.running) consoleDrain(true);
  const lights = {};
  try { for (const row of stmts.bcrAll.all()) lights[row.strategy_id] = row; } catch { /* ignore */ }
  const state = consoleState.running ? "working"
    : (!consoleState.mode ? "idle" : (consoleState.error ? "error" : "done"));
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
    results: consoleState.results.map((r) => ({ ...r })),
    log: consoleState.log.slice(-250),
    logCursor: consoleState.cursor,
    lights,
  };
}

/* ------------------------- Списки доменов (lists/) ------------------------- */

const USER_LISTS = ["list-general-user.txt", "list-exclude-user.txt", "ipset-exclude-user.txt"];

function listFilePath(name) {
  if (!USER_LISTS.includes(name)) throw new Error("unknown_list");
  const st = engineStatus();
  const dir = st.listsDir || path.join(installDir(), "lists");
  return path.join(dir, name);
}

function readList(name) {
  try { return fs.readFileSync(listFilePath(name), "utf8"); }
  catch { return ""; }
}

function writeList(name, content) {
  const p = listFilePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content || "").replace(/\r\n/g, "\n"), "utf8");
  logger.action("zapret.list.write", { name, size: String(content || "").length });
  return true;
}

/** Синхронизация пользовательских доменов из БД → list-*-user.txt. */
function syncCustomDomains() {
  const rows = stmts.bcdAll.all().filter((r) => r.is_enabled);
  for (const name of ["list-general-user.txt", "list-exclude-user.txt"]) {
    const type = name.startsWith("list-general") ? "include" : "exclude";
    const domains = rows.filter((r) => r.type === type).map((r) => r.domain);
    if (!domains.length) continue;
    const existing = readList(name).split("\n").map((s) => s.trim()).filter(Boolean);
    writeList(name, [...new Set([...existing, ...domains])].join("\n") + "\n");
  }
  return stmts.bcdAll.all();
}

/** Список .bin fake-payload (bin/). */
function listPayloads() {
  const st = engineStatus();
  if (!st.binDir) return [];
  try {
    return fs.readdirSync(st.binDir).filter((f) => /\.bin$/i.test(f)).map((f) => ({
      name: f,
      path: path.join(st.binDir, f),
      sizeKb: Math.round(fs.statSync(path.join(st.binDir, f)).size / 102.4) / 10,
    }));
  } catch { return []; }
}


/* ------------------------- Очистка (Discord cache / DNS) ------------------------- */

function clearDiscordCache() {
  const appdata = process.env.APPDATA || "";
  const variants = ["discord", "discordcanary", "discordptb", "discorddevelopment"];
  let freed = 0;
  for (const v of variants) {
    for (const sub of ["Cache", "Code Cache", "GPUCache", "DawnCache"]) {
      const p = path.join(appdata, v, sub);
      try {
        if (fs.existsSync(p)) { freed += dirSize(p); fs.rmSync(p, { recursive: true, force: true }); }
      } catch { /* ignore */ }
    }
  }
  logger.action("zapret.cache.clear", { freedKb: freed });
  return { freedKb: freed };
}

function dirSize(p) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, f.name);
      if (f.isDirectory()) total += dirSize(fp);
      else { try { total += Math.ceil(fs.statSync(fp).size / 1024); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  return total;
}

async function flushDns() {
  const r = await runElevated("ipconfig.exe", ["/flushdns"], { timeoutMs: 30000 });
  return { ok: r.ok, error: r.error };
}

module.exports = {
  engineStatus, listStrategies, listBatFiles, extractWinwsArgs, tokenizeArgs, parseBatConfig,
  start, stop, status, serviceAction,
  targets, runDiagnostics, autoTune,
  USER_LISTS, readList, writeList, syncCustomDomains, listPayloads,
  clearDiscordCache, flushDns,
  // Пользовательские списки + проверка конфигов/консоль
  USER_LIST_DEFAULTS, ensureUserLists, missingListFiles, strategyId, lightOk, lightGreen, finalizeLights,
  decideWinwsStarted, detectRunningWinws, buildBatLaunchScript, waitForWinws,
  startConfigCheck, stopConfigCheck, checkStatus, parseCheckOutput,
  runServiceDiagnostics, fixUserLists,
  // GitHub install/update + GameFilter
  GITHUB_REPO, checkUpdate, installEngine, installStatus, localVersion, installDir,
  readGameFilter, writeGameFilter, strategyGroup,
};

