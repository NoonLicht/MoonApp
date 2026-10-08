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

// ВНИМАНИЕ: раньше здесь был захардкоженный литерал "dev-master-key-not-for-prod"
// как постоянный резервный ключ (не только dev-заглушка на случай отсутствия
// settings) — а исходники публичны на GitHub, то есть любой мог им
// расшифровать чужой storage/secrets.json или password-vault.json, если
// приложение когда-либо шифровало данные не через safeStorage (Electron/DPAPI),
// а этим AES-резервом (standalone-запуск, тесты, ранний старт). Теперь это
// используется ТОЛЬКО для миграции уже существующих данных на новый случайный
// ключ (см. reencryptIfLegacy/migrateLegacySecrets ниже) — для шифрования
// новых данных больше не применяется никогда.
const LEGACY_DEV_KEY_DO_NOT_USE_FOR_ENCRYPTION = "dev-master-key-not-for-prod";

function getMasterKey(): Buffer {
  // Приоритет: env-переменная → мастер-ключ из настроек (advanced.masterKey,
  // при первом обращении генерируется случайно и сохраняется — см. ниже).
  const fromEnv = process.env.MOONAPP_MASTER_KEY;
  if (fromEnv) return crypto.createHash("sha256").update(fromEnv).digest();
  try {
    // Динамический require: на раннем старте settings может быть не готов.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require("./settings") as { get(key: string): any; set(patch: any): any };
    const adv = settings.get("advanced") || {};
    let key = String(adv.masterKey || "").trim();
    if (!key) {
      // Первое обращение без заданного ключа (standalone-запуск без Electron/
      // safeStorage) — генерируем случайный и сохраняем НАВСЕГДА в settings.json,
      // а не берём предсказуемый литерал из открытого кода.
      key = crypto.randomBytes(32).toString("hex");
      settings.set({ advanced: { masterKey: key } });
    }
    return crypto.createHash("sha256").update(key).digest();
  } catch {
    /* settings совсем недоступен (сверхранний старт) — временный резерв ниже,
       НЕ постоянное состояние: как только settings поднимется, следующий же
       вызов сгенерирует и сохранит настоящий случайный ключ. */
  }
  return crypto.createHash("sha256").update(LEGACY_DEV_KEY_DO_NOT_USE_FOR_ENCRYPTION).digest();
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

export function encryptSecret(plain: string): string {
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

/** Расшифровка СТАРЫМ захардкоженным ключом — только для миграции ниже,
 *  никогда для обычного decryptSecret. */
function legacyAesDecrypt(token: string): string | null {
  try {
    const key = crypto
      .createHash("sha256")
      .update(LEGACY_DEV_KEY_DO_NOT_USE_FOR_ENCRYPTION)
      .digest();
    const [ivB, tagB, dataB] = token.split(".");
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null; // не тот ключ (уже перешифровано/safeStorage) — не легаси, пропускаем
  }
}

/**
 * Если токен зашифрован СТАРЫМ захардкоженным резервным ключом — расшифровывает
 * им и перешифровывает текущим (случайным/safeStorage) путём. Иначе — null
 * (нечего мигрировать, уже безопасно). Используется и для secrets.json
 * (migrateLegacySecrets ниже), и для password-vault.json
 * (server/ts/passwordVault.ts → migrateLegacyEncryption).
 */
export function reencryptIfLegacy(token: string): string | null {
  if (!token.startsWith("__aes__")) return null;
  const plain = legacyAesDecrypt(token.slice(7));
  if (plain == null) return null;
  return encryptSecret(plain);
}

/**
 * Разовая (по факту — идемпотентная, безопасно гонять при каждом старте)
 * миграция секретов провайдеров/TMDB со старого захардкоженного ключа
 * (см. LEGACY_DEV_KEY_DO_NOT_USE_FOR_ENCRYPTION) на текущий. Вызывается из
 * server/ts/index.ts при старте.
 */
export function migrateLegacySecrets(): number {
  const all = readSecrets();
  let changed = 0;
  for (const name of Object.keys(all)) {
    const next = reencryptIfLegacy(all[name]);
    if (next == null) continue;
    all[name] = next;
    changed++;
  }
  if (changed) {
    writeSecrets(all);
    logger.info("security.migrate_legacy_secrets", { changed });
  }
  return changed;
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

/** Локальные провайдеры без ключа: вместо секрета возвращается метка. */
const KEYLESS = new Set(["llamacpp"]);

export function getSecret(name: string): string | null {
  if (KEYLESS.has(name)) return "local";
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
  if (KEYLESS.has(name)) return true;
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
