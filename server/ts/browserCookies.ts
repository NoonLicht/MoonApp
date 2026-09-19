/**
 * Автоматический импорт куки из установленных браузеров.
 *
 * ЗАЧЕМ: форум закрыт Cloudflare Bot Management, и `cf_clearance` появляется
 * только после прохождения проверки в настоящем браузере. Просить пользователя
 * лезть в DevTools и копировать строку куки — плохой путь (не все найдут), поэтому
 * приложение само читает базу куки браузера, в котором пользователь вошёл на форум.
 *
 * КАК: Chromium-браузеры (Chrome, Edge, Brave, Opera, Yandex, Vivaldi) хранят куки
 * в SQLite (`<профиль>\Network\Cookies`), значения зашифрованы AES-256-GCM ключом
 * из `Local State` (этот ключ защищён DPAPI текущего пользователя). Firefox хранит
 * куки открытым текстом (`cookies.sqlite`). База копируется во временную папку —
 * читать её «на месте» нельзя, браузер держит файл открытым.
 *
 * ЧЕСТНЫЕ ОГРАНИЧЕНИЯ:
 *  - Chrome/Edge 127+ умеют app-bound encryption (префикс `v20`): такие значения
 *    расшифровывает только сам браузер, автоматически прочитать их нельзя —
 *    в пробе вернётся причина, а пользователю предлагается вход через окно
 *    приложения (electron/main.js: tracker:login-window);
 *  - чужой профиль Windows (другая учётная запись) DPAPI не отдаст — это тоже
 *    видно в пробе.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

/** Одна найденная кука (значение уже расшифровано). */
export interface BrowserCookie {
  name: string;
  value: string;
  host: string;
}

/** Что нашли/не нашли в конкретном браузере и профиле — для объяснения в UI. */
export interface BrowserProbe {
  /** Идентификатор браузера (chrome, edge, firefox…) — нужен для подбора UA. */
  id: string;
  browser: string;
  profile: string;
  /** Версия браузера из `Last Version` (пусто, если не прочитать). */
  version: string;
  cookies: number;
  /** Причина, если прочитать не удалось (занят, v20, нет ключа и т.п.). */
  reason: string;
  /** База куки занята запущенным браузером (Windows: EBUSY) — закрыть и повторить. */
  locked?: boolean;
  /** Профиль использует app-bound шифрование (v20): читает только сам браузер. */
  appBound?: boolean;
}

/**
 * Причина «файл занят»: на Windows Chrome/Edge держат базу куки открытой БЕЗ
 * разрешения на чтение, поэтому не помогает ни копирование, ни FileShare.ReadWrite
 * (проверено: copyFileSync/readFileSync/FileStream/Copy-Item — все EBUSY).
 */
export const LOCKED_REASON =
  "база куки занята запущенным браузером — закройте браузер и нажмите ещё раз";

/** Причина «app-bound (v20)»: такие значения расшифровывает только сам браузер. */
export const APP_BOUND_REASON =
  "куки зашифрованы app-bound (v20) — их может прочитать только сам браузер " +
  "(Chrome/Edge 127+): войдите через окно входа в приложении";

/** Ошибка «файл занят другим процессом» (EBUSY/EPERM/EACCES, а также наш код db_locked). */
export function isLockedError(e: unknown): boolean {
  const code = String((e as { code?: string })?.code || "");
  return (
    code === "db_locked" ||
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "EBADF"
  );
}


export interface BrowserCookieResult {
  cookies: Record<string, string>;
  probes: BrowserProbe[];
  /** Профиль-победитель: из него взяты куки (по нему подбирается UA). */
  source: BrowserProbe | null;
}

/** Корень профилей браузера: где искать `Local State` и папки профилей. */
export interface BrowserRoot {
  id: string;
  name: string;
  dir: string;
}

