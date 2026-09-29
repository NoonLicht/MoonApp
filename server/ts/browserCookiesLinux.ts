/**
 * Linux-ветка импорта куки браузера (см. browserCookies.ts для общей логики/контракта).
 *
 * ОТЛИЧИЯ ОТ WINDOWS:
 *  - Профили лежат не в `%LOCALAPPDATA%\...\User Data`, а в `~/.config/<браузер>`
 *    (структура профилей внутри — та же: `Default`, `Profile 1`, …).
 *  - Ключ шифрования не хранится DPAPI-обёрнутым в `Local State`: Chromium на Linux
 *    хранит сам ПАРОЛЬ в системном keyring (GNOME Keyring через libsecret, либо
 *    KWallet на KDE) под меткой вида "<Браузер> Safe Storage"; если keyring
 *    недоступен, браузер сам использует фиксированный пароль `"peanuts"`.
 *  - Формат шифрования значений другой: `v10`/`v11` + **AES-128-CBC** (а не
 *    AES-256-GCM, как на Windows/Mac после Chrome 80) — Linux-ветка OSCrypt
 *    исторически не переходила на GCM. IV фиксированный — 16 байт ASCII-пробела
 *    (0x20), ключ — `PBKDF2(password, "saltysalt", 1 итерация, SHA1, 16 байт)`.
 *  - app-bound encryption (`v20`) — это Windows-only фича (Chrome/Edge 127+,
 *    завязана на DPAPI + службу-помощник), на Linux её не существует.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import type { BrowserRoot } from "./browserCookies";

const CHROMIUM_ROOTS_LINUX: { id: string; name: string; rel: string }[] = [
  { id: "chrome", name: "Google Chrome", rel: "google-chrome" },
  { id: "chrome-beta", name: "Google Chrome Beta", rel: "google-chrome-beta" },
  { id: "chromium", name: "Chromium", rel: "chromium" },
  { id: "edge", name: "Microsoft Edge", rel: "microsoft-edge" },
  { id: "brave", name: "Brave", rel: "BraveSoftware/Brave-Browser" },
  { id: "vivaldi", name: "Vivaldi", rel: "vivaldi" },
  { id: "yandex", name: "Яндекс Браузер", rel: "yandex-browser" },
  { id: "opera", name: "Opera", rel: "opera" },
];

/** Корни Chromium-браузеров на Linux: `~/.config/<...>` (или `$XDG_CONFIG_HOME`). */
export function chromiumRootsLinux(env: NodeJS.ProcessEnv = process.env): BrowserRoot[] {
  const home = env.HOME || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const out: BrowserRoot[] = [];
  for (const r of CHROMIUM_ROOTS_LINUX) {
    const dir = path.join(configHome, r.rel);
    if (dir && fs.existsSync(dir)) out.push({ id: r.id, name: r.name, dir });
  }
  return out;
}

