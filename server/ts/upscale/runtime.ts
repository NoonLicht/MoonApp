import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import type { ManifestModel, OrtModule } from "./types";
import { clearSessions } from "./session";

const { DIRS } = config;

const ORT_RETRY_MS = 5000;

let ortCache: OrtModule | null | undefined;
/** Подменённый рантайм (тесты) — имеет приоритет над настоящим модулем. */
let ortForTests: OrtModule | null = null;
/** Причина отказа последней попытки и время попытки (чтобы не спамить require). */
let ortError = "";
let ortPath = "";
let ortTriedAt = 0;

/**
 * GPU-пак: своя сборка onnxruntime-node с провайдерами CUDA/TensorRT.
 *
 * Зачем: npm-модуль собран только с cpu/dml/webgpu, а провайдерные DLL есть лишь
 * в CUDA-сборке ONNX Runtime. Пак кладётся в storage (в asar писать нельзя) и
 * подключается двумя вещами:
 *   1) подменой нативного биндинга (перехват require внутри onnxruntime-node);
 *   2) каталогом пака в DLL-поиске Windows — иначе провайдер CUDA не найдёт свои
 *      cudart/cublas/cuDNN рядом с собой.
 * Стоковый модуль остаётся на месте: нет пака — работает как раньше (DML/CPU).
 */
export function packDir(): string {
  return path.join(DIRS.storage, "ort-gpu", `${process.platform}-${process.arch}`);
}

/** Путь к своему биндингу в паке (пустая строка, если пака нет). */
export function packBinding(): string {
  const p = path.join(packDir(), "onnxruntime_binding.node");
  return fs.existsSync(p) ? p : "";
}

/**
 * Работать стоковым рантаймом npm-модуля, не подключая биндинг пака.
 *
 * Зачем: нативный биндинг в процессе один, и наш пак подменяет стоковый — вместе
 * они не поднимаются. Провайдеры `dml`/`webgpu` есть только в стоковом модуле,
 * поэтому для замера и диагностики нужен способ явно попросить стоковый рантайм
 * (переменная `MOONAPP_ORT_STOCK=1`).
 */
export function ortStockForced(): boolean {
  const v = String(process.env.MOONAPP_ORT_STOCK || "")
    .trim()
    .toLowerCase();
  return !!v && v !== "0" && v !== "false";
}

/** Что за пак установлен: путь, версия движка и что в нём собрано. */
export function packStatus(): {
  installed: boolean;
  dir: string;
  binding: string;
  provider: string;
  version: string;
} {
  const binding = packBinding();
  const meta = path.join(packDir(), "pack.json");
  let info: { provider?: string; version?: string } = {};
  if (binding && fs.existsSync(meta)) {
    try {
      info = JSON.parse(fs.readFileSync(meta, "utf8")) as { provider?: string; version?: string };
    } catch {
      info = {};
    }
  }
  return {
    installed: !!binding,
    dir: packDir(),
    binding,
    provider: String(info.provider || ""),
    version: String(info.version || ""),
  };
}

/** Добавить каталог пака в DLL-поиск процесса (по одному разу на каталог). */
function ensurePackDllPath(dir: string): void {
  const parts = String(process.env.PATH || "").split(path.delimiter);
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].join(path.delimiter);
}

/** Биндинг пака, который реально подключён (для статуса) и признак готового перехвата. */
let packInUse = "";
let packHookInstalled = false;

/**
 * Подключить биндинг из пака вместо npm-модуля.
 *
 * Механика: `onnxruntime-node` делает
 * `require("../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node")` — путь
 * жёстко зашит в его же коде. Поэтому перехватываем `Module._load` и на этот
 * запрос отдаём уже загруженный модуль из пака. Перехват ставится один раз.
 */
function installPackBinding(): boolean {
  if (ortStockForced()) return false;
  const binding = packBinding();
  if (!binding) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require(binding) as unknown;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("module") as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    if (!packHookInstalled) {
      const orig = mod._load.bind(mod);
      mod._load = (request: string, parent: unknown, isMain: boolean) => {
        if (typeof request === "string" && request.endsWith("onnxruntime_binding.node"))
          return native;
        return orig(request, parent, isMain);
      };
      packHookInstalled = true;
    }
    ensurePackDllPath(packDir());
    packInUse = binding;
    logger.info("upscale.pack_binding", { binding });
    return true;
  } catch (e) {
    // Битый пак не залипаем: причина уходит в статус, работаем стоковым модулем.
    ortError = String((e as Error).message || e).slice(0, 300);
    logger.warn("upscale.pack_binding_failed", { error: ortError });
    return false;
  }
}

