"use strict";

/**
 * Получение библиотек CUDA/cuDNN для GPU-пака из колёс PyPI (без CUDA Toolkit).
 *
 * Зачем: для пака нужны ровно несколько DLL — `cudart64_12`, `cublas64_12`,
 * `cublasLt64_12` и набор cuDNN 9. Колёса NVIDIA содержат именно их, скачиваются
 * как zip и не требуют установки CUDA Toolkit (3+ ГБ и установщик).
 *
 * Версии зафиксированы осознанно:
 *   - CUDA 12.9 — ветка, с которой собирают Windows-сборки ONNX Runtime 1.30 (cuda12);
 *   - cuDNN 9.14 — версия из CI ONNX Runtime рядом с TensorRT 10.14.1. Новые cuDNN
 *     (9.26) роняют TRT на пустой машине: «Cannot load symbol cudnnCreate».
 *
 * Использование:
 *   node scripts/fetch-cuda-libs.js --out storage/tmp/ort-gpu/libs
 *
 * Результат: распакованные DLL в `--out` (плоским списком) — этот каталог
 * передаётся в `scripts/build-gpu-pack.js --cuda <out>`.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const opt = (name, def = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const OUT = path.resolve(opt("out", path.join("storage", "tmp", "ort-gpu", "libs")));
// Кэш колёс можно переиспользовать между сборками: он большой (1,2 ГБ).
const CACHE = path.resolve(opt("cache", path.join(OUT, ".wheels")));

/** Что скачиваем: колёса с фиксированными версиями и что берём из каждого. */
const PINS = [
  {
    pkg: "nvidia-cuda-runtime-cu12",
    version: "12.9.79",
    libs: ["cudart64_12.dll"],
  },
  {
    pkg: "nvidia-cublas-cu12",
    version: "12.9.2.10",
    libs: ["cublas64_12.dll", "cublasLt64_12.dll"],
  },
  {
    // nvrtc — JIT-компилятор CUDA-провайдера: без него операции, которых нет в
    // готовых ядрах (например редкие Resize/Resample в новых графах), уходят на
    // CPU, а в журнал летит «Could not locate nvrtc64_120_0.dll» на каждую из них.
    // Имя builtins-файла содержит версию CUDA-серии (12.9 → 129).
    pkg: "nvidia-cuda-nvrtc-cu12",
    version: "12.9.86",
    libs: ["nvrtc64_120_0.dll", "nvrtc-builtins64_129.dll"],
  },
  {
    pkg: "nvidia-cudnn-cu12",
    version: "9.14.0.64",
    libs: [
      "cudnn64_9.dll",
      "cudnn_adv64_9.dll",
      "cudnn_cnn64_9.dll",
      "cudnn_engines_precompiled64_9.dll",
      "cudnn_engines_runtime_compiled64_9.dll",
      "cudnn_graph64_9.dll",
      "cudnn_heuristic64_9.dll",
      "cudnn_ops64_9.dll",
    ],
  },
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "user-agent": "moonapp-gpu-pack" } }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error(`не JSON: ${url}`));
          }
        });
      })
      .on("error", reject);
  });
}

/** Скачивание с редким прогрессом: файлы по 0,5–0,7 ГБ, полезно видеть ход. */
function download(url, file) {
  return new Promise((resolve, reject) => {
    const tmp = `${file}.part`;
    const ws = fs.createWriteStream(tmp);
    https
      .get(url, { headers: { "user-agent": "moonapp-gpu-pack" } }, (r) => {
        if (r.statusCode !== 200) {
          reject(new Error(`HTTP ${r.statusCode}: ${url}`));
          return;
        }
        const total = Number(r.headers["content-length"] || 0);
        let got = 0;
        let mark = 0;
        r.on("data", (c) => {
          got += c.length;
          if (got - mark > 128 * 1048576) {
            mark = got;
            console.log(`  … ${path.basename(file)} ${(got / 1048576).toFixed(0)} МБ`);
          }
        });
        r.pipe(ws);
        ws.on("finish", () => {
          fs.renameSync(tmp, file);
          resolve(total);
        });
      })
      .on("error", reject);
  });
}

/** Рекурсивный поиск файла по имени (структура внутри колеса своя). */
function findFile(root, name, depth = 6) {
  if (depth < 0) return "";
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name, depth - 1);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return "";
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  const missing = [];
  for (const pin of PINS) {
    const meta = await getJson(`https://pypi.org/pypi/${pin.pkg}/json`);
    const file = (meta.releases[pin.version] || []).find((f) => f.filename.includes("win_amd64"));
    if (!file) throw new Error(`${pin.pkg} ${pin.version}: нет файла для win_amd64`);
    const whl = path.join(CACHE, file.filename);
    if (!fs.existsSync(whl)) {
      console.log(`${pin.pkg} ${pin.version}: ${(file.size / 1048576).toFixed(0)} МБ`);
      await download(file.url, whl);
    }
    // Распаковываем рядом (один раз): bsdtar понимает whl как zip.
    const dir = path.join(CACHE, path.basename(whl, ".whl"));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync("tar", ["-x", "-f", whl, "-C", dir], { stdio: "inherit" });
    }
    for (const lib of pin.libs) {
      const src = findFile(dir, lib);
      if (!src) {
        missing.push(`${pin.pkg}: ${lib}`);
        continue;
      }
      fs.copyFileSync(src, path.join(OUT, lib));
    }
  }
  const have = fs.readdirSync(OUT).filter((f) => f.endsWith(".dll"));
  console.log(`\nготово: ${path.relative(ROOT, OUT)} — ${have.length} DLL`);
  for (const f of have.sort()) {
    console.log(`  ${f}  ${(fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1)} МБ`);
  }
  if (missing.length) {
    console.error(`\nне найдено: ${missing.join(", ")}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(`ОШИБКА: ${e.message}`);
  process.exit(1);
});
