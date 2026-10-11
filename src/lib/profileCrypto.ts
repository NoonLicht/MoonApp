/**
 * Зашифрованный профиль: настройки (вместе с ключами API) в одном файле,
 * защищённом паролем. Шифрование выполняется целиком в браузере (WebCrypto):
 * PBKDF2-SHA256 (310 000 итераций) → AES-256-GCM. Пароль нигде не хранится;
 * потерянный пароль восстановить нельзя.
 *
 * Формат файла — JSON: { app, kind, v, kdf, iter, salt, iv, data } (base64).
 */

export const PROFILE_KIND = "moonapp-encrypted-profile";
const ITER = 310_000;

interface Envelope {
  app: "MoonApp";
  kind: typeof PROFILE_KIND;
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  salt: string;
  iv: string;
  data: string;
}

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptProfile(plain: string, password: string, iter = ITER): Promise<string> {
  if (password.length < 6) throw new Error("password_too_short");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iter);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const env: Envelope = {
    app: "MoonApp",
    kind: PROFILE_KIND,
    v: 1,
    kdf: "PBKDF2-SHA256",
    iter,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(data),
  };
  return JSON.stringify(env);
}

export function isEncryptedProfile(text: string): boolean {
  try {
    return JSON.parse(text)?.kind === PROFILE_KIND;
  } catch {
    return false;
  }
}

/** Расшифровывает файл профиля; при неверном пароле или повреждении — ошибка wrong_password_or_corrupted. */
export async function decryptProfile(file: string, password: string): Promise<string> {
  let env: Envelope;
  try {
    env = JSON.parse(file);
  } catch {
    throw new Error("not_a_profile");
  }
  if (env?.kind !== PROFILE_KIND || env.v !== 1) throw new Error("not_a_profile");
  // защита от файла с гигантским числом итераций (зависание вкладки)
  if (!(env.iter >= 1000 && env.iter <= 2_000_000)) throw new Error("not_a_profile");
  try {
    const key = await deriveKey(password, unb64(env.salt), env.iter);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("wrong_password_or_corrupted");
  }
}
