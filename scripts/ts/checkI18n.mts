/**
 * Проверка полноты локализации — гейт для CI (`npm run check:i18n`).
 *
 * 1. Словари src/i18n/*.json: у каждого языка ровно тот же набор ключей, что
 *    у en.json (эталон), без лишних и без пропущенных; плейсхолдеры {name}
 *    совпадают — иначе перевод молча теряет подставляемые значения.
 * 2. Исходники src/**\/*.ts(x): строковые литералы и текст JSX с кириллицей —
 *    это непереведённый интерфейс (у англоязычного пользователя он остаётся
 *    русским). Разбор через TypeScript AST, поэтому комментарии не считаются.
 *    Вызовы console.* / logger.* и RegExp пропускаются.
 *
 * Исключения (данные, а не интерфейс): файлы из IGNORE_FILES, строки с комментарием
 * `// i18n-ignore` (на той же или на предыдущей строке) и блоки между
 * `// i18n-ignore-start` и `// i18n-ignore-end`.
 *
 * Запуск:
 *   npm run check:i18n             — сводка, код 1 при проблемах
 *   node scripts/checkI18n.mjs --list   — ещё и полный перечень находок
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const ROOT = process.cwd();
const I18N_DIR = path.join(ROOT, "src", "i18n");
const LIST = process.argv.includes("--list");

/** Файлы, где кириллица — данные: словари распознавания дат, названия языков. */
const IGNORE_FILES = [
  /^src\/i18n\//,
  /^src\/pages\/myspace\/parts\/TasksDateParser\.ts$/,
  // M3E-редактор — отдельный инструмент с собственным переключателем ru/en и
  // двуязычными словарями (m3e/lib/i18n.ts); он же генерирует промпты для ИИ.
  /^src\/pages\/myspace\/m3e\//,
  // Названия языков пишутся на самих языках.
  /^src\/app\/i18n\.tsx$/,
];

type Dict = Record<string, unknown>;

function flatten(obj: Dict, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    if (k === "_meta") continue;
    const key = prefix + k;
    if (v && typeof v === "object") flatten(v as Dict, key + ".", out);
    else out.set(key, String(v));
  }
  return out;
}

const placeholders = (s: string): string =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

let problems = 0;

// ---------- 1. словари ----------
const langs = fs
  .readdirSync(I18N_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5));
const dicts = new Map(
  langs.map((l) => [
    l,
    flatten(JSON.parse(fs.readFileSync(path.join(I18N_DIR, l + ".json"), "utf8")) as Dict),
  ]),
);
const base = dicts.get("en");
if (!base) throw new Error("src/i18n/en.json не найден");

for (const [lang, dict] of dicts) {
  if (lang === "en") continue;
  const missing = [...base.keys()].filter((k) => !dict.has(k));
  const extra = [...dict.keys()].filter((k) => !base.has(k));
  const badPh = [...base.keys()].filter(
    (k) => dict.has(k) && placeholders(dict.get(k)!) !== placeholders(base.get(k)!),
  );
  const n = missing.length + extra.length + badPh.length;
  problems += n;
  console.log(
    `${lang}: ${dict.size}/${base.size} keys` +
      (n ? `, missing ${missing.length}, extra ${extra.length}, placeholders ${badPh.length}` : ", OK"),
  );
  if (LIST) {
    for (const k of missing) console.log(`  missing      ${k}`);
    for (const k of extra) console.log(`  extra        ${k}`);
    for (const k of badPh) console.log(`  placeholders ${k}`);
  }
}

// ---------- 2. кириллица в исходниках ----------
const CYR = /[А-Яа-яЁё]/;
const files = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.tsx?$/.test(f) && !IGNORE_FILES.some((re) => re.test(f)));

const found: string[] = [];
for (const file of files) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!CYR.test(src)) continue;
  const lines = src.split("\n");
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const regions: boolean[] = [];
  let inRegion = false;
  lines.forEach((l, i) => {
    if (/i18n-ignore-start/.test(l)) inRegion = true;
    regions[i] = inRegion;
    if (/i18n-ignore-end/.test(l)) inRegion = false;
  });
  const ignored = (line: number): boolean =>
    !!regions[line] ||
    /i18n-ignore/.test(lines[line] ?? "") ||
    /^\s*\/\/\s*i18n-ignore/.test(lines[line - 1] ?? "");
  const inSkippedCall = (n: ts.Node): boolean => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        const callee = p.expression.getText(sf);
        if (/^(console|logger)\.|RegExp$/.test(callee)) return true;
      }
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    const isText =
      ts.isJsxText(n) ||
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n);
    if (isText && CYR.test(n.getText(sf))) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      if (!ignored(line) && !inSkippedCall(n)) found.push(`${file}:${line + 1}`);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
problems += found.length;
console.log(`source: ${found.length} hard-coded Cyrillic string(s) in UI code`);
if (LIST || found.length <= 30) for (const f of found) console.log(`  ${f}`);

if (problems) {
  console.log(`\ni18n check failed: ${problems} problem(s). Run with --list for details.`);
  process.exit(1);
}
console.log("i18n check passed");
