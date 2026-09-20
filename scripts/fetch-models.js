"use strict";

/**
 * Загрузка ONNX-моделей апскейла из server/models.manifest.json в
 * storage/models/upscale (или MOONAPP_STORAGE/models/upscale).
 *
 * Зачем отдельный скрипт, а не бандл моделей в инсталлятор: модели весят
 * десятки мегабайт каждая, а нужна пользователю обычно одна-две — поэтому
 * качаем по требованию (как yt-dlp/sing-box/whisper через scripts/fetch-*.js).
 *
 * Использование:
 *   node scripts/fetch-models.js              — скачать все модели с непустым url
 *   node scripts/fetch-models.js --id <id>    — только одну
 *   node scripts/fetch-models.js --list       — показать каталог и статус
 *   node scripts/fetch-models.js --kind upscale|interp — только апскейлеры
 *                                               или только интерполяторы кадров
 *   node scripts/fetch-models.js --id <id> --url <URL> — задать адрес на лету
 *
 * Файл, который уже скачан (и совпал по sha256, если он задан), не качается
 * повторно. Запись идёт в .part и переименовывается только после успеха.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Каталог берём тем же резолвером, что сервер: скачанный манифест (storage)
// важнее вшитого в репозиторий — см. scripts/manifest.js.
const { manifestFile, storageDir } = require("./manifest");

/** Каталог моделей: тот же приоритет, что у server/config.js (storage). */
function modelsDir() {
  return path.join(storageDir(), "models", "upscale");
}

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Скачивание с прогрессом: модель может весить десятки мегабайт. */
async function download(url, dest, sizeMb) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length") || 0) || sizeMb * 1024 * 1024;
  const part = dest + ".part";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(part);
  let got = 0;
  let lastPct = -1;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once("drain", r));
      }
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r  ${pct}% (${(got / 1048576).toFixed(1)} МБ)`);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  process.stdout.write("\n");
  fs.renameSync(part, dest);
  return got;
}

async function ensureModel(model, dir, force) {
  const dest = path.join(dir, model.file);
  if (!force && fs.existsSync(dest)) {
    if (!model.sha256) {
      console.log(`= ${model.id}: уже скачан`);
      return true;
    }
    if (sha256(dest) === model.sha256) {
      console.log(`= ${model.id}: уже скачан (sha256 совпал)`);
      return true;
    }
    console.log(`! ${model.id}: sha256 не совпал — перекачиваю`);
  }
  if (!model.url) {
    console.log(`- ${model.id}: адрес не задан (--url <URL> или правка манифеста)`);
    return false;
  }
  console.log(`↓ ${model.id}: ${model.url}`);
  const bytes = await download(model.url, dest, model.sizeMb || 0);
  if (model.sha256) {
    const got = sha256(dest);
    if (got !== model.sha256) {
      fs.rmSync(dest, { force: true });
      throw new Error(`${model.id}: sha256 не совпал после загрузки`);
    }
  }
  console.log(`  готово: ${dest} (${(bytes / 1048576).toFixed(1)} МБ)`);
  return true;
}

async function main() {
  const manifest = readManifest();
  const dir = modelsDir();
  fs.mkdirSync(dir, { recursive: true });

  const kind = argValue("--kind");
  if (kind && !["upscale", "interp", "all"].includes(kind)) {
    throw new Error(`--kind принимает upscale | interp | all (получено "${kind}")`);
  }
  const byKind = (m) => (m.kind === "interp" ? "interp" : "upscale");

  if (process.argv.includes("--list")) {
    console.log(`каталог моделей: ${dir}`);
    // Показываем, откуда взят список: скачанный из GitHub или вшитый в сборку.
    console.log(`манифест: ${manifestFile()}`);
    const list =
      kind && kind !== "all" ? manifest.models.filter((m) => byKind(m) === kind) : manifest.models;
    for (const m of list) {
      const file = path.join(dir, m.file);
      const has = fs.existsSync(file);
      const size = has ? `, ${(fs.statSync(file).size / 1048576).toFixed(1)} МБ` : "";
      // Апскейлеры показываем множителем, интерполяторы — «+кадры» и схемой.
      const what =
        byKind(m) === "interp"
          ? `+${m.mult || 2}x кадров · ${m.inputSig || "?"}${size}`
          : `x${m.scale}${size}`;
      console.log(`  ${has ? "✓" : "·"} [${byKind(m)}] ${m.id} — ${m.label} (${what})`);
    }
    return;
  }

  const only = argValue("--id");
  const overrideUrl = argValue("--url");
  const force = process.argv.includes("--force");

  let models = manifest.models;
  if (kind && kind !== "all") models = models.filter((m) => byKind(m) === kind);
  if (only) {
    models = models.filter((m) => m.id === only);
    if (!models.length) throw new Error(`нет модели с id=${only}`);
    if (overrideUrl) models = models.map((m) => ({ ...m, url: overrideUrl }));
  }
  if (!models.length) throw new Error("манифест не содержит подходящих моделей");

  let ok = 0;
  for (const m of models) {
    try {
      if (await ensureModel(m, dir, force)) ok++;
    } catch (e) {
      console.error(`  ошибка ${m.id}: ${e.message}`);
    }
  }
  console.log(`\nготово: ${ok}/${models.length}`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