const CHROMIUM_ROOTS: { id: string; name: string; rel: string; base: "local" | "roaming" }[] = [
  { id: "chrome", name: "Google Chrome", rel: "Google\\Chrome\\User Data", base: "local" },
  { id: "edge", name: "Microsoft Edge", rel: "Microsoft\\Edge\\User Data", base: "local" },
  { id: "brave", name: "Brave", rel: "BraveSoftware\\Brave-Browser\\User Data", base: "local" },
  { id: "vivaldi", name: "Vivaldi", rel: "Vivaldi\\User Data", base: "local" },
  { id: "yandex", name: "Яндекс Браузер", rel: "Yandex\\YandexBrowser\\User Data", base: "local" },
  { id: "chromium", name: "Chromium", rel: "Chromium\\User Data", base: "local" },
  { id: "opera", name: "Opera", rel: "Opera Software\\Opera Stable", base: "roaming" },
  { id: "opera-gx", name: "Opera GX", rel: "Opera Software\\Opera GX Stable", base: "roaming" },
];

/** Корни Chromium-браузеров, которые реально есть на машине. */
export function chromiumRoots(env: NodeJS.ProcessEnv = process.env): BrowserRoot[] {
  const local = env.LOCALAPPDATA || "";
  const roaming = env.APPDATA || "";
  const out: BrowserRoot[] = [];
  for (const r of CHROMIUM_ROOTS) {
    const dir = path.join(r.base === "local" ? local : roaming, r.rel);
    if (dir && fs.existsSync(dir)) out.push({ id: r.id, name: r.name, dir });
  }
  return out;
}
/** Профили Chromium внутри корня: `Default`, `Profile 1…`, `Guest Profile`.
 *  У Opera корень — сам профиль, поэтому он тоже попадает в список. */
export function chromiumProfiles(rootDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => n === "Default" || /^Profile \d+$/.test(n) || /^Guest Profile$/i.test(n))
    .map((n) => path.join(rootDir, n));
  // Opera/Yandex-подобные: файлы Cookies лежат прямо в корне.
  if (cookiePathsIn(rootDir).length) dirs.unshift(rootDir);
  return dirs;
}

/** Возможные пути файла куки в профиле (новые версии — подпапка Network). */
export function cookiePathsIn(profileDir: string): string[] {
  return [path.join(profileDir, "Network", "Cookies"), path.join(profileDir, "Cookies")].filter(
    (p) => fs.existsSync(p),
  );
}

/**
 * Расшифровка значения куки Chromium. Форматы на Windows:
 *  - `v10`/`v11` + AES-256-GCM: nonce(12) + шифр + тег(16), ключ из `Local State`;
 *  - без префикса — старое поведение: значение целиком зашифровано DPAPI;
 *  - `v20` — app-bound encryption (Chrome 127+): читать нельзя, вернём null.
 *
 * ВАЖНО про хеш домена: в куки Chromium шифрует не только значение, а
 * `SHA256(host_key) || value` (защита от переноса куки на другой домен). Без снятия
 * этих 32 байт «значение» выглядит мусором, а кука уходит на сервер испорченной —
 * поэтому, зная host_key, префикс проверяем и убираем. Если host_key неизвестен
 * (самопроверка), первые 32 байта не трогаем.
 */
