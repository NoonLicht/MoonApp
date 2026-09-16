/**
 * Поиск «мойбейка» — текста, испорченного неверной кодировкой.
 *
 * Поводом стал реальный дефект: в src/pages/SettingsPage.tsx (28 строк) и
 * src/styles/ui.css (14 строк) русский текст и символы вроде «⚠» были записаны
 * как результат чтения UTF-8 как CP1251 — в UI печатался мусор. Линтер это почти
 * не ловит (только NBSP правилом no-irregular-whitespace), поэтому нужен сканер.
 *
 * Детекция алгоритмическая, без списка маркеров: строку пробуем прочитать как
 * UTF-8-байты, ошибочно сохранённые в CP1251. Если получается валидный UTF-8 —
 * это мойбейк. Легитимная кириллица при обратном преобразовании даёт невалидные
 * последовательности, поэтому ложных срабатываний нет.
 *
 * Запуск:
 *   npm run scan:mojibake                  — файлы и число испорченных строк
 *   node scripts/mojibakeScan.mjs --list   — ещё и номера строк
 *
 * Вывод намеренно ASCII-only: консоль Windows иначе искажает кириллицу, и
 * отличить мойбейк от проблем терминала невозможно. Код возврата 1 при
 * находках — годится как гейт в CI.
 */
import fs from "node:fs";
import path from "node:path";

/* Обратная карта CP1251: символ -> байт. Строим через декодер ICU, чтобы не
   держать таблицу из 128 строк руками. */
const BYTE_OF = new Map();
{
  const dec = new TextDecoder("windows-1251");
  for (let b = 0x80; b <= 0xff; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (ch.length === 1 && !BYTE_OF.has(ch)) BYTE_OF.set(ch, b);
  }
}

/** Пробуем прочитать строку как UTF-8-байты, ошибочно сохранённые в CP1251. */
function tryRestore(s) {
  const bytes = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else {
      const b = BYTE_OF.get(ch);
      if (b === undefined) return null;
      bytes.push(b);
    }
  }
  const out = Buffer.from(bytes).toString("utf8");
  if (out.includes("\uFFFD")) return null;
  return out;
}

const hasNonAscii = (s) => /[^\x00-\x7F]/.test(s);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "storage",
  "coverage",
  "vendor",
  "engines",
]);
const EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".md",
  ".html",
  ".yml",
  ".yaml",
  ".py",
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), out);
    } else if (EXTS.has(path.extname(e.name))) {
      // Сам сканер содержит обратную карту CP1251 и не может себя не находить.
      if (e.name === "mojibakeScan.mjs") continue;
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const report = [];

for (const file of walk(ROOT)) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    if (!hasNonAscii(lines[i])) continue;
    if (tryRestore(lines[i]) !== null) bad.push(i + 1);
  }
  if (bad.length) report.push({ rel: path.relative(ROOT, file).replace(/\\/g, "/"), bad });
}

report.sort((a, b) => b.bad.length - a.bad.length);
for (const r of report) {
  console.log(`${r.rel}: ${r.bad.length} line(s)`);
  if (args.has("--list")) console.log(`  at: ${r.bad.join(", ")}`);
}
const total = report.reduce((n, r) => n + r.bad.length, 0);
console.log(`\nfiles=${report.length} lines=${total}`);
process.exit(total ? 1 : 0);
