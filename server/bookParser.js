"use strict";

/**
 * Универсальный парсер книг: .epub, .fb2, .fb2.zip, .pdf, .mobi, .rtf, .txt.
 *
 * Как это работает:
 *  - Формат определяется по расширению + магическим байтам (zip → epub/fb2.zip).
 *  - .epub: adm-zip распаковывает, контент идёт по spine (OPF), HTML очищается.
 *  - .fb2: XML body → секции с <title> (главы) и <p> (абзацы).
 *  - .pdf: pdf-parse (ленивый require, чтобы не валить сервер если не стоит).
 *  - .mobi: бинарь PalmDB — извлекаем HTML-поток записей и чистим теги.
 *  - .rtf: срез управляющих групп {\...} и \code, Unicode \'XXXX.
 *  - .txt: автоопределение кодировки (UTF-8 / BOM / cp1251 / cp866 эвристикой).
 *
 * Результат: { title, author, coverImage (base64|null), chapters: [{ title, text }] }
 * Текст проходит «умную чистку»: сноски, мягкие переносы, URL, кавычки «…»,
 * починка слов, разорванных переносом строки (сло-\nво → слово).
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

/* --------------------- Кодировки (.txt) --------------------- */

const CP1251_HIGH = "абвгдежзийклмнопрстуфхцчшщъыьэюя";
const CP866_HIGH = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";

function safeIconv() {
  try { return require("iconv-lite"); } catch { return null; }
}
function cp1251Char(code) {
  const map = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";
  const idx = code - 0xc0;
  return idx >= 0 && idx < map.length ? map[idx] : "";
}
function cp866Char(code) {
  const upper = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
  const lower = "абвгдежзийклмнопрстуфхцчшщъыьэюя";
  if (code >= 0x80 && code <= 0xaf) return upper[code - 0x80];
  if (code >= 0xe0 && code <= 0xef) return lower[code - 0xe0];
  return "";
}

// Эвристика: валидный UTF-8 → приоритет. Иначе сравниваем старшие байты
// с частотностью cp1251/cp866.
function detectDecode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString("utf8"), encoding: "utf-8-sig" };
  }
  let nonAscii = 0, utf8Valid = true, high = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    nonAscii++; high++;
    if (b >= 0xc2 && b <= 0xdf) {
      if (i + 1 < buf.length && buf[i + 1] >= 0x80 && buf[i + 1] <= 0xbf) { i++; continue; }
      utf8Valid = false;
    } else if (b >= 0xe0 && b <= 0xef) {
      if (i + 2 < buf.length && buf[i + 1] >= 0x80 && buf[i + 1] <= 0xbf && buf[i + 2] >= 0x80 && buf[i + 2] <= 0xbf) { i += 2; continue; }
      utf8Valid = false;
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (i + 3 < buf.length && buf[i + 1] >= 0x80 && buf[i + 1] <= 0xbf && buf[i + 2] >= 0x80 && buf[i + 2] <= 0xbf && buf[i + 3] >= 0x80 && buf[i + 3] <= 0xbf) { i += 3; continue; }
      utf8Valid = false;
    } else {
      utf8Valid = false;
    }
  }
  if (nonAscii === 0) return { text: buf.toString("ascii"), encoding: "ascii" };
  if (utf8Valid && high >= nonAscii * 0.9) return { text: buf.toString("utf8"), encoding: "utf-8" };
  const scores = { cp1251: 0, cp866: 0 };
  const str = buf.toString("latin1");
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) continue;
    if (CP1251_HIGH.includes(cp1251Char(code))) scores.cp1251++;
    if (CP866_HIGH.includes(cp866Char(code))) scores.cp866++;
  }
  const enc = scores.cp866 > scores.cp1251 ? "cp866" : "cp1251";
  const iconv = safeIconv();
  if (iconv) {
    try { return { text: iconv.decode(buf, enc), encoding: enc }; } catch { /* фолбэк */ }
  }
  return { text: buf.toString("utf8"), encoding: `${enc}(fallback-utf8)` };
}

/* --------------------- HTML → текст --------------------- */

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])[^>]*>/gi, "\n\n## ")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/(p|div|li|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&laquo;/g, "«").replace(/&raquo;/g, "»");
}

/* --------------------- Умная чистка текста --------------------- */

