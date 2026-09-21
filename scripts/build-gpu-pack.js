"use strict";

/**
 * Сборка GPU-паков MoonApp (CUDA и TensorRT) из уже подготовленных частей.
 *
 * Зачем: пользователю нужен один архив, внутри которого всё для GPU-пути —
 * свой биндинг onnxruntime-node, CUDA-сборка ONNX Runtime, библиотеки CUDA/cuDNN и
 * (для второй ступени) библиотеки TensorRT. Скачивать CUDA Toolkit, cuDNN и TRT
 * по отдельности он не должен, как и искать их по сайтам NVIDIA.
 *
 * Что делает:
 *   1) собирает каталог пака (`--out/win32-x64`): биндинг + onnxruntime.dll +
 *      провайдеры + библиотеки CUDA/cuDNN (из распакованных колёс PyPI);
 *   2) отдельно готовит вторую ступень: провайдер TensorRT + библиотеки TensorRT;
 *   3) пишет `pack.json` (версии, размеры, sha256 по каждому файлу) — по нему
 *      приложение проверит целостность после скачивания;
 *   4) с `--zip` упаковывает ступени в `moonapp-ort-gpu-cuda12-*.zip` и
 *      `moonapp-ort-gpu-tensorrt12-*.zip` (их и публикуем в `MoonApp-Ort-GPU`).
 *
 * Использование:
 *   node scripts/build-gpu-pack.js \
 *     --binding storage/tmp/ort-gpu/dist \
 *     --cuda    storage/tmp/ort-gpu/wheels-x \
 *     --trt     TensorRT-10.14.1.48 \
 *     --out     storage/ort-gpu --zip
 *
 * Ключи:
 *   --ort <версия>         версия ONNX Runtime в паке (по умолчанию 1.30.0)
 *   --cuda-libs           список имён библиотек CUDA (по умолчанию — нужные ORT)
 *   --trt-arch sm75,...    какие ресурсы сборщика TRT класть (по умолчанию sm75..sm120)
 *   --no-zip               только каталог и pack.json, без архивов
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const BINDING = path.resolve(opt("binding"));
const CUDA = path.resolve(opt("cuda"));
const TRT = path.resolve(opt("trt"));
const OUT = path.resolve(opt("out", path.join("storage", "ort-gpu")));
const ORT_VERSION = opt("ort", "1.30.0");
const TRT_VERSION = (() => {
  const m = path.basename(TRT).match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : "";
})();
const ARCHS = opt("trt-arch", "sm75,sm80,sm86,sm89,sm120").split(",");
// База для ссылок в индексе: архивы по 1,3 ГБ в репозиторий не влезают (лимит
// 100 МБ на файл), поэтому они лежат в релизе, а индекс — в корне репозитория.
// Без --url-base ссылки остаются относительными (индекс и архивы рядом).
const URL_BASE = opt("url-base", "").replace(/\/+$/, "");

const PACK = path.join(OUT, `${process.platform}-${process.arch}`);
const STAGE_TRT = path.join(OUT, "trt-part");
const DIST = path.join(OUT, "dist");

/**
 * Библиотеки CUDA/cuDNN, которые нужны CUDA-провайдеру ORT (по зависимостям DLL).
 *
 * Версия cuDNN фиксирована: 9.14.x — именно с ней TensorRT 10.14.1 (та, что в ORT)
 * проверен в CI ONNX Runtime. Новые cuDNN (9.26) роняют TRT на пустой машине
 * («Cannot load symbol cudnnCreate»), поэтому 9.14 и берём.
 */
const CUDA_LIBS = [
  "cudart64_12.dll",
  "cublas64_12.dll",
  "cublasLt64_12.dll",
  // nvrtc (JIT-компилятор CUDA): без него операции, которых нет в готовых ядрах,
  // уходят на CPU, и каждая пишет в журнал «Could not locate nvrtc64_120_0.dll».
  "nvrtc64_120_0.dll",
  "nvrtc-builtins64_129.dll",
  "cudnn64_9.dll",
  "cudnn_adv64_9.dll",
  "cudnn_cnn64_9.dll",
  "cudnn_engines_precompiled64_9.dll",
  "cudnn_engines_runtime_compiled64_9.dll",
  "cudnn_graph64_9.dll",
  "cudnn_heuristic64_9.dll",
  "cudnn_ops64_9.dll",
];

