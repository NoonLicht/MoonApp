"use strict";

/**
 * Сборка НАСТОЯЩЕГО бинарника onnxruntime-node с провайдерами CUDA/TensorRT.
 *
 * Зачем: npm-пакет `onnxruntime-node` собран без CUDA/TensorRT — в его биндинге
 * список провайдеров жёстко зашит (`cpu`, `dml`, `webgpu`), а провайдерные DLL
 * кладутся только в CUDA-сборку ONNX Runtime. Поэтому GPU-путь требует своей
 * сборки биндинга из исходников ONNX Runtime (`js/node`) против CUDA-сборки ORT.
 *
 * Что делает:
 *   1) проверяет дерево исходников (`js/node`, `include/onnxruntime`, VERSION_NUMBER);
 *   2) связывает `js/node/node_modules` с каталогом инструментов (cmake-js, node-addon-api);
 *   3) конфигурирует CMake с `USE_CUDA=ON`/`USE_TENSORRT=ON` и релизной сборкой ORT;
 *   4) собирает биндинг и складывает результат в `--out`
 *      (`onnxruntime_binding.node` + `onnxruntime.dll` + провайдерные DLL).
 *
 * Использование:
 *   node scripts/build-ort-gpu-binding.js \
 *     --src   storage/tmp/ort-src \
 *     --runtime storage/tmp/ort-gpu/cuda12/<архив>/lib \
 *     --tools storage/tmp/ort-gpu/buildtools \
 *     --out   storage/tmp/ort-gpu/dist
 *
 * Ключи:
 *   --config  Release|RelWithDebInfo|Debug      (по умолчанию RelWithDebInfo)
 *   --no-cuda, --no-tensorrt                    выключить провайдер
 *   --clean                                     снести build и bin перед сборкой
 *   --cmake <путь к cmake.exe>                  если cmake не в PATH
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const CONFIG = opt("config", "RelWithDebInfo");
if (!["Release", "RelWithDebInfo", "Debug"].includes(CONFIG)) {
  console.error(`неизвестная конфигурация: ${CONFIG}`);
  process.exit(2);
}

const SRC = path.resolve(opt("src", path.join("storage", "tmp", "ort-src")));
const RUNTIME = path.resolve(opt("runtime", path.join("storage", "tmp", "ort-gpu", "runtime")));
const TOOLS = path.resolve(opt("tools", path.join("storage", "tmp", "ort-gpu", "buildtools")));
const OUT = path.resolve(opt("out", path.join("storage", "tmp", "ort-gpu", "dist")));
const WANT_CUDA = !flag("no-cuda");
const WANT_TRT = !flag("no-tensorrt");

/** Папка инструментов: оттуда берём cmake-js и node-addon-api. */
const TOOLS_MODULES = path.join(TOOLS, "node_modules");
const CMAKEJS = path.join(TOOLS_MODULES, "cmake-js", "bin", "cmake-js");
const JS_NODE = path.join(SRC, "js", "node");
const DIST = path.join(JS_NODE, "bin", "napi-v6", "win32", "x64");

/** Проверка входных данных: без них сборка упадёт непонятной ошибкой CMake. */
function preflight() {
  const need = [
    [path.join(JS_NODE, "CMakeLists.txt"), "исходники биндинга (js/node)"],
    [path.join(SRC, "VERSION_NUMBER"), "VERSION_NUMBER ONNX Runtime"],
    [
      path.join(SRC, "include", "onnxruntime", "core", "session", "onnxruntime_cxx_api.h"),
      "заголовки ORT",
    ],
    [
      path.join(
        SRC,
        "include",
        "onnxruntime",
        "core",
        "providers",
        "cuda",
        "cuda_provider_options.h",
      ),
      "заголовки CUDA-провайдера",
    ],
    [
      path.join(SRC, "onnxruntime", "core", "framework", "arena_extend_strategy.h"),
      "внутренние заголовки ORT (onnxruntime/core/framework)",
    ],
    [path.join(RUNTIME, "onnxruntime.lib"), "onnxruntime.lib релизной сборки ORT"],
    [path.join(RUNTIME, "onnxruntime.dll"), "onnxruntime.dll релизной сборки ORT"],
    [CMAKEJS, "cmake-js"],
    [path.join(TOOLS_MODULES, "node-addon-api"), "node-addon-api"],
  ];
  const missing = need.filter(([p]) => !fs.existsSync(p));
  if (missing.length) {
    for (const [p, what] of missing) console.error(`нет ${what}: ${p}`);
    process.exit(2);
  }
  const ver = fs.readFileSync(path.join(SRC, "VERSION_NUMBER"), "utf8").trim();
  const on = `${WANT_CUDA ? "CUDA " : ""}${WANT_TRT ? "TensorRT" : ""}`.trim() || "только CPU";
  console.log(`ONNX Runtime ${ver}, конфигурация ${CONFIG}, провайдеры: ${on}`);
}