export function decryptChromiumValue(
  blob: Buffer,
  key: Buffer | null,
  dpapi?: (input: Buffer) => Buffer,
  hostKey?: string,
): string | null {
  if (!blob.length) return "";
  const tag = blob.subarray(0, 3).toString("latin1");
  if (tag === "v20") return null; // app-bound encryption: только самим браузером
  if (tag === "v10" || tag === "v11") {
    if (!key || key.length !== 32) return null;
    try {
      const nonce = blob.subarray(3, 15);
      const data = blob.subarray(15, blob.length - 16);
      const authTag = blob.subarray(blob.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      return stripCookieHash(plain, hostKey).toString("utf8");
    } catch {
      return null;
    }
  }
  if (!dpapi) return null;
  try {
    return stripCookieHash(dpapi(blob), hostKey).toString("utf8");
  } catch {
    return null;
  }
}

/** Снять с расшифрованного значения префикс `SHA256(host_key)` (если он там есть). */
export function stripCookieHash(plain: Buffer, hostKey?: string): Buffer {
  if (!hostKey || plain.length <= 32) return plain;
  const hash = crypto.createHash("sha256").update(hostKey, "utf8").digest();
  return plain.subarray(0, 32).equals(hash) ? plain.subarray(32) : plain;
}

/**
 * Шифрование как у Chrome (`v10` + AES-GCM): нужно тестам и самопроверке.
 * `hostKey` — домен куки: как и Chrome, добавляем к значению его хеш.
 */
export function encryptChromiumValue(value: string, key: Buffer, hostKey?: string): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const plain = hostKey
    ? Buffer.concat([crypto.createHash("sha256").update(hostKey, "utf8").digest(), Buffer.from(value, "utf8")])
    : Buffer.from(value, "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, enc, cipher.getAuthTag()]);
}

/** Подходит ли доменное имя куки целевому хосту (`.<host>`, сам хост, поддомен). */
export function hostMatches(cookieHost: string, host: string): boolean {
  const h = String(cookieHost || "").replace(/^\./, "").toLowerCase();
  const t = String(host || "").toLowerCase();
  if (!h || !t) return false;
  return h === t || t.endsWith("." + h) || h.endsWith("." + t);
}

/** Chrome хранит время в микросекундах от 1601-01-01; 0 — сессионная кука. */
export function chromeExpiryToMs(us: unknown): number {
  const n = Number(us);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 1000 - 11644473600000);
}

/** Версия браузера из `<User Data>\Last Version` — нужна, чтобы собрать его UA. */
export function chromiumVersion(rootDir: string): string {
  try {
    return fs.readFileSync(path.join(rootDir, "Last Version"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Полный Chromium-UA по версии браузера. */
function chromiumUa(version: string, extra = ""): string {
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${version} Safari/537.36${extra}`
  );
}

/**
 * UA браузера, из которого взяты куки.
 *
 * Зачем: `cf_clearance` привязан к паре «IP + User-Agent», поэтому наши запросы
 * должны представляться тем же браузером, иначе Cloudflare снова отдаст проверку.
 * Собираем UA только для браузеров, где он однозначно выводится из версии
 * (Chrome, Chromium, Brave, Vivaldi — это обычный Chrome-UA; Edge добавляет
 * `Edg/<версия>`). Для Firefox/Yandex/Opera вернуть нельзя — там свой формат
 * (firefox/…, YaBrowser/…, OPR/…), который по `Last Version` не восстановить;
 * честнее не выдумывать и оставить UA пустым.
 */
export function uaForBrowser(id: string, version: string): string {
  const v = String(version || "").trim();
  if (!v) return "";
  switch (id) {
    case "chrome":
    case "chromium":
    case "brave":
    case "vivaldi":
      return chromiumUa(v);
    case "edge":
      return chromiumUa(v, ` Edg/${v}`);
    default:
      return "";
  }
}

/** DPAPI текущего пользователя через PowerShell (нативного модуля в проекте нет). */
export function dpapiUnprotectWindows(input: Buffer): Buffer {
  const b64 = input.toString("base64");
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${b64}')`,
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    "[Convert]::ToBase64String($p)",
  ].join("; ");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 20000,
  });
  return Buffer.from(String(out).trim(), "base64");
}

/**
 * Blob для DPAPI из `os_crypt.encrypted_key` в `Local State`.
 *
 * Формат Chromium (OSCrypt): в файле лежит base64 от `"DPAPI" + <DPAPI-шифрованный
 * ключ>`, то есть САМА строка начинается с «RFBBUEk» — проверять у неё префикс
 * «DPAPI» нельзя (иначе ключ «не находится» у любого современного Chrome, и подхват
 * куки молча не работает). Для полноты принимаем и старый вариант, где префикс был
 * записан текстом до base64.
 */
function oscryptKeyBlob(enc: string): Buffer {
  if (enc.startsWith("DPAPI")) return Buffer.from(enc.slice(5), "base64");
  const raw = Buffer.from(enc, "base64");
  return raw.subarray(0, 5).toString("latin1") === "DPAPI" ? raw.subarray(5) : raw;
}

/** Ключ AES из `Local State` (DPAPI-обёрнутый), либо null с причиной. */
export function chromiumKey(
  rootDir: string,
  dpapi: (input: Buffer) => Buffer,
): { key: Buffer | null; reason: string; appBound: boolean } {
  let state: { os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string } };
  try {
    state = JSON.parse(fs.readFileSync(path.join(rootDir, "Local State"), "utf8"));
  } catch {
    return { key: null, reason: "нет Local State", appBound: false };
  }
  // app-bound-ключ (Chrome/Edge 127+): присутствует почти всегда вместе с обычным
  // DPAPI-ключом, но значения куки такими профилями шифруются app-bound (v20).
  // Возвращаем это отдельным признаком: UI скажет, что поможет только окно входа,
  // а не «не расшифровано» / «файл занят».
  const appBound = !!state?.os_crypt?.app_bound_encrypted_key;
  const enc = state?.os_crypt?.encrypted_key;
  if (!enc) {
    return {
      key: null,
      appBound,
      reason: appBound
        ? "app-bound encryption (Chrome 127+): куки читает только сам браузер"
        : "ключ браузера не найден",
    };
  }
  try {
    const key = dpapi(oscryptKeyBlob(String(enc)));
    return key?.length === 32
      ? { key, reason: "", appBound }
      : { key: null, reason: "ключ неверной длины", appBound };
  } catch {
    return { key: null, reason: "DPAPI не отдал ключ (другая учётная запись Windows)", appBound };
  }
}
/** Мини-типы SQLite: у better-sqlite3 нет @types в проекте (в flibusta.js он в JS). */
type SqliteStmt = { all: (...p: unknown[]) => unknown[] };
type SqliteDb = { prepare: (sql: string) => SqliteStmt; close: () => void };
type SqliteCtor = new (
  file: string,
  opts: { readonly?: boolean; fileMustExist?: boolean },
) => SqliteDb;

