/**
 * Аватарки контактов. По умолчанию — буквы на цветном фоне (рисует интерфейс). В режиме
 * «Gravatar» картинку получает сервер приложения и кэширует на диске: адрес контакта уходит
 * на gravatar.com только в виде хеша и не раскрывает IP окна приложения напрямую.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "../config";
import { getSettings } from "./mailSettings";

const { DIRS } = config;
const NEG_TTL = 7 * 86_400_000;
const dir = (): string => {
  const d = path.join(DIRS.storage, "mail-avatars");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export async function avatarFor(address: string): Promise<{ type: string; data: Buffer } | null> {
  if (getSettings().appearance.avatars !== "gravatar") return null;
  const a = address.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(a)) return null;
  const hash = crypto.createHash("md5").update(a).digest("hex");
  const file = path.join(dir(), `${hash}.img`);
  const none = path.join(dir(), `${hash}.none`);
  try {
    const st = fs.statSync(file);
    if (st.isFile()) return { type: "image/jpeg", data: fs.readFileSync(file) };
  } catch {
    /* нет в кэше */
  }
  try {
    const st = fs.statSync(none);
    if (Date.now() - st.mtimeMs < NEG_TTL) return null;
  } catch {
    /* нет отметки «нет аватара» */
  }
  try {
    const res = await fetch(`https://www.gravatar.com/avatar/${hash}?s=96&d=404`);
    if (!res.ok) {
      fs.writeFileSync(none, "");
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, data);
    return { type: res.headers.get("content-type") || "image/jpeg", data };
  } catch {
    return null;
  }
}
