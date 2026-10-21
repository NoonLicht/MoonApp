/**
 * Каталоги подписей интерфейса «Таблиц» (лента, меню, диалоги) из GridCraft (MIT OR Apache-2.0):
 * crates/ui-egui/src/i18n/<язык>.rs → src/pages/sheet/i18n/cat/<код>.json  { "English": "перевод" }.
 * Каталоги GridCraft написаны «с чистого листа» (без строк Microsoft Excel), поэтому годятся для нашего интерфейса.
 *
 * Запуск: npm run gen:sheetcatalog [-- путь к gridcraft/crates/ui-egui/src/i18n]
 * По умолчанию берётся из ~/.cargo/git/checkouts (там он оказывается после `npm run build:gridcore`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LANGS: Record<string, string> = { ru: "ru" };

function findSource(): string {
  const arg = process.argv[2];
  if (arg) return arg;
  const base = path.join(os.homedir(), ".cargo", "git", "checkouts");
  for (const repo of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    if (!repo.startsWith("gridcraft-")) continue;
    for (const rev of fs.readdirSync(path.join(base, repo))) {
      const dir = path.join(base, repo, rev, "crates", "ui-egui", "src", "i18n");
      if (fs.existsSync(dir)) return dir;
    }
  }
  throw new Error("каталоги GridCraft не найдены: передайте путь первым аргументом");
}

/** Строка Rust-литерала → текст (\n, \t, \", \, \u{…}). */
const unescapeRs = (s: string): string =>
  s.replace(/\\(u\{[0-9a-fA-F]+\}|.)/g, (_m: string, c: string) => {
    if (c.startsWith("u{")) return String.fromCodePoint(parseInt(c.slice(2, -1), 16));
    return c === "n" ? "\n" : c === "t" ? "\t" : c;
  });

const src = findSource();
const out = path.join(process.cwd(), "src", "pages", "sheet", "i18n", "cat");
fs.mkdirSync(out, { recursive: true });
const pair = /^\s*"((?:[^"\\]|\\.)*)"\s*=>\s*"((?:[^"\\]|\\.)*)",?\s*$/;
for (const [code, file] of Object.entries(LANGS)) {
  const map: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(src, `${file}.rs`), "utf8").split(/\r?\n/)) {
    const m = pair.exec(line);
    if (m) map[unescapeRs(m[1])] = unescapeRs(m[2]);
  }
  fs.writeFileSync(path.join(out, `${code}.json`), JSON.stringify(map));
  console.log(code, Object.keys(map).length);
}
