/**
 * Выделено из zapret.ts при разбиении крупного файла (поведение не менялось).
 */
import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import logger from "./logger";
import {
  GAME_TCP_PORTS,
  GAME_UDP_PORTS,
  cfg,
  engineStatus,
  findEngineDir,
  installDir,
} from "./zapret";

/* ------------------------- Пользовательские списки движка ------------------------- */

/** Дефолты пользовательских списков — копия service.bat (:load_user_lists). */
export const USER_LIST_DEFAULTS: Record<string, string> = {
  "ipset-exclude-user.txt": "203.0.113.113/32",
  "list-general-user.txt": "# Never leave this file empty\ndomain.example.abc",
  "list-exclude-user.txt": "domain.example.abc",
};

/** Каталог lists/ (движок может быть ещё не развёрнут — тогда берём installDir). */
function listsDirPath(dir: any) {
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
export function ensureUserLists(dir?: any) {
  const target = listsDirPath(dir);
  const engine = findEngineDir();
  const vendorBat = engine ? path.join(engine, "service.bat") : null;
  if (vendorBat && fs.existsSync(vendorBat)) {
    try {
      execFileSync("cmd.exe", ["/c", vendorBat, "load_user_lists"], {
        cwd: engine,
        windowsHide: true,
        timeout: 20000,
      });
    } catch {
      /* нет движка / не отработал — добьём дефолтами ниже */
    }
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
    } catch {
      /* нет доступа к каталогу */
    }
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
export function missingListFiles(tokens: any, dir?: any) {
  const base = listsDirPath(dir);
  const missing = [];
  for (const t of tokens || []) {
    const m = /^--([a-z0-9-]+)=(.+)$/i.exec(String(t));
    if (!m) continue;
    const val = m[2].replace(/^"|"$/g, "").trim();
    if (!/\.(txt|bin|list|dat)$/i.test(val)) continue; // только файловые аргументы
    const p = path.isAbsolute(val) ? val : path.join(base, val);
    try {
      if (!fs.existsSync(p)) missing.push(path.basename(p));
    } catch {
      missing.push(path.basename(p));
    }
  }
  return [...new Set(missing)];
}

/* ------------------------- Стратегии (general*.bat) ------------------------- */

/** Группы конфигов Flowseal: base / alt / fake-tls-auto / simple-fake / exp. */
export function strategyGroup(fileName: any) {
  const suffix = (fileName.match(/\(([^)]*)\)/) || [])[1];
  if (!suffix) return "base";
  const s = suffix.trim().toUpperCase();
  if (/^ALT/.test(s)) return "alt";
  if (/^FAKE TLS AUTO/.test(s)) return "fake-tls-auto";
  if (/^SIMPLE FAKE/.test(s)) return "simple-fake";
  return "exp";
}

/** Слаг-id конфига: general, alt, alt2..alt13, exp, fake-tls-auto… (стабильный). */
export function strategyId(fileName: any) {
  const suffix = (fileName.match(/\(([^)]*)\)/) || [])[1];
  if (!suffix) return "general";
  return suffix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Порядок для UI: general → ALT (по номеру) → FAKE TLS AUTO → SIMPLE FAKE → прочее. */
function strategySortKey(s: any) {
  const label = String(s.label || "");
  const m = /(\d+)/.exec(label);
  // Базовый вариант группы идёт первым, затем ALT, ALT2, ALT3…
  const rank = m ? parseInt(m[1], 10) : /ALT/i.test(label) ? 1 : 0;
  const order: Record<string, number> = {
    base: 0,
    alt: 1,
    "fake-tls-auto": 2,
    "simple-fake": 3,
    exp: 4,
  };
  return (order[s.group] ?? 9) * 1000 + rank;
}

/** Все конфиги-стратегии (general*.bat) с готовыми аргументами winws. */
export function listStrategies() {
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
  } catch {
    /* ignore */
  }
  out.sort((a, b) => strategySortKey(a) - strategySortKey(b));
  out.forEach((s: any, i: number) => {
    s.index = i + 1;
  });
  return out;
}

/** Все .bat в каталоге движка (включая служебные) — для браузера конфигов. */
export function listBatFiles() {
  const st = engineStatus();
  if (!st.found) return [];
  try {
    return fs
      .readdirSync(st.dir)
      .filter((f) => /\.bat$/i.test(f))
      .map((f) => ({
        name: f.replace(/\.bat$/i, ""),
        file: f,
        sizeKb: Math.round(fs.statSync(path.join(st.dir, f)).size / 102.4) / 10,
        kind: /^general/i.test(f) ? "strategy" : "service",
        args: /^general/i.test(f) ? extractWinwsArgs(path.join(st.dir, f)) : "",
      }));
  } catch {
    return [];
  }
}

