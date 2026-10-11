/**
 * Самоподписанный сертификат для HTTPS веб-компаньона.
 *
 * Зачем: браузер телефона отдаёт камеру странице только в «безопасном контексте»
 * (HTTPS или localhost), а компаньон по умолчанию работает по обычному HTTP в
 * локальной сети. Для режима веб-камеры поднимается второй, HTTPS-порт с таким
 * сертификатом: телефон один раз показывает предупреждение, после «продолжить»
 * камера доступна.
 *
 * Без внешних зависимостей: ключ EC P-256 создаёт node:crypto, а X.509 v3
 * собирается вручную (DER) и подписывается ECDSA-SHA256.
 */
import crypto from "crypto";

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const oid = (...bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.from([0]), b);

/** Время UTCTime: YYMMDDHHMMSSZ (годы до 2049 включительно). */
function utcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "ascii"));
}

const OID_ECDSA_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const OID_CN = oid(0x55, 0x04, 0x03);

function ipBytes(ip: string): Buffer | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return Buffer.from(parts);
}

const pem = (label: string, der: Buffer): string =>
  `-----BEGIN ${label}-----\n${(der.toString("base64").match(/.{1,64}/g) || []).join("\n")}\n-----END ${label}-----\n`;

export interface SelfSigned {
  key: string;
  cert: string;
  ips: string[];
  notAfter: number;
}

/** Сертификат на 800 дней для перечисленных IPv4-адресов и localhost. */
export function makeSelfSigned(ips: string[], now = new Date()): SelfSigned {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // положительное число
  if (serial[0] === 0) serial[0] = 1;

  const name = seq(set(seq(OID_CN, utf8("MoonApp Companion"))));
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime() + 800 * 24 * 3600 * 1000);

  const ipList = [...new Set(ips)].filter((ip) => ipBytes(ip));
  const san = seq(
    tlv(0x82, Buffer.from("localhost", "ascii")),
    ...ipList.map((ip) => tlv(0x87, ipBytes(ip) as Buffer)),
  );
  const extensions = tlv(
    0xa3,
    seq(
      seq(oid(0x55, 0x1d, 0x11), octets(san)),
      seq(oid(0x55, 0x1d, 0x25), octets(seq(oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)))),
    ),
  );

  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // версия v3
    tlv(0x02, serial),
    seq(OID_ECDSA_SHA256),
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    extensions,
  );
  const signature = crypto.sign("sha256", tbs, privateKey); // DER ECDSA
  const cert = seq(tbs, seq(OID_ECDSA_SHA256), bitString(signature));

  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: pem("CERTIFICATE", cert),
    ips: ipList,
    notAfter: notAfter.getTime(),
  };
}
