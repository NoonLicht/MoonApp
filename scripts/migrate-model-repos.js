#!/usr/bin/env node
"use strict";

/**
 * Фаза 3: переезд моделей из трёх репозиториев в один (`MoonApp-ONNX`).
 *
 * Раскладка в новом репозитории:
 *   upscale/<файл>   — апскейлеры (мелкие, ссылка raw/main)
 *   interp/<файл>    — интерполяторы кадров
 *   релиз <tag>      — файлы крупнее 100 МБ (в git GitHub их не пустит, поэтому
 *                      только ассетами релиза: сейчас это cain.onnx на 164 МБ)
 *
 * Запуск:
 *   node scripts/migrate-model-repos.js                  # показать, что изменится
 *   node scripts/migrate-model-repos.js --check          # проверить новые ссылки (HEAD)
 *   node scripts/migrate-model-repos.js --write          # записать в манифест
 *
 * Флаги: --repo NoonLicht/MoonApp-ONNX, --branch main, --tag models-1,
 *        --manifest server/models.manifest.json
 */

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, def) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const REPO = val("repo", "NoonLicht/MoonApp-ONNX");
const BRANCH = val("branch", "main");
const TAG = val("tag", "models-1");
const FILE = val("manifest", "server/models.manifest.json");
/** Предел файла в git GitHub: больше — только ассетом релиза. */
const LIMIT_MB = 100;

/** Старая ссылка на наши модели (её и меняем; чужие адреса не трогаем). */
const OLD_URL = /^https:\/\/github\.com\/NoonLicht\/MoonApp-[A-Za-z]+-ONNX\//;

/** Папка в новом репозитории по виду модели. */
function folder(kind) {
  return kind === "interp" ? "interp" : "upscale";
}

/** Новый адрес: ассет релиза для крупных, raw/main — для остальных. */
function newUrl(model, sizeMb) {
  const dir = folder(model.kind);
  if (sizeMb > LIMIT_MB) {
    return `https://github.com/${REPO}/releases/download/${TAG}/${model.file}`;
  }
  return `https://github.com/${REPO}/raw/${BRANCH}/${dir}/${model.file}`;
}

/** Размер файла в манифесте (`sizeMb`) — по нему решаем, тянет ли git. */
function sizeOf(model) {
  return Math.round(Number(model.sizeMb || 0));
}

async function head(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return `${res.status}${res.ok ? "" : ` ${res.statusText}`}`;
  } catch (e) {
    return `ошибка: ${e.message}`;
  }
}

(async () => {
  const file = path.resolve(FILE);
  const raw = fs.readFileSync(file, "utf8");
  const doc = JSON.parse(raw);
  const models = doc.models || doc;

  const moves = [];
  for (const m of models) {
    const url = String(m.url || "");
    if (!OLD_URL.test(url)) continue;
    const next = newUrl(m, sizeOf(m));
    if (next !== url) {
      moves.push({
        id: m.id,
        file: m.file,
        sizeMb: sizeOf(m),
        dir: folder(m.kind),
        from: url,
        to: next,
        release: next.includes("/releases/"),
      });
    }
  }

  if (!moves.length) {
    console.log("Нечего менять: ссылок на старые репозитории MoonApp-*-ONNX в манифесте нет.");
    return;
  }

  console.log(`Новый репозиторий: ${REPO} (ветка ${BRANCH}, релиз ${TAG})`);
  for (const mv of moves) {
    const where = mv.release ? `АССЕТ РЕЛИЗА ${TAG}` : `${mv.dir}/ в ветке ${BRANCH}`;
    console.log(
      `\n  ${mv.id} (${mv.sizeMb} МБ, ${where}):\n    было: ${mv.from}\n    будет: ${mv.to}`,
    );
  }
  const over = moves.filter((m) => m.release).length;
  console.log(
    `\nИтого: ${moves.length} ссылок, из них крупных (только ассетом релиза) — ${over}.` +
      `\nАпскейлеры кладём в upscale/, интерполяторы — в interp/.`,
  );

  if (has("check")) {
    console.log("\nПроверка новых ссылок (HEAD):");
    for (const mv of moves) console.log(`  ${await head(mv.to)} ← ${mv.id}`);
  }

  if (!has("write")) {
    console.log("\nЭто примерка. Записать в манифест: --write");
    return;
  }

  let out = raw;
  for (const mv of moves) {
    if (!out.includes(mv.from)) throw new Error(`адрес не найден в манифесте: ${mv.from}`);
    out = out.replace(mv.from, mv.to);
  }
  fs.writeFileSync(file, out);
  console.log(`\nЗаписано: ${path.relative(process.cwd(), file)}`);
})().catch((e) => {
  console.error(`ОШИБКА: ${e.message}`);
  process.exit(1);
});
