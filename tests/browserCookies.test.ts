import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

/**
 * Автоподхват куки из браузеров.
 *
 * Живьём проверено на машине разработчика: Chrome/Edge 153 держат куки в
 * app-bound-шифровании (v20) — прочитать их снаружи нельзя, и в пробе это видно
 * как «не расшифровано». Поэтому тесты фиксируют формат v10 (старые версии,
 * Firefox) и честное поведение на v20, а не выдуманный успех.
 */
import {
  APP_BOUND_REASON,
  LOCKED_REASON,
  chromeExpiryToMs,
  chromiumKey,
  chromiumProfiles,
  chromiumVersion,
  collectBrowserCookies,
  cookiePathsIn,
  decryptChromiumValue,
  encryptChromiumValue,
  hostMatches,
  isLockedError,
  readChromiumCookies,
  readFirefoxCookies,
  uaForBrowser,
} from "../server/browserCookies";

const KEY = crypto.randomBytes(32);
let workDir = "";

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-bc-test-"));
});

/** Фикстура SQLite с куки (та же схема, что у Chromium). */
function makeChromiumProfile(
  name: string,
  rows: { name: string; host: string; value?: string; enc?: Buffer; expires?: number }[],
): string {
  const dir = path.join(workDir, name, "Default", "Network");
  fs.mkdirSync(dir, { recursive: true });
  // Local State с DPAPI-обёрнутым ключом: тесты передают dpapi = () => KEY,
  // поэтому ключ расшифровки — KEY (как у реального браузера текущего пользователя).
  const rootDir = path.dirname(path.dirname(dir));
  fs.writeFileSync(
    path.join(rootDir, "Local State"),
    JSON.stringify({ os_crypt: { encrypted_key: "DPAPI" + KEY.toString("base64") } }),
  );
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dir, "Cookies"));
  db.exec(
    "CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, expires_utc INTEGER, encrypted_value BLOB)",
  );
  const ins = db.prepare(
    "INSERT INTO cookies (name, value, host_key, expires_utc, encrypted_value) VALUES (?,?,?,?,?)",
  );
  for (const r of rows) {
    ins.run(r.name, r.value ?? "", r.host, r.expires ?? 0, r.enc ?? Buffer.alloc(0));
  }
  db.close();
  return path.dirname(path.dirname(dir)); // корень профиля (…/User Data)
}
/**
 * v20-значение (app-bound): так выглядят куки Chrome/Edge 127+ — расшифровать
 * их снаружи нельзя, браузер отдаёт значения только самому себе.
 */
function v20Blob(): Buffer {
  return Buffer.concat([Buffer.from("v20"), crypto.randomBytes(24)]);
}