/**
 * Порядок .bat-файлов ровно как в vendor-скрипте utils/test zapret.ps1:
 *   Sort-Object { [Regex]::Replace($_.Name, "(\d+)", { PadLeft(8, "0") }) }
 * (проверено: совпадает с PowerShell на движке Flowseal). Вынесено в чистую
 * функцию, чтобы покрыть тестом.
 */
export function vendorOrder(files: any) {
  const pad = (name: any) => String(name).replace(/(\d+)/g, (m) => m.padStart(8, "0"));
  return [...files].sort((a, b) => pad(a).localeCompare(pad(b), "en", { sensitivity: "base" }));
}

/**
 * Номер конфига ровно так, как его показывает vendor-скрипт utils/test zapret.ps1
 * (Get-ChildItem *.bat | Where-Object { $_.Name -notlike "service*" } | Sort-Object …).
 * Нужен, чтобы проверять ОДИН конфиг (ответ на интерактивный выбор), не показывая
 * пользователю консольный ввод. Возвращает 1-based индекс или 0, если не найден.
 */
export function vendorBatIndex(targetFile: any) {
  const st = engineStatus();
  if (!st.found) return 0;
  let files;
  try {
    files = fs
      .readdirSync(st.dir)
      .filter((f) => /\.bat$/i.test(f))
      .filter((f) => !/^service/i.test(f));
  } catch {
    return 0;
  }
  const idx = vendorOrder(files).findIndex(
    (f) => f.toLowerCase() === String(targetFile || "").toLowerCase(),
  );
  return idx >= 0 ? idx + 1 : 0;
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
export function parseBatConfig(batPath: any) {
  const dir = path.dirname(batPath);
  const result: Record<string, any> = { vars: {}, tokens: [], raw: "" };
  let raw;
  try {
    raw = fs.readFileSync(batPath, "utf8").replace(/\r/g, "");
  } catch {
    return result;
  }
  const joined = raw.replace(/\^\s*\n/g, " "); // склейка переносов bat
  result.raw = joined;

  const varRe = /^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"?\s*$/gim;
  let vm;
  while ((vm = varRe.exec(joined))) result.vars[vm[1].toUpperCase()] = vm[2];

  const line = joined.split("\n").find((l) => /winws(\.exe)?/i.test(l));
  if (!line) return result;
  const cut = line.search(/winws(\.exe)?/i);
  let argsPart = line
    .slice(cut)
    .replace(/^winws(\.exe)?"?/i, "")
    .trim();

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
  const all: Record<string, any> = { ...result.vars, ...builtin };
  argsPart = argsPart.replace(/%~dp0/gi, () => builtin["%~DP0"]);
  argsPart = argsPart.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (mm, name) => {
    const v = all[String(name).toUpperCase()];
    if (v === undefined) return "";
    return String(v)
      .replace(/%~dp0/gi, builtin["%~DP0"])
      .replace(/^"(.*)"$/, "$1");
  });
  argsPart = argsPart.replace(/%/g, "");

  const tokens = splitWinArgs(argsPart).map((t) => t.replace(/,+$/, "")); // хвостовые запятые от %GameFilter%
  result.tokens = tokens.filter((t) => t !== "");
  return result;
}

/** Windows-токенизация: кавычки группируют, сами кавычки в токен не попадают. */
function splitWinArgs(s: any) {
  const out = [];
  let cur = "";
  let inQ = false;
  let has = false;
  for (const ch of String(s || "")) {
    if (ch === '"') {
      inQ = !inQ;
      has = true;
      continue;
    }
    if (!inQ && /\s/.test(ch)) {
      if (cur || has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out.filter((t) => t && t !== "^");
}

/** Командная строка winws для превью/подстановки. */
export function extractWinwsArgs(batPath: any) {
  return parseBatConfig(batPath).tokens.join(" ");
}

/** Токенизация произвольной строки аргументов (для кастомных args из UI). */
export function tokenizeArgs(s: any) {
  return splitWinArgs(s);
}

/* ------------------------- GameFilter (utils/game_filter.enabled) ------------------------- */

/** Файл-флаг GameFilter: содержимое all | tcp | udp (см. service.bat). */
export function gameFilterFile(dir?: any) {
  const d = dir || findEngineDir() || installDir();
  return path.join(d, "utils", "game_filter.enabled");
}

export function readGameFilter() {
  const c = cfg();
  if (c.gameFilterTcp && c.gameFilterUdp) return "all";
  if (c.gameFilterTcp) return "tcp";
  if (c.gameFilterUdp) return "udp";
  return "off";
}

/** Записать/удалить флаг GameFilter (движок читает его при старте). */
export function writeGameFilter() {
  const mode = readGameFilter();
  const f = gameFilterFile();
  try {
    if (mode === "off") {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    } else {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, mode, "utf8");
    }
  } catch {
    /* движок может быть не установлен */
  }
  return mode;
}
