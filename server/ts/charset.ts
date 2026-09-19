/**
 * Кодировки рунет-форумов.
 *
 * Зачем отдельный модуль: phpBB-форумы (rutracker.org и совместимые) отдают
 * страницы и принимают формы в windows-1251. Со стороны Node:
 *  - ДЕКОДИРОВАНИЕ работает штатно: `new TextDecoder("windows-1251")` (полный ICU
 *    есть и в Electron, и в обычном Node 18+), но мы не полагаемся на ICU — своя
 *    таблица даёт одинаковый результат в тестах, в standalone-сервере и в сборке;
 *  - КОДИРОВАНИЕ не поддерживается ничем в стандартной библиотеке: `TextEncoder`
 *    умеет только UTF-8, а `iconv-lite` в проекте нет как зависимости (он
 *    приезжает транзитивно с express/electron-builder — полагаться на него нельзя).
 *    Поэтому таблица windows-1251 (0x80–0xFF) объявлена здесь явно, и по ней
 *    строится обратное отображение «символ → байт» для тел POST-форм и параметров
 *    поиска (rutracker ждёт `nm=<поиск>` именно в cp1251).
 *
 * Модуль чистый (без сети/БД) — покрыт tests/charset.test.ts.
 *
 * TS-исходник, как server/ts/torrent.ts: компилируется в server/charset.js
 * командой `npm run compile:server`.
 */

/**
 * Символы windows-1251 для байтов 0x80–0xFF (128 позиций).
 * 0x98 в этой кодовой странице не определён — оставлен управляющий U+0098,
 * 0xA0 — неразрывный пробел, 0xAD — мягкий перенос (записаны escape-последовательностями,
 *  чтобы в исходнике не было невидимых символов).
 */
const CP1251_HIGH =
  "\u0402\u0403\u201a\u0453\u201e\u2026\u2020\u2021\u20ac\u2030\u0409\u2039\u040a\u040c\u040b\u040f" +
  "\u0452\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u0098\u2122\u0459\u203a\u045a\u045c\u045b\u045f" +
  "\u00a0\u040e\u045e\u0408\u00a4\u0490\u00a6\u00a7\u0401\u00a9\u0404\u00ab\u00ac\u00ad\u00ae\u0407" +
  "\u00b0\u00b1\u0406\u0456\u0491\u00b5\u00b6\u00b7\u0451\u2116\u0454\u00bb\u0458\u0405\u0455\u0457" +
  "\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f" +
  "\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f" +
  "\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f" +
  "\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f";

/** Символ → байт (для cp1251). Первое вхождение выигрывает (дублей нет). */
const CP1251_TO_BYTE = new Map<string, number>();
Array.from(CP1251_HIGH).forEach((ch, i) => {
  if (!CP1251_TO_BYTE.has(ch)) CP1251_TO_BYTE.set(ch, 0x80 + i);
});

/** Символ → байт для байтов 0x00–0x7F (ASCII, совпадает с Unicode). */
const BYTE_OF_ASCII = (code: number): number | null => (code >= 0 && code < 0x80 ? code : null);

/** Нормализованный ярлык кодировки: "windows-1251" | "utf-8" | <как передали>. */
export function normCharset(charset: unknown): string {
  const c = String(charset || "")
    .trim()
    .toLowerCase();
  if (!c) return "windows-1251";
  if (/^(utf-?8|utf8)$/.test(c)) return "utf-8";
  if (/^(windows-?1251|cp-?1251|win-?1251|windows1251|cp1251)$/.test(c)) return "windows-1251";
  return c;
}

/** Единичный символ cp1251 по байту (0x00–0xFF). */
function cp1251Char(byte: number): string {
  if (byte < 0x80) return String.fromCharCode(byte);
  return CP1251_HIGH[byte - 0x80] || "\uFFFD";
}

/** Байты cp1251 → строка Unicode (без зависимости от ICU). */
export function decodeCp1251(buf: Buffer | Uint8Array): string {
  const bytes = buf instanceof Buffer ? buf : Buffer.from(buf);
  let out = "";
  // Чанками — так длинные страницы декодируются без раздувания строки на каждый байт.
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    let part = "";
    for (let j = i; j < end; j++) part += cp1251Char(bytes[j]);
    out += part;
  }
  return out;
}

/**
 * Буфер ответа → текст. Кодировку берём из настроек парсера (обычно
 * windows-1251). Для UTF-8 — быстрый путь Buffer.toString; для неизвестных
 * ярлыков пробуем TextDecoder, а если и он не знает — считаем UTF-8.
 */
export function decodeBytes(buf: Buffer, charset: unknown = "windows-1251"): string {
  const c = normCharset(charset);
  if (c === "utf-8") return buf.toString("utf8");
  if (c === "windows-1251") return decodeCp1251(buf);
  try {
    return new TextDecoder(c).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/** Строка → байты в нужной кодировке (для тел POST-форм). */
export function toBytes(text: string, charset: unknown = "windows-1251"): Buffer {
  const c = normCharset(charset);
  if (c === "utf-8") return Buffer.from(text, "utf8");
  if (c !== "windows-1251") {
    // Неизвестную кодировку не выдумываем: шлём UTF-8 (сервер ответит ошибкой,
    // это честнее, чем портить байты).
    return Buffer.from(text, "utf8");
  }
  const out = Buffer.alloc(Math.max(1, text.length));
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const ascii = BYTE_OF_ASCII(code);
    if (ascii != null) {
      out[n++] = ascii;
      continue;
    }
    const b = CP1251_TO_BYTE.get(ch);
    // Символа нет в cp1251 (эмодзи и т.п.) → "?".
    out[n++] = b === undefined ? 0x3f : b;
  }
  return out.subarray(0, n);
}

/** Байты строки в cp1251 (короткая форма toBytes для тестов и роутов). */
export function encodeCp1251(text: string): Buffer {
  return toBytes(text, "windows-1251");
}

/** Байт можно не экранировать в application/x-www-form-urlencoded. */
function isUnreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2d || // -
    byte === 0x5f || // _
    byte === 0x2e || // .
    byte === 0x7e // ~
  );
}

/**
 * Процентное кодирование строки в её собственной кодировке.
 * Для cp1251 «ё» превращается в %B8, а не в %D1%91 (как было бы в UTF-8) —
 * именно этого ждёт phpBB-поиск.
 */
export function pctEncode(
  text: string,
  charset: unknown = "windows-1251",
  spaceAsPlus = true,
): string {
  const bytes = toBytes(text, charset);
  let out = "";
  for (const b of bytes) {
    if (isUnreserved(b)) out += String.fromCharCode(b);
    else if (b === 0x20 && spaceAsPlus) out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Тело формы: { поле: значение } → "a=1&b=%C2%EE%E9%ED%E0" (в кодировке форума). */
export function formEncode(
  fields: Record<string, string | number | undefined | null>,
  charset: unknown = "windows-1251",
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    parts.push(`${pctEncode(k, charset)}=${pctEncode(String(v), charset)}`);
  }
  return parts.join("&");
}

/**
 * HTML-сущности → символы. Нужны и для cp1251-страниц: phpBB часть текста
 * отдаёт числовыми сущностями (`&#1055;`), а также `&quot;`, `&amp;`.
 */
export function decodeEntities(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(?:#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, " "); // прочие именованные сущности
}

/** Тег в пробел, чтобы соседние ячейки не слипались («Название1.5 GB»). */
export function stripTags(html: unknown): string {
  return decodeEntities(
    String(html == null ? "" : html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