/** Чтение SQLite из КОПИИ файла: браузер держит базу открытой, «на месте» нельзя. */
function readSqlite<T>(dbFile: string, sql: string): T[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-cookies-"));
  const copy = path.join(dir, path.basename(dbFile));
  try {
    try {
      fs.copyFileSync(dbFile, copy);
    } catch (e) {
      // Занятая база — не «ошибка кода», а состояние браузера: отдаём понятную
      // причину, чтобы UI попросил закрыть браузер (код db_locked).
      if (isLockedError(e)) {
        const err = new Error(LOCKED_REASON) as Error & { code?: string };
        err.code = "db_locked";
        throw err;
      }
      throw e;
    }
    // WAL/SHM рядом: без них самые свежие куки могут не попасть в копию.
    // Их копия не критична (в WAL-режиме пропущенные кадры просто не читаются).
    for (const suffix of ["-wal", "-shm"]) {
      const side = dbFile + suffix;
      try {
        if (fs.existsSync(side)) fs.copyFileSync(side, copy + suffix);
      } catch {
        /* занят или исчез — читаем основную базу */
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as SqliteCtor;
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* временная папка останется — не критично */
    }
  }
}

/** Куки Chromium-профиля для нужного хоста (значения расшифрованы). */
export function readChromiumCookies(opts: {
  profileDir: string;
  host: string;
  key: Buffer | null;
  dpapi: (input: Buffer) => Buffer;
  now?: number;
}): { cookies: BrowserCookie[]; failed: number; appBound: number } {
  const file = cookiePathsIn(opts.profileDir)[0];
  if (!file) throw new Error("нет файла куки");
  const rows = readSqlite<{
    name: string;
    value: string | null;
    host_key: string;
    expires_utc: number;
    encrypted_value: Buffer | null;
  }>(file, "SELECT name, value, host_key, expires_utc, encrypted_value FROM cookies");
  const now = opts.now ?? Date.now();
  const cookies: BrowserCookie[] = [];
  let failed = 0;
  // app-bound (v20) считаем отдельно: это не «сломанная расшифровка», а
  // ограничение браузера (Chrome/Edge 127+) — в UI нужна другая подсказка.
  let appBound = 0;
  for (const r of rows) {
    if (!hostMatches(r.host_key, opts.host)) continue;
    const exp = chromeExpiryToMs(r.expires_utc);
    if (exp && exp < now) continue; // просроченная — не берём
    let value = typeof r.value === "string" ? r.value : "";
    if (!value) {
      const raw = r.encrypted_value;
      const blob = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ""), "latin1");
      if (blob.subarray(0, 3).toString("latin1") === "v20") {
        appBound++;
        continue;
      }
      // Домен передаём в расшифровку: в куки Chromium шифрует `SHA256(host_key) +
      // value`, и без снятия префикса значение уходило бы на форум испорченным.
      const dec = decryptChromiumValue(blob, opts.key, opts.dpapi, r.host_key);
      if (dec == null) {
        failed++;
        continue;
      }
      value = dec;
    }
    if (!value) continue;
    cookies.push({ name: r.name, value, host: r.host_key });
  }
  return { cookies, failed, appBound };
}