/** Библиотеки TensorRT, нужные провайдеру (имена с мажором: nvinfer_10 → TRT 10). */
const TRT_LIBS = [
  "nvinfer_10.dll",
  "nvinfer_lean_10.dll",
  "nvinfer_dispatch_10.dll",
  "nvinfer_plugin_10.dll",
  "nvonnxparser_10.dll",
];

/** Рекурсивный поиск файла по имени в дереве (колёса распакованы со своей структурой). */
function findFile(root, name, depth = 6) {
  if (depth < 0 || !fs.existsSync(root)) return "";
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

/** Копирование с подсчётом: возвращает размер и sha256 файла. */
function copyInto(src, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, path.basename(src));
  fs.copyFileSync(src, dst);
  const buf = fs.readFileSync(dst);
  return {
    name: path.basename(dst),
    sizeMb: +(buf.length / 1048576).toFixed(2),
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

/** Проверка входных данных: без них сборка даст «полу-пак» и ложные надежды. */
function preflight() {
  const need = [
    [path.join(BINDING, "onnxruntime_binding.node"), "собранный биндинг"],
    [path.join(BINDING, "onnxruntime.dll"), "onnxruntime.dll из CUDA-сборки ORT"],
    [path.join(BINDING, "onnxruntime_providers_cuda.dll"), "провайдер CUDA"],
    [path.join(BINDING, "onnxruntime_providers_tensorrt.dll"), "провайдер TensorRT"],
    [path.join(BINDING, "onnxruntime_providers_shared.dll"), "общий провайдерный модуль"],
    [CUDA, "распакованные колёса CUDA/cuDNN"],
    [path.join(TRT, "bin"), "библиотеки TensorRT (bin)"],
  ];
  const missing = need.filter(([p]) => !fs.existsSync(p));
  if (missing.length) {
    for (const [p, what] of missing) console.error(`нет ${what}: ${p}`);
    process.exit(2);
  }
  console.log(`ONNX Runtime ${ORT_VERSION} · CUDA 12 · TensorRT ${TRT_VERSION || "?"}`);
}

/** Ступень 1: биндинг + рантайм ORT с CUDA + библиотеки CUDA/cuDNN. */
function stageCuda() {
  const files = [];
  for (const f of fs.readdirSync(BINDING)) {
    // Провайдер TensorRT уходит во вторую ступень: первая ступень — только CUDA.
    if (f === "onnxruntime_providers_tensorrt.dll") continue;
    if (f.endsWith(".dll") || f.endsWith(".node"))
      files.push(copyInto(path.join(BINDING, f), PACK));
  }
  const missed = [];
  for (const name of CUDA_LIBS) {
    const src = findFile(CUDA, name);
    if (!src) {
      missed.push(name);
      continue;
    }
    files.push(copyInto(src, PACK));
  }
  if (missed.length) console.warn(`в колёсах не найдено: ${missed.join(", ")}`);
  return files;
}

/** Ступень 2: провайдер TensorRT и библиотеки TensorRT (включая ресурсы сборщика). */
function stageTrt() {
  const files = [copyInto(path.join(BINDING, "onnxruntime_providers_tensorrt.dll"), STAGE_TRT)];
  const missed = [];
  for (const name of TRT_LIBS) {
    const src = findFile(path.join(TRT, "bin"), name);
    if (src) files.push(copyInto(src, STAGE_TRT));
    else missed.push(name);
  }
  // Ресурсы сборщика нужны при компиляции движка под конкретную архитектуру GPU:
  // sm75 (Turing), sm80/sm86 (Ampere), sm89 (Ada), sm120 (Blackwell). Ресурсы
  // sm90 и PTX не кладём: Hopper в списке поддерживаемых нет, это экономит ~1,1 ГБ.
  for (const arch of ARCHS) {
    const name = `nvinfer_builder_resource_${arch}_10.dll`;
    const src = findFile(path.join(TRT, "bin"), name);
    if (src) files.push(copyInto(src, STAGE_TRT));
    else missed.push(name);
  }
  if (missed.length) console.warn(`в TensorRT не найдено: ${missed.join(", ")}`);
  return files;
}

/** sha256 файла потоком: архивы по 1,3 ГБ в память не берём. */
function sha256Of(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Индекс паков рядом с архивами: именно его читает приложение (`fetchIndex`) и
 * именно его публикуют в репозитории паков. Ссылки — относительные: приложение
 * разворачивает их от адреса индекса, поэтому зеркало работает без правок.
 */
function writeIndex(indexFile, zip1, zip2, trtVersion = TRT_VERSION) {
  const steps = [
    { id: "cuda", title: "CUDA", zip: zip1 },
    { id: "tensorrt", title: "TensorRT", zip: zip2 },
  ].map((s) => ({
    id: s.id,
    title: s.title,
    file: s.zip,
    mb: +(fs.statSync(path.join(DIST, s.zip)).size / 1048576).toFixed(0),
    url: URL_BASE ? `${URL_BASE}/${s.zip}` : s.zip,
    sha256: sha256Of(path.join(DIST, s.zip)),
  }));
  const meta = {
    version: ORT_VERSION,
    ort: ORT_VERSION,
    cuda: "12.9",
    tensorrt: trtVersion,
    requires: "NVIDIA, compute capability 7.5+ (Turing и новее), драйвер 528.33+",
    steps,
  };
  fs.writeFileSync(indexFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`индекс: ${path.relative(ROOT, indexFile)}`);
  for (const s of steps)
    console.log(`  ${s.id}: ${s.file} ${s.mb} МБ sha256:${s.sha256.slice(0, 12)}…`);
}

/** Упаковка каталога в zip средствами системы (bsdtar): >2 ГБ, без загрузки в память. */
function zipDir(dir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  execFileSync("tar", ["-a", "-c", "-f", zipPath, "-C", dir, "."], { stdio: "inherit" });
  return +(fs.statSync(zipPath).size / 1048576).toFixed(1);
}

function main() {
  const name1 = `moonapp-ort-gpu-cuda12-${ORT_VERSION}.zip`;
  const name2 = `moonapp-ort-gpu-tensorrt12-${TRT_VERSION || "x"}.zip`;
  // Пересобрать только индекс (например, ссылки переехали в новый релиз): архивы
  // берутся уже готовыми из каталога `--out/dist`, sha256 считается заново. Имена
  // ищем, а не собираем: версия TensorRT может отличаться от текущего --trt.
  if (flag("index-only")) {
    const zips = fs.existsSync(DIST) ? fs.readdirSync(DIST) : [];
    const cudaZip = zips.find((f) => /^moonapp-ort-gpu-cuda12-.*\.zip$/.test(f));
    const trtZip = zips.find((f) => /^moonapp-ort-gpu-tensorrt12-.*\.zip$/.test(f));
    if (!cudaZip || !trtZip) {
      console.error(`в каталоге ${DIST} нет обоих архивов пака`);
      process.exit(2);
    }
    const trtVer = (trtZip.match(/tensorrt12-([\d.]+)\.zip$/) || [])[1] || TRT_VERSION;
    writeIndex(path.join(DIST, "gpu-packs.json"), cudaZip, trtZip, trtVer);
    return;
  }

  preflight();
  for (const d of [PACK, STAGE_TRT]) fs.rmSync(d, { recursive: true, force: true });

  const step1 = stageCuda();
  const step2 = stageTrt();
  const totalMb = +([...step1, ...step2].reduce((sum, f) => sum + f.sizeMb, 0) || 0).toFixed(1);

  const meta = {
    provider: "cuda+tensorrt",
    version: ORT_VERSION,
    cuda: "12.9",
    tensorrt: TRT_VERSION,
    archs: ARCHS,
    totalMb,
    step1: name1,
    step2: name2,
    files: [...step1, ...step2],
  };
  fs.writeFileSync(path.join(PACK, "pack.json"), `${JSON.stringify(meta, null, 2)}\n`);

  let zip1 = 0;
  let zip2 = 0;
  if (!flag("no-zip")) {
    fs.mkdirSync(DIST, { recursive: true });
    // Первый архив: каталог пака (pack.json + ступень 1). Второй: только ступень 2.
    zip1 = zipDir(PACK, path.join(DIST, name1));
    zip2 = zipDir(STAGE_TRT, path.join(DIST, name2));
    // Индекс кладём рядом с архивами: это ровно тот файл, который читает приложение.
    writeIndex(path.join(DIST, "gpu-packs.json"), name1, name2);
  }

  console.log(`\nкаталог пака: ${path.relative(ROOT, PACK)}`);
  for (const f of step1) console.log(`  ${f.name}  ${f.sizeMb} МБ`);
  console.log(`ступень 2 (TensorRT): ${path.relative(ROOT, STAGE_TRT)}`);
  for (const f of step2) console.log(`  ${f.name}  ${f.sizeMb} МБ`);
  console.log(`итого распаковано: ${totalMb} МБ`);
  if (zip1) console.log(`архивы: ${name1} — ${zip1} МБ, ${name2} — ${zip2} МБ`);
}

main();