describe("browserCookies — чистые хелперы", () => {
  it("hostMatches: домен куки покрывает хост и его поддомены", () => {
    expect(hostMatches(".rutracker.org", "rutracker.org")).toBe(true);
    expect(hostMatches("rutracker.org", "rutracker.org")).toBe(true);
    expect(hostMatches(".rutracker.org", "forum.rutracker.org")).toBe(true);
    expect(hostMatches(".rutracker.org", "example.com")).toBe(false);
    expect(hostMatches("", "rutracker.org")).toBe(false);
  });

  it("chromeExpiryToMs: сессионная кука (0) и реальный срок", () => {
    expect(chromeExpiryToMs(0)).toBe(0);
    expect(chromeExpiryToMs("")).toBe(0);
    const ms = chromeExpiryToMs(13300000000000000); // мкс от 1601 → 2022 год
    expect(ms).toBeGreaterThan(1650000000000);
    expect(ms).toBeLessThan(1670000000000);
    expect(chromeExpiryToMs(1e12)).toBeLessThan(Date.now());
  });

  it("AES-GCM как у Chrome (v10) читается, v20 (app-bound) — нет", () => {
    const blob = encryptChromiumValue("cookie-value", KEY);
    expect(blob.subarray(0, 3).toString("latin1")).toBe("v10");
    expect(decryptChromiumValue(blob, KEY)).toBe("cookie-value");
    // Не тот ключ — расшифровка не удаётся, но исключения нет.
    expect(decryptChromiumValue(blob, crypto.randomBytes(32))).toBeNull();
    // v20 — app-bound encryption (Chrome 127+): читать нельзя.
    const v20 = Buffer.concat([Buffer.from("v20", "latin1"), Buffer.alloc(40)]);
    expect(decryptChromiumValue(v20, KEY)).toBeNull();
    // Пустое значение и старый DPAPI-формат (через инжектированный распаковщик).
    expect(decryptChromiumValue(Buffer.alloc(0), KEY)).toBe("");
    const legacy = Buffer.from("dpapi-blob", "latin1");
    expect(decryptChromiumValue(legacy, KEY, () => Buffer.from("plain", "utf8"))).toBe("plain");
    expect(decryptChromiumValue(legacy, KEY)).toBeNull();
  });
});
describe("browserCookies — корни, ключи и профили", () => {
  it("chromiumProfiles находит Default/Profile N и корень-профиль (Opera)", () => {
    const root = makeChromiumProfile("chrome-root", [{ name: "a", host: ".x.org" }]);
    fs.mkdirSync(path.join(root, "Profile 1", "Network"), { recursive: true });
    const profiles = chromiumProfiles(root).map((p) => path.basename(p));
    expect(profiles).toContain("Default");
    expect(profiles).toContain("Profile 1");

    const opera = path.join(workDir, "opera-root", "Network");
    fs.mkdirSync(opera, { recursive: true });
    fs.writeFileSync(path.join(opera, "Cookies"), "");
    const operaRoot = path.dirname(opera);
    expect(chromiumProfiles(operaRoot).map((p) => path.basename(p))).toContain(
      path.basename(operaRoot),
    );
  });

  it("chromiumKey/chromiumVersion: app-bound ключ виден как причина, версия — из Last Version", () => {
    const root = path.join(workDir, "edge-root");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "Last Version"), "153.0.4234.32\n");
    fs.writeFileSync(
      path.join(root, "Local State"),
      JSON.stringify({ os_crypt: { app_bound_encrypted_key: "APPB" } }),
    );
    expect(chromiumVersion(root)).toBe("153.0.4234.32");
    const abe = chromiumKey(root, () => Buffer.alloc(32));
    expect(abe.key).toBeNull();
    expect(abe.reason).toContain("app-bound");
    expect(abe.appBound).toBe(true);

    // Обычный DPAPI-ключ: префикс DPAPI снимается, ключ отдаётся как есть.
    fs.writeFileSync(
      path.join(root, "Local State"),
      JSON.stringify({ os_crypt: { encrypted_key: "DPAPI" + KEY.toString("base64") } }),
    );
    const plain = chromiumKey(root, () => KEY);
    expect(plain.key?.length).toBe(32);
    expect(plain.appBound).toBe(false);

    // РЕАЛЬНЫЙ формат Chromium: в Local State лежит base64 от «DPAPI» + blob, то
    // есть строка начинается с «RFBBUEk». Проверка префикса у самой строки ломала
    // подхват куки у любого современного Chrome/Electron (ключ «не находился»).
    fs.writeFileSync(
      path.join(root, "Local State"),
      JSON.stringify({
        os_crypt: {
          encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), KEY]).toString("base64"),
        },
      }),
    );
    const real = chromiumKey(root, (blob) => {
      // dpapi получает blob БЕЗ префикса «DPAPI».
      expect(blob.equals(KEY)).toBe(true);
      return KEY;
    });
    expect(real.key?.length).toBe(32);
    expect(real.reason).toBe("");

    // Живая пара: и DPAPI-ключ, и app-bound (Chrome/Edge 127+) — читать нельзя,
    // поэтому признак appBound отдельный, а не «ключ не найден».
    fs.writeFileSync(
      path.join(root, "Local State"),
      JSON.stringify({
        os_crypt: {
          encrypted_key: "DPAPI" + KEY.toString("base64"),
          app_bound_encrypted_key: "APPB",
        },
      }),
    );
    expect(chromiumKey(root, () => KEY).appBound).toBe(true);
  });

  it("cookiePathsIn находит базу и в Network/, и в корне профиля", () => {
    const root = makeChromiumProfile("chrome-paths", [{ name: "a", host: ".x.org" }]);
    expect(cookiePathsIn(path.join(root, "Default")).length).toBe(1);
    expect(cookiePathsIn(path.join(root, "Nope")).length).toBe(0);
  });
});
describe("browserCookies — чтение куки профилей", () => {
  it("readChromiumCookies: фильтр по домену и сроку, расшифровка v10, счёт нерасшифрованных", () => {
    const root = makeChromiumProfile("chrome-read", [
      {
        name: "cf_clearance",
        host: ".rutracker.org",
        enc: encryptChromiumValue("clear", KEY),
        // Chrome считает время в микросекундах от 1601-01-01; берём «завтра».
        expires: (Math.floor(Date.now() / 1000) + 86400 + 11644473600) * 1e6,
      },
      {
        // Реальный Chrome шифрует `SHA256(host_key) + value`: без снятия префикса
        // значение ушло бы на форум мусором — проверяем, что оно чистое.
        name: "bb_guid",
        host: ".rutracker.org",
        enc: encryptChromiumValue("xJOzPu9SG2Gr", KEY, ".rutracker.org"),
        expires: (Math.floor(Date.now() / 1000) + 86400 + 11644473600) * 1e6,
      },
      { name: "bb_data", host: ".rutracker.org", value: "plain-data" },
      { name: "other", host: ".example.com", value: "x" },
      { name: "expired", host: ".rutracker.org", value: "y", expires: 1 },
      {
        name: "v20",
        host: ".rutracker.org",
        enc: Buffer.concat([Buffer.from("v20"), Buffer.alloc(20)]),
      },
    ]);
    const r = readChromiumCookies({
      profileDir: path.join(root, "Default"),
      host: "rutracker.org",
      key: KEY,
      dpapi: () => Buffer.from(""),
    });
    expect(r.cookies.map((c) => c.name).sort()).toEqual(["bb_data", "bb_guid", "cf_clearance"]);
    expect(r.cookies.find((c) => c.name === "cf_clearance")?.value).toBe("clear");
    // Хеш домена снят: значение пригодно для форума (не «битый» utf8).
    expect(r.cookies.find((c) => c.name === "bb_guid")?.value).toBe("xJOzPu9SG2Gr");
    // v20 считается отдельно (app-bound): это не «сломанная расшифровка», а
    // ограничение браузера — в UI для него другая подсказка.
    expect(r.appBound).toBe(1);
    expect(r.failed).toBe(0);
  });

  it("readFirefoxCookies: значения не шифруются, срок фильтруется", () => {
    const dir = path.join(workDir, "ff", "profile.default");
    fs.mkdirSync(dir, { recursive: true });
    const Database = require("better-sqlite3");
    const db = new Database(path.join(dir, "cookies.sqlite"));
    db.exec("CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, expiry INTEGER)");
    const ins = db.prepare("INSERT INTO moz_cookies (name, value, host, expiry) VALUES (?,?,?,?)");
    const future = Math.floor(Date.now() / 1000) + 3600;
    ins.run("bb_data", "ff-data", ".rutracker.org", future);
    ins.run("bb_data_old", "old", ".rutracker.org", 1);
    ins.run("zz", "x", ".example.com", future);
    db.close();

    const r = readFirefoxCookies({ profileDir: dir, host: "rutracker.org" });
    expect(r.cookies.map((c) => c.name)).toEqual(["bb_data"]);
    expect(r.cookies[0].value).toBe("ff-data");
  });

  it("collectBrowserCookies: профиль с сессией форума побеждает, пробы объясняют остальное", () => {
    const chrome = makeChromiumProfile("chrome-collect", [
      { name: "cf_clearance", host: ".rutracker.org", enc: encryptChromiumValue("c1", KEY) },
    ]);
    fs.writeFileSync(path.join(chrome, "Last Version"), "126.0.6478.127");
    const edge = makeChromiumProfile("edge-collect", [
      { name: "cf_clearance", host: ".rutracker.org", enc: encryptChromiumValue("c2", KEY) },
      { name: "bb_data", host: ".rutracker.org", enc: encryptChromiumValue("c3", KEY) },
    ]);
    fs.writeFileSync(path.join(edge, "Last Version"), "153.0.4234.32");

    const res = collectBrowserCookies("rutracker.org", {
      roots: [
        { id: "chrome", name: "Google Chrome", dir: chrome },
        { id: "edge", name: "Microsoft Edge", dir: edge },
      ],
      firefox: [],
      dpapi: () => KEY,
    });

    // Профиль с bb_data (это признак входа) идёт первым — его значения и побеждают.
    expect(res.cookies.cf_clearance).toBe("c2");
    expect(res.cookies.bb_data).toBe("c3");
    expect(res.source?.browser).toBe("Microsoft Edge");
    expect(res.probes.every((p) => p.cookies > 0)).toBe(true);
  });

  it("uaForBrowser: UA выводится только там, где он однозначен", () => {
    expect(uaForBrowser("chrome", "126.0.6478.127")).toContain("Chrome/126.0.6478.127");
    expect(uaForBrowser("edge", "127.0.2651.105")).toContain("Edg/127.0.2651.105");
    expect(uaForBrowser("brave", "1.2.3")).toContain("Chrome/1.2.3");
    // Firefox/Opera/Yandex: свой формат, по Last Version не восстановить — честно пусто.
    expect(uaForBrowser("firefox", "128.0")).toBe("");
    expect(uaForBrowser("yandex", "24.6.0.0")).toBe("");
    expect(uaForBrowser("chrome", "")).toBe("");
  });

  it("занятая база браузера распознаётся как «закройте браузер»", () => {
    // Живая проверка на Windows: Chrome держит Cookies открытым без FILE_SHARE_READ,
    // поэтому любое чтение/копирование падает с EBUSY — это состояние браузера,
    // а не ошибка кода, и в UI нужна понятная причина.
    expect(isLockedError({ code: "EBUSY" })).toBe(true);
    expect(isLockedError({ code: "EPERM" })).toBe(true);
    expect(isLockedError({ code: "EACCES" })).toBe(true);
    // Свой код для «занятой базы» (readSqlite) — тоже «занято».
    expect(isLockedError({ code: "db_locked" })).toBe(true);
    expect(isLockedError({ code: "ENOENT" })).toBe(false);
    expect(isLockedError(new Error("boom"))).toBe(false);
    expect(LOCKED_REASON).toContain("закройте браузер");
    expect(APP_BOUND_REASON).toContain("окно входа");
  });

  it("app-bound профиль (Chrome/Edge 127+): проба объясняет, что поможет только окно входа", () => {
    const root = makeChromiumProfile("chrome-appbound", [
      // cf_clearance и bb_data есть в базе, но значения v20 — как у Edge 153 живьём.
      { name: "cf_clearance", host: ".rutracker.org", enc: v20Blob() },
      { name: "bb_data", host: ".rutracker.org", enc: v20Blob() },
    ]);
    // Local State с обоими ключами: обычный DPAPI + app-bound (реальный Chrome 153).
    fs.writeFileSync(
      path.join(root, "Local State"),
      JSON.stringify({
        os_crypt: {
          encrypted_key: "DPAPI" + KEY.toString("base64"),
          app_bound_encrypted_key: "APPB",
        },
      }),
    );
    fs.writeFileSync(path.join(root, "Last Version"), "153.0.8010.47");

    const res = collectBrowserCookies("rutracker.org", {
      roots: [{ id: "chrome", name: "Google Chrome", dir: root }],
      firefox: [],
      dpapi: () => KEY,
    });

    expect(Object.keys(res.cookies)).toEqual([]);
    expect(res.source).toBeNull();
    const probe = res.probes[0];
    expect(probe.appBound).toBe(true);
    expect(probe.cookies).toBe(0);
    expect(probe.reason).toContain("app-bound");
  });
});