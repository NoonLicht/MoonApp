/**
 * Генератор «вшитых» ключей сборки: server/bundled-keys.js.
 *
 * Зачем: страница «Фильмы и Сериалы» требует ключ TMDB у КАЖДОГО пользователя —
 * установил приложение и сразу упёрся в «ключ не задан». Публиковать ключ в
 * репозитории нельзя (правила TMDB и здравый смысл: ключ в git = ключ у всех),
 * поэтому он кладётся в сборку на этапе упаковки инсталлятора: GitHub Actions
 * передаёт секрет TMDB_API_KEY в переменную окружения, скрипт пишет
 * server/bundled-keys.js, electron-builder упаковывает его в app.asar
 * (см. build.files: server/**\/*), а сам файл в репозиторий не попадает
 * (server/bundled-keys.js в .gitignore).
 *
 * Приоритет ключей остаётся за пользователем: server/ts/tmdb.ts сначала читает
 * зашифрованный секрет (storage/secrets.json, его задают на странице фильмов),
 * и только потом — вшитый ключ. Так свой ключ всегда переопределяет общий.
 *
 * Запуск:
 *   npm run gen:keys                       — взять MOONAPP_TMDB_KEY или TMDB_API_KEY
 *   node scripts/gen-bundled-keys.mjs      — то же самое напрямую
 *
 * Если ключа в окружении нет — файл НЕ создаётся (и старый удаляется): сборка
 * без вшитого ключа ведёт себя как раньше, ничего не падает. Пустой ключ вместо
 * файла сделал бы то же самое, но удаление честнее: видно, что вшивания не было.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "server", "bundled-keys.js");

/**
 * Реестр вшитых ключей: имя в bundled-keys.js -> переменные окружения, откуда
 * его брать (по порядку приоритета). Расширяется добавлением одной строки.
 */
const KEYS = {
  tmdb: ["MOONAPP_TMDB_KEY", "TMDB_API_KEY"],
};

/** Значение из окружения: первый непустой вариант из списка имён. */
function fromEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}const found = {};
for (const [name, sources] of Object.entries(KEYS)) {
  const value = fromEnv(sources);
  if (value) found[name] = value;
}

const names = Object.keys(found);
if (!names.length) {
  // Ключей нет — гарантируем, что в сборку не попал файл от прошлого запуска
  // (например, ключ убрали из секретов, а старый server/bundled-keys.js остался).
  if (fs.existsSync(OUT)) {
    fs.rmSync(OUT);
    console.log("[gen:keys] no keys in env — removed server/bundled-keys.js");
  } else {
    console.log("[gen:keys] no keys in env — nothing to bundle");
  }
  process.exit(0);
}

// Комментарий внутри файла: он попадает и в asar, и в трассировки стека, поэтому
// по нему сразу понятно происхождение ключа (и что это НЕ секрет пользователя).
const header = [
  "/*",
  " * Вшитые в сборку ключи — СГЕНЕРИРОВАННЫЙ ФАЙЛ, править руками нельзя.",
  " * Создан scripts/gen-bundled-keys.mjs при упаковке инсталлятора из секретов",
  " * CI. В репозитории этого файла нет (.gitignore), в релизе он внутри asar.",
  " * Пользовательский секрет (storage/secrets.json) имеет приоритет — см.",
  " * server/ts/tmdb.ts.",
  " */",
  '"use strict";',
  "",
].join("\n");

const body = [
  "module.exports = {",
  ...names.map((name) => `  ${name}: ${JSON.stringify(found[name])},`),
  "};",
  "",
].join("\n");

fs.writeFileSync(OUT, header + body, "utf8");
console.log(`[gen:keys] bundled ${names.join(", ")} -> server/bundled-keys.js`);