/**
 * Патч биндинга: прокинуть опции провайдера TensorRT в ONNX Runtime.
 *
 * Зачем: стоковый `session_options_helper.cc` для провайдера `tensorrt` передаёт
 * только `device_id`, а остальное (`trt_fp16_enable`, кэш движка, профили формы)
 * молча игнорируется — TRT собирает движок с настройками по умолчанию, кэш не
 * пишется, и каждое новое окно приложения снова тратит на сборку минуты.
 *
 * Патч идемпотентный: если он уже применён, ничего не делаем.
 */
function patchTrtOptionsSource(src) {
  const file = path.join(src, "js", "node", "src", "session_options_helper.cc");
  if (!fs.existsSync(file)) throw new Error(`нет файла биндинга: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("MOONAPP_TRT_OPTIONS")) return "патч уже применён";
  // Исходники ORT лежат с CRLF: сравниваем с тем же переводом строк.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const norm = (s) => s.split("\n").join(eol);

  /** Три вставки: объявление карты опций, их сбор рядом с объектом и передача в TRT. */
  const edits = [
    // 1. Карта опций TRT — рядом с остальными объявлениями цикла.
    [
      `#ifdef USE_QNN
    std::unordered_map<std::string, std::string> qnn_options;
#endif`,
      `#ifdef USE_QNN
    std::unordered_map<std::string, std::string> qnn_options;
#endif
#ifdef USE_TENSORRT
    // MOONAPP_TRT_OPTIONS: сюда собираем опции провайдера TensorRT.
    std::unordered_map<std::string, std::string> trt_options;
#endif`,
    ],
    // 2. Сбор опций там, где виден объект провайдера.
    [
      `      name = obj.Get("name").As<Napi::String>().Utf8Value();
      if (obj.Has("deviceId")) {`,
      `      name = obj.Get("name").As<Napi::String>().Utf8Value();
#ifdef USE_TENSORRT
      // MOONAPP_TRT_OPTIONS: сток отдавал в TRT только deviceId, из-за чего fp16,
      // кэш движка и профили формы молча игнорировались. Собираем ключи здесь:
      // объект опций доступен только в этой ветке.
      if (name == "tensorrt") {
        static const std::vector<std::string> MOONAPP_TRT_KEYS = {
            "trt_fp16_enable",
            "trt_engine_cache_enable",
            "trt_engine_cache_path",
            "trt_timing_cache_enable",
            "trt_timing_cache_path",
            "trt_builder_optimization_level",
            "trt_max_workspace_size",
            "trt_profile_min_shapes",
            "trt_profile_opt_shapes",
            "trt_profile_max_shapes",
        };
        for (const auto& key : MOONAPP_TRT_KEYS) {
          Napi::Value v = obj.Get(key);
          if (v.IsUndefined()) continue;
          if (v.IsBoolean()) {
            trt_options[key] = v.As<Napi::Boolean>().Value() ? "1" : "0";
          } else if (v.IsNumber()) {
            trt_options[key] = std::to_string(v.As<Napi::Number>().Int64Value());
          } else if (v.IsString()) {
            trt_options[key] = v.As<Napi::String>().Utf8Value();
          }
        }
      }
#endif
      if (obj.Has("deviceId")) {`,
    ],
    // 3. Передача собранных опций в ORT (имена ключей — как в C API).
    [
      `      OrtTensorRTProviderOptionsV2* options;
      Ort::ThrowOnError(Ort::GetApi().CreateTensorRTProviderOptions(&options));
      options->device_id = deviceId;
      sessionOptions.AppendExecutionProvider_TensorRT_V2(*options);`,
      `      OrtTensorRTProviderOptionsV2* options;
      Ort::ThrowOnError(Ort::GetApi().CreateTensorRTProviderOptions(&options));
      options->device_id = deviceId;
      std::vector<const char*> moKeys;
      std::vector<const char*> moValuePtrs;
      moKeys.reserve(trt_options.size());
      moValuePtrs.reserve(trt_options.size());
      for (const auto& kv : trt_options) {
        moKeys.push_back(kv.first.c_str());
        moValuePtrs.push_back(kv.second.c_str());
      }
      if (!moKeys.empty()) {
        Ort::ThrowOnError(Ort::GetApi().UpdateTensorRTProviderOptions(
            options, moKeys.data(), moValuePtrs.data(), static_cast<int>(moKeys.size())));
      }
      sessionOptions.AppendExecutionProvider_TensorRT_V2(*options);`,
    ],
  ];

  let out = text.includes("#include <vector>")
    ? text
    : text.replace(
        "#include <unordered_map>",
        "#include <unordered_map>" + eol + "#include <vector>",
      );
  for (const [from, to] of edits) {
    const a = norm(from);
    if (!out.includes(a)) {
      throw new Error("патч TRT-опций не нашёл место в binding: проверьте версию ONNX Runtime");
    }
    out = out.replace(a, norm(to));
  }
  fs.writeFileSync(file, out);
  return "пропатчен (опции TRT доходят до ORT)";
}

