"use strict";

/**
 * Проверка установочной сборки: лежит ли ONNX-рантайм внутри неё и грузится ли он.
 *
 * Зачем: `onnxruntime-node` — нативный модуль с DLL, и в упакованном приложении он
 * должен быть распакован из app.asar (asarUnpack). Если его там нет, приложение
 * честно скажет «нет рантайма» — но лучше узнать это до выкладки релиза, а не из
 * сообщения пользователя.
 *
 * Использование:
 *   node scripts/check-pack.js                 # ищет release/*-unpacked
 *   node scripts/check-pack.js <путь к win-unpacked>
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RELEASE = path.join(ROOT, "release");

/** Папка распакованной сборки: аргумент или единственный *-unpacked рядом. */
function findUnpacked() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  if (!fs.existsSync(RELEASE)) return "";
  const dirs = fs
    .readdirSync(RELEASE)
    .filter((n) => n.endsWith("-unpacked"))
    .map((n) => path.join(RELEASE, n))
    .filter((p) => fs.statSync(p).isDirectory());
  return dirs[0] || "";
}

/** Ищем модуль рантайма там, где его увидит приложение. */
function findRuntime(unpacked) {
  const candidates = [
    path.join(unpacked, "resources", "app.asar.unpacked", "node_modules", "onnxruntime-node"),
    path.join(unpacked, "resources", "app", "node_modules", "onnxruntime-node"),
    path.join(unpacked, "resources", "node_modules", "onnxruntime-node"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || "";
}

/** Нативные файлы: без них модуль «есть», но инференс не запустится. */
function nativeFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(node|dll|so|dylib)$/i.test(e.name)) out.push(p.replace(dir + path.sep, ""));
    }
  };
  walk(dir, 0);
  return out;
}

const unpacked = findUnpacked();
if (!unpacked) {
  console.log("Сборка не найдена: сначала `npx electron-builder --win --dir` (или укажите путь).");
  process.exit(0);
}
console.log(`сборка: ${unpacked}`);
const runtime = findRuntime(unpacked);
if (!runtime) {
  console.error("✗ onnxruntime-node НЕ найден в сборке — ONNX-модели работать не будут.");
  console.error(
    "  проверьте в package.json: files → node_modules, asarUnpack → node_modules/onnxruntime-node/**",
  );
  process.exit(1);
}
const rel = path.relative(unpacked, runtime);
const nat = nativeFiles(runtime);
console.log(`✓ рантайм на месте: ${rel}`);
console.log(
  `  нативные файлы (${nat.length}): ${nat.slice(0, 4).join(", ")}${nat.length > 4 ? " …" : ""}`,
);
if (!nat.length) {
  console.error("✗ в модуле нет .node/.dll — инференс не запустится");
  process.exit(1);
}

// Самый честный тест: загрузить модуль тем самым Electron, что внутри сборки,
// причём ТЕМ ЖЕ путём, каким его грузит приложение, — через app.asar
// (`require("onnxruntime-node")` из server/upscale.js внутри архива). Прямое
// `require` по распакованному пути — искусственный случай: в нём Node ищет
// зависимости рядом с app.asar.unpacked, а не в архиве.
const exe = fs.readdirSync(unpacked).find((n) => n.endsWith(".exe") && !/uninstall/i.test(n));
if (!exe) {
  console.log("исполняемый файл не найден — пропускаю проверку загрузки");
  process.exit(0);
}
const exePath = path.join(unpacked, exe);
const enginePath = path.join(unpacked, "resources", "app.asar", "server", "upscale.js");
const tmpStorage = path.join(unpacked, ".check-storage");
const script =
  `const eng=require(${JSON.stringify(enginePath)});` +
  `const st=eng.runtimeStatus();` +
  `console.log("ONNX " + (st.available ? "OK " + st.version : "НЕТ: " + st.error));` +
  // Каталог моделей: в чистом storage (временный) обязан работать вшитый
  // манифест, иначе на первом запуске/офлайн список моделей будет пустым.
  `const mi=eng.manifestInfo();` +
  `console.log("CATALOG " + mi.source + " " + mi.count + " " + mi.url);`;
try {
  const out = execFileSync(exePath, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MOONAPP_STORAGE: tmpStorage },
    encoding: "utf8",
    timeout: 60000,
  });
  const text = String(out).trim();
  console.log(
    text.startsWith("ONNX OK")
      ? `✓ ${text.split("\n")[0]} (через app.asar, Electron сборки)`
      : `✗ ${text}`,
  );
  if (!text.startsWith("ONNX OK")) process.exit(1);
  const cat = /CATALOG (\S+) (\d+) (\S*)/.exec(text);
  if (!cat || Number(cat[2]) < 1) {
    console.error(`✗ каталог моделей в сборке пуст: ${text.split("\n").pop()}`);
    process.exit(1);
  }
  console.log(`✓ каталог: ${cat[1]}, моделей ${cat[2]}, обновление с ${cat[3]}`);
} catch (e) {
  console.error(`✗ движок не ответил из сборки: ${String(e.message || e).slice(0, 300)}`);
  process.exit(1);
} finally {
  fs.rmSync(tmpStorage, { recursive: true, force: true });
}
console.log("итог: ONNX-рантайм в установочной сборке рабочий");