/** Профили Firefox (там куки лежат открытым текстом). */
export function firefoxProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = path.join(env.APPDATA || "", "Mozilla", "Firefox", "Profiles");
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name))
      .filter((p) => fs.existsSync(path.join(p, "cookies.sqlite")));
  } catch {
    return [];
  }
}

/** Куки Firefox-профиля: значения не шифруются, отсекаем только просроченные. */
export function readFirefoxCookies(opts: {
  profileDir: string;
  host: string;
  now?: number;
}): { cookies: BrowserCookie[]; failed: number } {
  const file = path.join(opts.profileDir, "cookies.sqlite");
  const rows = readSqlite<{ name: string; value: string | null; host: string; expiry: number }>(
    file,
    "SELECT name, value, host, expiry FROM moz_cookies",
  );
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const cookies: BrowserCookie[] = [];
  for (const r of rows) {
    if (!hostMatches(r.host, opts.host)) continue;
    const exp = Number(r.expiry) || 0;
    if (exp && exp < nowSec) continue;
    if (!r.value) continue;
    cookies.push({ name: r.name, value: r.value, host: r.host });
  }
  return { cookies, failed: 0 };
}
/** Куки маркеров сессии форума: по ним профиль считается «живым». */
const SESSION_MARKERS = ["bb_data", "bb_session", "sid", "bb_t"];

/** Есть ли в наборе признак залогиненной сессии (нужно для порядка слияния). */
function hasSessionMarker(cookies: BrowserCookie[]): boolean {
  return cookies.some((c) => SESSION_MARKERS.includes(c.name.toLowerCase()));
}

/**
 * Собрать куки нужного хоста из всех браузеров машины.
 *
 * Профили разных браузеров содержат РАЗНЫЕ сессии форума, поэтому объединять их
 * «как попало» нельзя: сначала сортируем — выше те, где есть маркер сессии
 * (`bb_data`/`sid`), затем по количеству найденных куки, и только потом сливаем
 * (первое значение выигрывает). Так побеждает тот профиль, где пользователь
 * действительно вошёл на форум.
 *
 * Зависимости (поиск корней, DPAPI) инжектируются — так это тестируется без
 * реальных браузеров и без Windows.
 */