function cleanText(raw) {
  let t = String(raw || "");
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Мягкие переносы и починка разорванных слов (сло-\nво → слово)
  t = t.replace(/\u00AD/g, "");
  t = t.replace(/(\p{L})-\n(\p{L})/gu, "$1$2");
  // Сноски и примечания
  t = t.replace(/\[\d{1,3}\]/g, "").replace(/\(см\.\s*прим\.[^)]*\)/gi, "");
  // URL
  t = t.replace(/https?:\/\/\S+/g, "");
  // Кавычки → «ёлочки», тире → em-dash
  t = t.replace(/“([^”]*)”/g, "«$1»").replace(/"([^"\n]{1,400})"/g, "«$1»");
  t = t.replace(/(^|[\s(])--(?=\s)/g, "$1—");
  // Мусорные пробелы
  t = t.replace(/[ \t]+/g, " ").replace(/\u00A0/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/* --------------------- Форматы: EPUB --------------------- */

function parseEpub(buf) {
  const zip = new AdmZip(buf);
  let opfPath = "";
  const container = zip.getEntry("META-INF/container.xml");
  if (container) {
    const m = container.getData().toString("utf8").match(/full-path="([^"]+)"/);
    if (m) opfPath = m[1];
  }
  const meta = { title: "", author: "", coverId: "" };
  const items = {};
  const spineIds = [];
  if (opfPath) {
    const opf = zip.getEntry(opfPath);
    if (opf) {
      const xml = opf.getData().toString("utf8");
      meta.title = (xml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/) || [])[1]?.trim() || "";
      meta.author = (xml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/) || [])[1]?.trim() || "";
      const coverM = xml.match(/<meta[^>]*name="cover"[^>]*content="([^"]+)"/);
      if (coverM) meta.coverId = coverM[1];
      const baseDir = path.posix.dirname(opfPath);
      for (const it of xml.matchAll(/<item\b[^>]*>/g)) {
        const id = (it[0].match(/id="([^"]+)"/) || [])[1];
        const href = (it[0].match(/href="([^"]+)"/) || [])[1];
        if (id && href) items[id] = { href: baseDir !== "." ? `${baseDir}/${href}` : href };
      }
      const spineM = xml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/);
      if (spineM) for (const r of spineM[1].matchAll(/<itemref[^>]*idref="([^"]+)"/g)) spineIds.push(r[1]);
    }
  }
  const chapters = [];
  const order = spineIds.length
    ? spineIds.map((id) => items[id]).filter(Boolean)
    : zip.getEntries().filter((e) => /\.x?html?$/i.test(e.entryName)).map((e) => e.entryName);
  for (const item of order) {
    const entry = zip.getEntry(item.href || item);
    if (!entry) continue;
    const html = entry.getData().toString("utf8");
    const hM = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const title = hM ? htmlToText(hM[1]).trim() : `Глава ${chapters.length + 1}`;
    const text = cleanText(htmlToText(html));
    if (text) chapters.push({ title, text });
  }
  let coverImage = null;
  if (meta.coverId && items[meta.coverId]) {
    const ce = zip.getEntry(items[meta.coverId].href);
    if (ce) coverImage = `data:image/jpeg;base64,${ce.getData().toString("base64")}`;
  }
  return { title: meta.title, author: meta.author, coverImage, chapters };
}

/* --------------------- Форматы: FB2 / FB2.ZIP --------------------- */

