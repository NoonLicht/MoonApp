const crypto = require("crypto");
const fs = require("fs");
const { FILES } = require("./config");
const logger = require("./logger");

// Секреты шифруются. Внутри Electron используется safeStorage (на Windows это
// DPAPI — шифрование под учёткой, без пароля). Без Electron — фолбэк на AES-256-GCM с мастер-ключом.
function getElectronSafeStorage() {
  try {
    return require("electron")?.safeStorage || null;
  } catch {
    return null;
  }
}

function getMasterKey() {
  // Приоритет: env-переменная → мастер-ключ из настроек (advanced.masterKey) →
  // dev-ключ (только для standalone-запуска без Electron, небезопасно!).
  const fromEnv = process.env.MOONAPP_MASTER_KEY;
  if (fromEnv) return crypto.createHash("sha256").update(fromEnv).digest();
  try {
    const fromSettings = String(require("./settings").get("advanced").masterKey || "").trim();
    if (fromSettings) return crypto.createHash("sha256").update(fromSettings).digest();
  } catch { /* settings может быть недоступен на раннем старте — идём в dev-ключ */ }
  return crypto.createHash("sha256").update("dev-master-key-not-for-prod").digest();
}

const ALGO = "aes-256-gcm";

function aesEncrypt(plain) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

function aesDecrypt(token) {
  const key = getMasterKey();
  const [ivB, tagB, dataB] = token.split(".");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
}

function encryptSecret(plain) {
  const ss = getElectronSafeStorage();
  if (ss && ss.isEncryptionAvailable()) {
    return "__ss__" + ss.encryptString(plain).toString("base64");
  }
  return "__aes__" + aesEncrypt(plain);
}

function decryptSecret(token) {
  if (typeof token !== "string") throw new Error("invalid secret");
  const ss = getElectronSafeStorage();
  if (token.startsWith("__ss__") && ss) {
    return ss.decryptString(Buffer.from(token.slice(6), "base64"));
  }
  if (token.startsWith("__aes__")) return aesDecrypt(token.slice(7));
  throw new Error("unknown secret format");
}

// secrets.json — тут зашифрованные ключи API: { providerName: "<encrypted>", ... }
function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(FILES.secrets, "utf8"));
  } catch {
    return {};
  }
}

function writeSecrets(obj) {
  fs.writeFileSync(FILES.secrets, JSON.stringify(obj, null, 2), "utf8");
}

function setSecret(name, plain) {
  const all = readSecrets();
  all[name] = encryptSecret(plain);
  writeSecrets(all);
  logger.info("secret.save", { name, inElectron: !!getElectronSafeStorage() });
}

function getSecret(name) {
  const all = readSecrets();
  const enc = all[name];
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch (e) {
    logger.error("secret.decrypt_failed", { name, error: e.message });
    return null;
  }
}

function hasSecret(name) {
  return !!readSecrets()[name];
}

/**
 * Все секреты в открытом виде — для ЭКСПОРТА настроек в файл (см.
 * server/routes/settings.js → POST /export). Наружу (в API-ответы, логи) этот
 * список не отдаётся: только в скачанный пользователем файл по его запросу.
 */
function listSecrets() {
  const out = {};
  for (const name of Object.keys(readSecrets())) {
    const plain = getSecret(name);
    if (plain != null) out[name] = plain;
  }
  return out;
}

/** Имена известных секретов: провайдеры чата + TMDB (для импорта настроек). */
function allowedSecretNames() {
  const ids = [];
  try { for (const p of require("./providers").PROVIDERS) ids.push(p.id); } catch { /* без каталога — только tmdb */ }
  return ids.concat("tmdb");
}

module.exports = {
  setSecret, getSecret, hasSecret, decryptSecret,
  listSecrets, allowedSecretNames,
};