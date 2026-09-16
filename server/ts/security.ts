/**
 * Секреты приложения: ключи API провайдеров и TMDB в storage/secrets.json.
 *
 * Секреты шифруются. Внутри Electron используется safeStorage (на Windows это
 * DPAPI — шифрование под учёткой, без пароля). Без Electron — фолбэк на
 * AES-256-GCM с мастер-ключом.
 *
 * TS-исходник, как server/ts/settings.ts: компилируется в server/security.js
 * командой `npm run compile:server`, поэтому `require("./security")` из
 * обычных .js-модулей продолжает работать без изменений.
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";

const { FILES } = config;

/** Минимальный срез Electron safeStorage — модуль грузится динамически. */
interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
}

function getElectronSafeStorage(): SafeStorageLike | null {
  try {
    // require, а не import: вне Electron модуля нет вовсе, а импорт на верхнем
    // уровне уронил бы standalone-запуск (npm run start:server) и тесты.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { safeStorage?: SafeStorageLike };
    return electron?.safeStorage || null;
  } catch {
    return null;
  }
}

function getMasterKey(): Buffer {
  // Приоритет: env-переменная → мастер-ключ из настроек (advanced.masterKey) →
  // dev-ключ (только для standalone-запуска без Electron, небезопасно!).
  const fromEnv = process.env.MOONAPP_MASTER_KEY;
  if (fromEnv) return crypto.createHash("sha256").update(fromEnv).digest();
  try {
    // Динамический require: на раннем старте settings может быть не готов.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require("./settings") as { get(key: string): any };
    const fromSettings = String(settings.get("advanced").masterKey || "").trim();
    if (fromSettings) return crypto.createHash("sha256").update(fromSettings).digest();
  } catch {
    /* settings может быть недоступен на раннем старте — идём в dev-ключ */
  }
  return crypto.createHash("sha256").update("dev-master-key-not-for-prod").digest();
}

const ALGO = "aes-256-gcm";

function aesEncrypt(plain: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

function aesDecrypt(token: string): string {
  const key = getMasterKey();
  const [ivB, tagB, dataB] = token.split(".");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

function encryptSecret(plain: string): string {
  const ss = getElectronSafeStorage();
  if (ss && ss.isEncryptionAvailable()) {
    return "__ss__" + ss.encryptString(plain).toString("base64");
  }
  return "__aes__" + aesEncrypt(plain);
}

export function decryptSecret(token: unknown): string {
  if (typeof token !== "string") throw new Error("invalid secret");
  const ss = getElectronSafeStorage();
  if (token.startsWith("__ss__") && ss) {
    return ss.decryptString(Buffer.from(token.slice(6), "base64"));
  }
  if (token.startsWith("__aes__")) return aesDecrypt(token.slice(7));
  throw new Error("unknown secret format");
}

// secrets.json — тут зашифрованные ключи API: { providerName: "<encrypted>", ... }
function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(FILES.secrets, "utf8"));
  } catch {
    return {};
  }
}

function writeSecrets(obj: Record<string, string>): void {
  fs.writeFileSync(FILES.secrets, JSON.stringify(obj, null, 2), "utf8");
}

export function setSecret(name: string, plain: string): void {
  const all = readSecrets();
  all[name] = encryptSecret(plain);
  writeSecrets(all);
  logger.info("secret.save", { name, inElectron: !!getElectronSafeStorage() });
}

export function getSecret(name: string): string | null {
  const all = readSecrets();
  const enc = all[name];
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch (e) {
    logger.error("secret.decrypt_failed", { name, error: (e as Error).message });
    return null;
  }
}

export function hasSecret(name: string): boolean {
  return !!readSecrets()[name];
}

/**
 * Все секреты в открытом виде — для ЭКСПОРТА настроек в файл (см.
 * server/routes/settings.js → POST /export). Наружу (в API-ответы, логи) этот
 * список не отдаётся: только в скачанный пользователем файл по его запросу.
 */
export function listSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(readSecrets())) {
    const plain = getSecret(name);
    if (plain != null) out[name] = plain;
  }
  return out;
}

/** Имена известных секретов: провайдеры чата + TMDB (для импорта настроек). */
export function allowedSecretNames(): string[] {
  const ids: string[] = [];
  try {
    // Каталог провайдеров — legacy .js: типы тут не нужны, важны только id.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const providers = require("./providers") as { PROVIDERS: { id: string }[] };
    for (const p of providers.PROVIDERS) ids.push(p.id);
  } catch {
    /* без каталога — только tmdb */
  }
  return ids.concat("tmdb");
}