function parseFb2(buf) {
  let xml = buf.toString("utf8");
  if (!/<fictionbook/i.test(xml) && buf[0] === 0x50 && buf[1] === 0x4b) {
    try {
      const zip = new AdmZip(buf);
      const e = zip.getEntries().find((x) => /\.fb2$/i.test(x.entryName));
      if (e) xml = e.getData().toString("utf8");
    } catch { /* не zip — оставляем как есть */ }
  }
  const titleInfo = xml.match(/<title-info>([\s\S]*?)<\/title-info>/);
  const bookTitle = titleInfo ? (titleInfo[1].match(/<book-title>([\s\S]*?)<\/book-title>/) || [])[1]?.trim() : "";
  const first = titleInfo ? (titleInfo[1].match(/<first-name>([\s\S]*?)<\/first-name>/) || [])[1]?.trim() || "" : "";
  const last = titleInfo ? (titleInfo[1].match(/<last-name>([\s\S]*?)<\/last-name>/) || [])[1]?.trim() || "" : "";
  let coverImage = null;
  const bin = xml.match(/<binary[^>]*content-type="image\/[^"]+"[^>]*>([\s\S]*?)<\/binary>/);
  if (bin) coverImage = `data:image/jpeg;base64,${bin[1].replace(/\s+/g, "")}`;
  const chapters = [];
  const sectionRe = /<section[^>]*>([\s\S]*?)<\/section>/g;
  let m, count = 0;
  while ((m = sectionRe.exec(xml)) !== null && count < 500) {
    count++;
    const body = m[1];
    const tM = body.match(/<title>([\s\S]*?)<\/title>/);
    const title = tM ? cleanText(htmlToText(tM[1])) : `Глава ${chapters.length + 1}`;
    const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((p) => p[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    const text = cleanText(paras.join("\n"));
    if (text) chapters.push({ title, text });
  }
  if (!chapters.length) {
    const paras = [...xml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((p) => p[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    if (paras.length) chapters.push({ title: bookTitle || "Книга", text: cleanText(paras.join("\n")) });
  }
  return { title: bookTitle, author: `${first} ${last}`.trim(), coverImage, chapters };
}

/* --------------------- Форматы: PDF / MOBI / RTF / TXT --------------------- */

async function parsePdf(buf) {
  // require из lib — у pdf-parse обычный index при require читает дебаг-тест.
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");
  const data = await pdfParse(buf);
  const text = cleanText(data.text || "");
  const title = (data.info?.Title || "").trim();
  return {
    title,
    author: (data.info?.Author || "").trim(),
    coverImage: null,
    chapters: text ? [{ title: title || "PDF", text }] : [],
  };
}

function parseMobi(buf) {
  const raw = buf.toString("latin1");
  const htmlStart = raw.search(/<html[\s>]/i);
  const htmlEnd = raw.lastIndexOf("</html>");
  let html = htmlStart >= 0 ? raw.slice(htmlStart, htmlEnd > htmlStart ? htmlEnd + 7 : undefined) : "";
  if (!html) html = raw.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u0400-\u04FF]/g, "");
  const text = cleanText(htmlToText(html));
  return {
    title: "",
    author: "",
    coverImage: null,
    chapters: text ? [{ title: "MOBI", text }] : [],
  };
}

function parseRtf(buf) {
  let t = buf.toString("latin1");
  t = t.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/\{\\\*[^{}]*\}/g, "");
  t = t.replace(/\\par[d]?/g, "\n").replace(/\\line/g, "\n");
  t = t.replace(/\\u(-?\d+)\s?\??/g, (_, d) => String.fromCharCode(((Number(d) + 65536) % 65536)));
  t = t.replace(/\\[a-z]+-?\d*\s?/gi, "");
  t = t.replace(/[{}]/g, "");
  const text = cleanText(t);
  return { title: "", author: "", coverImage: null, chapters: text ? [{ title: "RTF", text }] : [] };
}

function parseTxt(buf) {
  const { text, encoding } = detectDecode(buf);
  const cleaned = cleanText(text);
  // Главы .txt: «Глава N», «ГЛАВА N», «Часть N» и т.п.
  const lines = cleaned.split("\n");
  const chapters = [];
  let cur = { title: "", lines: [] };
  const chapterRe = /^(глава|часть|chapter|part)\s+([0-9IVXL]+|[а-яё]+)\b.*$/i;
  const flush = () => {
    const t2 = cleanText(cur.lines.join("\n"));
    if (t2) chapters.push({ title: cur.title || `Часть ${chapters.length + 1}`, text: t2 });
  };
  for (const line of lines) {
    if (chapterRe.test(line.trim()) && line.trim().length < 80) {
      flush();
      cur = { title: line.trim(), lines: [] };
    } else cur.lines.push(line);
  }
  flush();
  return {
    title: "", author: "", coverImage: null,
    chapters: chapters.length ? chapters : [{ title: "Книга", text: cleaned }],
    encoding,
  };
}

/* --------------------- Главная точка входа --------------------- */

async function parseBook(filePath, originalName) {
  const buf = fs.readFileSync(filePath);
  const name = String(originalName || path.basename(filePath)).toLowerCase();
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  let result;
  if (/\.epub$/.test(name) || (isZip && /\.epub/.test(name))) result = parseEpub(buf);
  else if (/\.fb2(\.zip)?$/.test(name) || (isZip && /\.fb2/.test(name))) result = parseFb2(buf);
  else if (/\.pdf$/.test(name) || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) result = await parsePdf(buf);
  else if (/\.mobi$|\.azw3?$/.test(name) || buf.slice(60, 68).toString("latin1") === "BOOKMOBI") result = parseMobi(buf);
  else if (/\.rtf$/.test(name) || buf.slice(0, 5).toString("latin1") === "{\\rtf") result = parseRtf(buf);
  else result = parseTxt(buf);
  if (!result.title) result.title = path.basename(originalName || filePath, path.extname(originalName || filePath));
  result.format = path.extname(name).replace(".", "") || "txt";
  return result;
}

module.exports = { parseBook, cleanText, detectDecode, htmlToText };