/** Профили Firefox на Linux: `~/.mozilla/firefox/<hash>.<имя-профиля>`. */
export function firefoxProfilesLinux(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const base = path.join(home, ".mozilla", "firefox");
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

/**
 * Метки libsecret/KWallet под конкретный браузер.
 * ПОДТВЕРЖДЕНО (используется реальными инструментами извлечения куки вроде
 * browser_cookie3): `chrome`/`chromium`/`brave`. Остальные (edge/vivaldi/yandex/
 * opera) — по аналогии с общей схемой Chromium OSCrypt, не проверено на живых
 * установках; если реальная метка отличается, здесь просто не найдётся пароль и
 * приложение само откатится на `"peanuts"` (это не сбой, а штатная деградация).
 */
const KEYRING_LABELS: Record<
  string,
  { secretApp: string; walletFolder: string; walletKey: string }
> = {
  chrome: { secretApp: "chrome", walletFolder: "Chrome Keys", walletKey: "Chrome Safe Storage" },
  "chrome-beta": {
    secretApp: "chrome",
    walletFolder: "Chrome Keys",
    walletKey: "Chrome Safe Storage",
  },
  chromium: {
    secretApp: "chromium",
    walletFolder: "Chromium Keys",
    walletKey: "Chromium Safe Storage",
  },
  edge: {
    secretApp: "chromium",
    walletFolder: "Microsoft Edge Keys",
    walletKey: "Microsoft Edge Safe Storage",
  },
  brave: { secretApp: "brave", walletFolder: "Brave Keys", walletKey: "Brave Safe Storage" },
  vivaldi: {
    secretApp: "vivaldi",
    walletFolder: "Vivaldi Keys",
    walletKey: "Vivaldi Safe Storage",
  },
  yandex: {
    secretApp: "yandex-browser",
    walletFolder: "Yandex Keys",
    walletKey: "Yandex Safe Storage",
  },
  opera: { secretApp: "opera", walletFolder: "Opera Keys", walletKey: "Opera Safe Storage" },
};

let secretToolAvailable: boolean | null = null;
function hasSecretTool(): boolean {
  if (secretToolAvailable != null) return secretToolAvailable;
  try {
    execFileSync("secret-tool", ["--version"], { stdio: "ignore", timeout: 3000 });
    secretToolAvailable = true;
  } catch {
    secretToolAvailable = false;
  }
  return secretToolAvailable;
}

let kwalletQueryAvailable: boolean | null = null;
function hasKwalletQuery(): boolean {
  if (kwalletQueryAvailable != null) return kwalletQueryAvailable;
  try {
    execFileSync("kwallet-query", ["--help"], { stdio: "ignore", timeout: 3000 });
    kwalletQueryAvailable = true;
  } catch {
    kwalletQueryAvailable = false;
  }
  return kwalletQueryAvailable;
}

/**
 * Пароль (не готовый AES-ключ!) из системного keyring для браузера.
 * `null`, если keyring недоступен/пароль не найден — тогда используется `"peanuts"`
 * (это ровно то, на что сам Chromium откатывается без доступного keyring).
 */
function keyringPassword(browserId: string): string | null {
  const labels = KEYRING_LABELS[browserId];
  if (!labels) return null;

  if (hasSecretTool()) {
    try {
      const out = execFileSync("secret-tool", ["lookup", "application", labels.secretApp], {
        encoding: "utf8",
        timeout: 5000,
      });
      const pw = String(out || "").replace(/\n+$/, "");
      if (pw) return pw;
    } catch {
      // GNOME Keyring недоступен/заблокирован/нет такой записи — пробуем KWallet.
    }
  }

  if (hasKwalletQuery()) {
    try {
      const out = execFileSync(
        "kwallet-query",
        ["-f", labels.walletFolder, "-r", labels.walletKey, "kdewallet"],
        { encoding: "utf8", timeout: 5000 },
      );
      const pw = String(out || "").trim();
      if (pw && !/has no such entry|failed to open/i.test(pw)) return pw;
    } catch {
      // KWallet недоступен/заблокирован — откатываемся на "peanuts".
    }
  }

  return null;
}

export interface ChromiumKeyLinuxResult {
  key: Buffer;
  /** Откуда взят пароль — для диагностики в UI/логах, не влияет на расшифровку. */
  backend: "keyring" | "peanuts";
}

/** AES-128-ключ для расшифровки кук Chromium на Linux. Всегда возвращает ключ. */
export function chromiumKeyLinux(browserId: string): ChromiumKeyLinuxResult {
  const pw = keyringPassword(browserId);
  const password = pw || "peanuts";
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  return { key, backend: pw ? "keyring" : "peanuts" };
}

/** IV Chromium на Linux — 16 байт ASCII-пробела (0x20), а НЕ нули. */
const LINUX_COOKIE_IV = Buffer.alloc(16, 0x20);

/** Снять с расшифрованного значения префикс `SHA256(host_key)` (если он там есть). */
function stripCookieHashLinux(plain: Buffer, hostKey?: string): Buffer {
  if (!hostKey || plain.length <= 32) return plain;
  const hash = crypto.createHash("sha256").update(hostKey, "utf8").digest();
  return plain.subarray(0, 32).equals(hash) ? plain.subarray(32) : plain;
}

/**
 * Расшифровка значения куки Chromium на Linux: `v10`/`v11` + AES-128-CBC
 * (не GCM!), фиксированный IV из 16 пробелов, ключ — см. {@link chromiumKeyLinux}.
 */
export function decryptChromiumValueLinux(
  blob: Buffer,
  key: Buffer,
  hostKey?: string,
): string | null {
  if (!blob.length) return "";
  const tag = blob.subarray(0, 3).toString("latin1");
  if (tag !== "v10" && tag !== "v11") return null;
  try {
    const ciphertext = blob.subarray(3);
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, LINUX_COOKIE_IV);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripCookieHashLinux(plain, hostKey).toString("utf8");
  } catch {
    return null; // неверный ключ (не тот keyring/профиль) — не «баг», а не расшифровалось
  }
}