export function collectBrowserCookies(
  host: string,
  opts: {
    roots?: BrowserRoot[];
    firefox?: string[];
    dpapi?: (input: Buffer) => Buffer;
    now?: number;
  } = {},
): BrowserCookieResult {
  const dpapi = opts.dpapi || dpapiUnprotectWindows;
  const roots = opts.roots || chromiumRoots();
  const firefox = opts.firefox || firefoxProfiles();
  const probes: BrowserProbe[] = [];
  const found: { probe: BrowserProbe; cookies: BrowserCookie[] }[] = [];

  for (const root of roots) {
    const { key, reason, appBound } = chromiumKey(root.dir, dpapi);
    const profiles = chromiumProfiles(root.dir);
    const version = chromiumVersion(root.dir);
    if (!profiles.length) {
      probes.push({
        id: root.id,
        browser: root.name,
        profile: "",
        version,
        cookies: 0,
        reason: reason || "профили не найдены",
        appBound,
      });
      continue;
    }
    for (const profileDir of profiles) {
      const profile = profileDir === root.dir ? "root" : path.basename(profileDir);
      try {
        const r = readChromiumCookies({ profileDir, host, key, dpapi, now: opts.now });
        if (!r.cookies.length) {
          probes.push({
            id: root.id,
            browser: root.name,
            profile,
            version,
            cookies: 0,
            reason: missingReason(host, appBound, r),
            appBound: appBound || r.appBound > 0,
          });
          continue;
        }
        const probe: BrowserProbe = {
          id: root.id,
          browser: root.name,
          profile,
          version,
          cookies: r.cookies.length,
          reason: "",
          appBound: appBound || r.appBound > 0,
        };
        probes.push(probe);
        found.push({ probe, cookies: r.cookies });
      } catch (e) {
        const locked = isLockedError(e);
        probes.push({
          id: root.id,
          browser: root.name,
          profile,
          version,
          cookies: 0,
          // app-bound важнее «файл занят»: закрывать браузер бесполезно, значение
          // всё равно зашифровано под сам браузер (живой пример — Edge 153).
          reason: appBound
            ? APP_BOUND_REASON
            : locked
              ? LOCKED_REASON
              : (e as Error)?.message || "не прочитать",
          locked,
          appBound,
        });
      }
    }
  }

  for (const profileDir of firefox) {
    const profile = path.basename(profileDir);
    try {
      const r = readFirefoxCookies({ profileDir, host, now: opts.now });
      if (!r.cookies.length) {
        probes.push({
          id: "firefox",
          browser: "Firefox",
          profile,
          version: "",
          cookies: 0,
          reason: `куки ${host} не найдены`,
        });
        continue;
      }
      const probe: BrowserProbe = {
        id: "firefox",
        browser: "Firefox",
        profile,
        version: "",
        cookies: r.cookies.length,
        reason: "",
      };
      probes.push(probe);
      found.push({ probe, cookies: r.cookies });
    } catch (e) {
      probes.push({
        id: "firefox",
        browser: "Firefox",
        profile,
        version: "",
        cookies: 0,
        reason: (e as Error)?.message || "не прочитать",
      });
    }
  }

  found.sort((a, b) => {
    const sa = hasSessionMarker(a.cookies) ? 1 : 0;
    const sb = hasSessionMarker(b.cookies) ? 1 : 0;
    return sb - sa || b.cookies.length - a.cookies.length;
  });

  const cookies: Record<string, string> = {};
  for (const item of found) {
    for (const c of item.cookies) if (!(c.name in cookies)) cookies[c.name] = c.value;
  }
  return { cookies, probes, source: found[0]?.probe || null };
}

/** Короткое человекочитаемое описание проб (для ошибки и UI). */
export function probesSummary(probes: BrowserProbe[]): string {
  if (!probes.length) return "браузеры не найдены";
  return probes
    .map((p) => `${p.browser}${p.profile ? ` (${p.profile})` : ""}: ${p.cookies || p.reason}`)
    .join("; ");
}

/**
 * Причина «куки есть в базе, но не отдались».
 *
 * Порядок важен: app-bound — постоянное ограничение профиля (Chrome/Edge 127+
 * шифруют значения под самого себя), поэтому сначала говорим о нём, а не о
 * количестве нерасшифрованных значений.
 */
function missingReason(
  host: string,
  appBoundKey: boolean,
  r: { failed: number; appBound: number },
): string {
  if (appBoundKey || r.appBound) return APP_BOUND_REASON;
  const bad = r.failed ? `, ${r.failed} не расшифровано` : "";
  return `куки ${host} не найдены${bad}`;
}