/**
 * Где искать рантайм. Обычный require находит модуль в dev-режиме, но в
 * установленной сборке зависимости лежат рядом с app.asar (asarUnpack), поэтому
 * проверяем и `resources/app.asar.unpacked`, и текущую папку приложения.
 */
function ortCandidates(): string[] {
  const out: string[] = ["onnxruntime-node"];
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) {
    out.push(
      path.join(resources, "app.asar.unpacked", "node_modules", "onnxruntime-node"),
      path.join(resources, "app", "node_modules", "onnxruntime-node"),
    );
  }
  out.push(path.join(process.cwd(), "node_modules", "onnxruntime-node"));
  return out;
}

/**
 * Ленивая загрузка рантайма с повтором.
 *
 * Почему с повтором: модуль можно поставить уже после запуска приложения
 * (`npm install onnxruntime-node`), и «нет рантайма» не должно залипать на весь
 * процесс — иначе пользователь видит предупреждение до перезапуска. Успех
 * кэшируем навсегда (это дорого), а отказ — только на ORT_RETRY_MS.
 */
export function loadOrt(force = false): OrtModule | null {
  // Подмена рантайма (тесты): реальный модуль может отсутствовать или быть тяжёлым.
  if (ortForTests) return ortForTests;
  if (ortCache && !force) return ortCache;
  if (!force && ortCache === null && Date.now() - ortTriedAt < ORT_RETRY_MS) return null;
  ortTriedAt = Date.now();
  // GPU-пак (CUDA/TensorRT) приоритетнее npm-модуля: там своя сборка биндинга.
  installPackBinding();
  for (const candidate of ortCandidates()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(candidate) as OrtModule;
      ortCache = mod;
      ortError = "";
      try {
        // С установленным паком реально загружен его биндинг, а не модуль из node_modules.
        ortPath = packInUse || require.resolve(candidate);
      } catch {
        ortPath = packInUse || candidate;
      }
      logger.info("upscale.ort_loaded", {
        version: mod?.env?.versions?.common || "",
        path: ortPath,
      });
      return ortCache;
    } catch (e) {
      ortError = String((e as Error).message || e).slice(0, 300);
    }
  }
  logger.warn("upscale.ort_missing", { error: ortError });
  ortCache = null;
  return null;
}

export function runtimeAvailable(): boolean {
  // Пак уже на диске — рантайм будет доступен после перезапуска, даже если в этом
  // процессе ONNX ещё не загружался (загружать его ради ответа не нужно).
  if (!ortStockForced() && packBinding()) return true;
  return !!loadOrt();
}

/**
 * Подмена рантайма: нужна тестам, чтобы проверить выгрузку сессий без нативной
 * библиотеки и файла модели (в приложении всегда используется onnxruntime-node).
 */
export function setOrtForTests(mod: OrtModule | null): void {
  ortForTests = mod;
  clearSessions();
}

/** Состояние рантайма для UI: есть ли, версия, откуда и почему нет. */
export function runtimeStatus(): {
  available: boolean;
  version: string;
  path: string;
  error: string;
  pack: string;
} {
  // ВАЖНО: с установленным паком не загружаем рантайм — иначе его DLL захватываются
  // процессом, и пак нельзя ни обновить, ни удалить до перезапуска приложения.
  // Без пака (стоковый модуль) загрузка безопасна и нужна для честного статуса.
  const binding = packBinding();
  let mod: OrtModule | null = ortForTests || ortCache || null;
  if (!mod && !binding) mod = loadOrt();
  if (!mod && binding) {
    const info = packStatus();
    return {
      available: true,
      version: info.version,
      path: binding,
      error: "",
      pack: binding,
    };
  }
  return {
    available: !!mod,
    version: String(mod?.env?.versions?.common || ""),
    path: ortPath,
    error: mod ? "" : ortError,
    // Непустая строка — включён свой биндинг из GPU-пака (CUDA/TensorRT).
    pack: packInUse,
  };
}

