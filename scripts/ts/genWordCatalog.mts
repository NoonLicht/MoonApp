/**
 * Каталоги подписей интерфейса Word (лента, меню, диалоги) из WordCraft (MIT OR Apache-2.0):
 * crates/ui-egui/src/i18n/<язык>.tsv → src/pages/word/i18n/cat/<код>.json  { "English": "перевод" }.
 * Каталоги WordCraft написаны «с чистого листа» (без строк Microsoft Word), поэтому годятся для нашего интерфейса.
 *
 * Запуск: npm run gen:wordcatalog [-- путь к wordcraft/crates/ui-egui/src/i18n]
 * По умолчанию берётся из ~/.cargo/git/checkouts (там он оказывается после `npm run build:wordcore`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LANGS = { ru: "ru" };

function findSource() {
  const arg = process.argv[2];
  if (arg) return arg;
  const base = path.join(os.homedir(), ".cargo", "git", "checkouts");
  for (const repo of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    if (!repo.startsWith("wordcraft-")) continue;
    for (const rev of fs.readdirSync(path.join(base, repo))) {
      const dir = path.join(base, repo, rev, "crates", "ui-egui", "src", "i18n");
      if (fs.existsSync(dir)) return dir;
    }
  }
  throw new Error("каталоги WordCraft не найдены: передайте путь первым аргументом");
}

const unescape = (s: string): string =>
  s.replace(/\\([nt\\])/g, (_m: string, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"));

const src = findSource();
const out = path.join(process.cwd(), "src", "pages", "word", "i18n", "cat");
fs.mkdirSync(out, { recursive: true });
for (const [code, file] of Object.entries(LANGS)) {
  const map: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(src, `${file}.tsv`), "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [ctx, from, to] = line.split("\t");
    if (ctx || !from || !to) continue; // записи с контекстом — только для плиток предпросмотра
    map[unescape(from)] = unescape(to);
  }
  fs.writeFileSync(path.join(out, `${code}.json`), JSON.stringify(map));
  console.log(code, Object.keys(map).length);
}
