#!/usr/bin/env node
"use strict";

/**
 * Сборка движков TensorRT для всех скачанных моделей апскейла.
 *
 * Движок компилируется под конкретный GPU и профиль (тайл из каталога), дальше
 * грузится из кэша за доли секунды. После сборки ONNX у моделей ≤64 МБ убирается
 * с диска (движок всё равно требует граф лишь при старте сессии — он скачается сам).
 *
 * Запуск:
 *   node scripts/build-all-engines.js                     # все модели с файлом
 *   node scripts/build-all-engines.js --only remacri,nmkd-siax
 *   node scripts/build-all-engines.js --skip cain --limit 10
 *
 * Отчёт: storage/tmp/trt-engines.md (таблица «модель → движок, время, размер»).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const engine = require(path.join(ROOT, "server", "upscale.js"));
const REPORT = path.join(ROOT, "storage", "tmp", "trt-engines.md");

const argv = process.argv.slice(2);
const val = (name, def = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

(async () => {
  if (!engine.supportedBackends().includes("tensorrt")) {
    throw new Error("в этой сборке ONNX Runtime нет провайдера TensorRT");
  }
  const only = val("only")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const skip = val("skip")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = Number(val("limit", "0")) || 0;

  let list = engine
    .listModels()
    .filter((m) => m.kind === "upscale" && m.available && m.provider !== "cpu");
  if (only.length) list = list.filter((m) => only.includes(m.id));
  if (skip.length) list = list.filter((m) => !skip.includes(m.id));
  if (limit > 0) list = list.slice(0, limit);

  console.log(`Моделей к сборке: ${list.length}`);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(
    REPORT,
    "| модель | кратность | профиль | движок | МБ | сборка | источник |\n" +
      "| --- | --- | --- | --- | --- | --- | --- |\n",
    "utf8",
  );

  let ok = 0;
  let failed = 0;
  let freedTotal = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const tile = m.rec.tile || 0;
    process.stdout.write(`[${i + 1}/${list.length}] ${m.id} (тайл ${tile || "модель"})… `);
    try {
      const r = await engine.buildTrtEngine(m.id, { tile });
      freedTotal += r.onnxFreedMb || 0;
      if (r.reused) {
        console.log(`уже собран (${r.engine})`);
      } else {
        console.log(`собран за ${(r.ms / 1000).toFixed(1)} с → ${r.engine} (${r.engineMb} МБ)`);
      }
      ok++;
      fs.appendFileSync(
        REPORT,
        `| ${m.label} | ×${m.scale} | ${r.profile} | ${r.engine.replace(/\/[^/]+$/, "/…")} | ` +
          `${r.engineMb} | ${(r.ms / 1000).toFixed(1)} с${r.reused ? " (кэш)" : ""} | ONNX −${r.onnxFreedMb} МБ |\n`,
        "utf8",
      );
    } catch (e) {
      failed++;
      console.log(`ОШИБКА: ${String(e.message || e).slice(0, 160)}`);
      fs.appendFileSync(
        REPORT,
        `| ${m.label} | ×${m.scale} | ${tile} | — | — | ошибка: ${String(e.message || e).slice(0, 80)} | — |\n`,
        "utf8",
      );
    }
  }
  engine.clearSessions();
  console.log(`\nГотово: собрано ${ok}, ошибок ${failed}, освобождено ${freedTotal} МБ`);
  console.log(`Отчёт: ${path.relative(ROOT, REPORT)}`);
  process.exit(0);
})().catch((e) => {
  console.error(`ОШИБКА: ${e.message}`);
  process.exit(1);
});