/** Порядок провайдеров: cuda → dml (DirectML) → cpu, с откатом на CPU. */
function providerList(pref: string): string[] {
  if (pref === "cpu") return ["cpu"];
  if (pref === "cuda") return ["cuda", "cpu"];
  if (pref === "dml") return ["dml", "cpu"];
  if (pref === "tensorrt") return ["tensorrt", "cuda", "cpu"];
  return ["cuda", "dml", "cpu"];
}

/**
 * Список провайдеров для конкретной модели.
 *
 * `m.provider` из каталога — рекомендация автора модели: часть графов падает на
 * DirectML (например Anime4K: DML не умеет его Add и отдаёт 0x8007023E), и там
 * честнее сразу считать на CPU, чем показывать пользователю ошибку драйвера.
 * Провайдер из настроек остаётся главным: явный выбор `cpu`/`cuda` не отменяем.
 */
export function providerOrder(pref: string, m?: ManifestModel | null): string[] {
  const base = providerList(pref);
  const own = String(m?.provider || "");
  const order = !own || !base.includes(own) ? base : [own, ...base.filter((p) => p !== own)];
  // Чего нет в рантайме — не пробуем: со стоковым модулем нет cuda/tensorrt, а с
  // GPU-паком нет dml. Иначе первый же session попадал бы в ошибку «нет провайдера».
  const have = new Set(supportedBackends());
  if (!have.size) return order;
  const filtered = order.filter((p) => p === "cpu" || have.has(p));
  return filtered.length ? filtered : ["cpu"];
}

/** Провайдеры, реально собранные в этот рантайм (`cpu`, `dml`, `cuda`, `tensorrt`…). */
export function supportedBackends(): string[] {
  // Пак на диске, но рантайм в этом процессе ещё не загружен: список берём из
  // файлов пака. Так страница не «захватывает DLL ради подписи» — иначе пак нельзя
  // будет обновить или удалить без перезапуска приложения.
  const binding = ortStockForced() ? "" : packBinding();
  if (binding && !ortCache) return packBackends(binding);
  const ort = loadOrt() as OrtModule | null;
  try {
    const list = (ort?.listSupportedBackends?.() || [])
      .map((b) => String(b?.name || ""))
      .filter(Boolean);
    // Список в биндинге — «время сборки»: он не знает, скачал ли пользователь
    // вторую ступень пака. Проверяем файлы: без библиотек TRT провайдер всё равно
    // не поднимется, и обещать его в UI неправильно.
    if (!packInUse) return list;
    const dir = packDir();
    return list.filter((p) => {
      if (p === "cuda") return fs.existsSync(path.join(dir, "onnxruntime_providers_cuda.dll"));
      if (p === "tensorrt")
        return (
          fs.existsSync(path.join(dir, "onnxruntime_providers_tensorrt.dll")) &&
          fs.existsSync(path.join(dir, "nvinfer_10.dll"))
        );
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * Провайдеры пака по его файлам: CPU есть всегда, CUDA — если лежит провайдер CUDA,
 * TensorRT — только со второй ступенью (провайдер + nvinfer_10).
 */
function packBackends(binding: string): string[] {
  const dir = path.dirname(binding);
  const out = ["cpu"];
  if (fs.existsSync(path.join(dir, "onnxruntime_providers_cuda.dll"))) out.push("cuda");
  if (
    fs.existsSync(path.join(dir, "onnxruntime_providers_tensorrt.dll")) &&
    fs.existsSync(path.join(dir, "nvinfer_10.dll"))
  ) {
    out.push("tensorrt");
  }
  return out;
}

/**
 * Папка кэша движков TensorRT: `.trt\<профиль>\<модель>`.
 *
 * Зачем два уровня. Профиль: движок помнит размеры входа, поэтому общий кэш на все
 * тайлы ломался с «Static dimension mismatch» при смене тайла. Модель: имена файлов
 * движков — хеши графа, и в общей папке профиля «самый свежий файл» мог оказаться
 * движком совсем другой модели, а реестр привязывал его не туда.
 */