/** CMake: сначала из PATH, иначе ищем в установленных Visual Studio (там свой cmake). */
function findCmake() {
  const explicit = opt("cmake");
  if (explicit) return path.resolve(explicit);
  if (spawnSync("cmake", ["--version"], { encoding: "utf8" }).status === 0) return "cmake";
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean);
  const found = [];
  for (const root of roots) {
    const base = path.join(root, "Microsoft Visual Studio");
    if (!fs.existsSync(base)) continue;
    for (const vs of fs.readdirSync(base)) {
      for (const ed of fs.readdirSync(path.join(base, vs))) {
        const p = path.join(
          base,
          vs,
          ed,
          "Common7",
          "IDE",
          "CommonExtensions",
          "Microsoft",
          "CMake",
          "CMake",
          "bin",
          "cmake.exe",
        );
        if (fs.existsSync(p)) found.push(p);
      }
    }
  }
  if (!found.length) {
    console.error("cmake не найден: поставьте CMake или укажите --cmake <путь>");
    process.exit(2);
  }
  // Сортировка по пути = по версии Visual Studio (18 > 17 > 16).
  return found.sort().pop();
}

/** Запуск процесса с прямым выводом в консоль. */
function run(file, args, cwd, env) {
  console.log(`\n> ${path.basename(file)} ${args.join(" ")}`);
  const r = spawnSync(file, args, { cwd, env, stdio: "inherit", shell: false });
  if (r.status !== 0) {
    console.error(`сбой: ${path.basename(file)} (код ${r.status})`);
    process.exit(r.status || 1);
  }
}

/** node_modules внутри js/node: привязка к каталогу инструментов (junction-ссылкой). */
function linkModules() {
  const link = path.join(JS_NODE, "node_modules");
  if (fs.existsSync(link)) {
    try {
      fs.rmSync(link, { recursive: true, force: true });
    } catch {
      return; // Каталог занят — используем как есть.
    }
  }
  fs.symlinkSync(TOOLS_MODULES, link, "junction");
}

/** Провайдерные DLL: CMake копирует их в тот же каталог, что и биндинг. */
function dllDeps() {
  const wanted = [
    "onnxruntime_providers_shared.dll",
    WANT_CUDA ? "onnxruntime_providers_cuda.dll" : "",
    WANT_TRT ? "onnxruntime_providers_tensorrt.dll" : "",
  ].filter(Boolean);
  const absent = wanted.filter((n) => !fs.existsSync(path.join(RUNTIME, n)));
  if (absent.length) console.warn(`в релизной сборке нет: ${absent.join(", ")}`);
  return wanted
    .filter((n) => fs.existsSync(path.join(RUNTIME, n)))
    .map((n) => path.join(RUNTIME, n));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

function main() {
  preflight();
  const cmake = findCmake();
  console.log(`cmake: ${cmake}`);

  const env = {
    ...process.env,
    PATH: [path.dirname(cmake), path.join(TOOLS_MODULES, ".bin"), process.env.PATH].join(
      path.delimiter,
    ),
  };

  if (flag("clean")) {
    for (const p of [path.join(JS_NODE, "build"), path.join(JS_NODE, "bin")]) {
      fs.rmSync(p, { recursive: true, force: true });
    }
    console.log("кэш сборки очищен");
  }

  linkModules();

  // Патчим исходники биндинга: без этого опции TensorRT (fp16, кэш, профили)
  // до ORT не доходят — их просто некому передать.
  console.log(`патч опций TensorRT: ${patchTrtOptionsSource(SRC)}`);

  // ONNXRUNTIME_GENERATOR=Ninja говорит CMake-скрипту ORT, что релизные файлы лежат
  // прямо в --runtime (без подкаталога с именем конфигурации).
  const cfgArgs = [
    CMAKEJS,
    "configure",
    "-a",
    "x64",
    "--CDnapi_build_version=6",
    `--CDCMAKE_BUILD_TYPE=${CONFIG}`,
    "--CDONNXRUNTIME_GENERATOR=Ninja",
    `--CDONNXRUNTIME_BUILD_DIR=${RUNTIME}`,
  ];
  if (WANT_CUDA) cfgArgs.push("--CDUSE_CUDA=ON");
  if (WANT_TRT) cfgArgs.push("--CDUSE_TENSORRT=ON");
  const deps = dllDeps();
  if (deps.length) cfgArgs.push(`--CDORT_NODEJS_DLL_DEPS=${deps.join(";")}`);

  run(process.execPath, cfgArgs, JS_NODE, env);
  run(cmake, ["--build", ".", "--config", CONFIG, "--parallel"], path.join(JS_NODE, "build"), env);

  const built = path.join(DIST, "onnxruntime_binding.node");
  if (!fs.existsSync(built)) {
    console.error(`сборка не дала биндинг: ${built}`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(DIST)) {
    const from = path.join(DIST, f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(OUT, f));
  }

  console.log(`\nготово: ${path.relative(ROOT, OUT)}`);
  for (const f of fs.readdirSync(OUT).sort()) {
    const p = path.join(OUT, f);
    const mb = (fs.statSync(p).size / 1048576).toFixed(2);
    const hash = f.endsWith(".node") ? ` sha256:${sha256(p)}` : "";
    console.log(`  ${f}  ${mb} МБ${hash}`);
  }
}

main();
