import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import type { ManifestModel, TrtBuildResult, TrtStatus } from "./types";
import { findModel } from "./manifest";
import { loadOrt, supportedBackends } from "./runtime";
import { clearSessions } from "./session";

const { DIRS } = config;

export function trtDir(size = 0, modelId = ""): string {
  const root = path.join(DIRS.upscaleModels, ".trt");
  const parts = [root];
  if (size > 0) parts.push(String(size));
  // Ид модели приходит из каталога (только [a-zA-Z0-9._-]) — как папка безопасен.
  if (modelId) parts.push(modelId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  const dir = path.join(...parts);
  // Каталог создаём сами: в несуществующий путь ORT молча не пишет кэш, и тогда
  // каждое новое окно приложения пересобирает движок заново (это минуты).
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Собранные движки TensorRT: `.trt\<профиль>\<модель>\*.engine` (рекурсивно). */
export function trtEngines(): { file: string; sizeMb: number; mtime: number }[] {
  const root = path.join(DIRS.upscaleModels, ".trt");
  if (!fs.existsSync(root)) return [];
  const out: { file: string; sizeMb: number; mtime: number }[] = [];
  /** Обход в глубину: путь от `.trt` попадает в имя («512/модель/…engine»). */
  const walk = (dir: string, prefix: string[]): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, [...prefix, ent.name]);
        continue;
      }
      if (!ent.name.endsWith(".engine")) continue;
      const st = fs.statSync(full);
      out.push({
        file: [...prefix, ent.name].join("/"),
        sizeMb: +(st.size / 1048576).toFixed(1),
        mtime: st.mtimeMs,
      });
    }
  };
  walk(root, []);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Реестр движков: какой модели и какому профилю принадлежит файл движка.
 *
 * Имена файлов движков — хеши графа, поэтому «есть ли движок у этой модели» из имён
 * не вычитать. Реестр пишется при сборке кнопкой и при первом TRT-прогоне модели,
 * а панель моделей показывает по нему галочку «движок готов».
 */
function trtRegistryPath(): string {
  return path.join(DIRS.upscaleModels, ".trt", "registry.json");
}

/** Записи реестра: ключ `${модель}|${профиль}` → путь движка внутри `.trt`. */
export function trtRegistry(): Record<string, string> {
  try {
    const p = trtRegistryPath();
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch (e) {
    logger.warn("upscale.trt_registry_read", { error: String((e as Error).message).slice(0, 160) });
    return {};
  }
}

/** Дописать движок в реестр (имя файла — как в `trtEngines`: «512/…engine»). */
function trtRegistryAdd(modelId: string, profile: number, file: string): void {
  if (!file) return;
  const all = trtRegistry();
  const key = `${modelId}|${profile}`;
  if (all[key] === file) return;
  all[key] = file;
  try {
    const p = trtRegistryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(all, null, 1));
  } catch (e) {
    logger.warn("upscale.trt_registry_write", {
      error: String((e as Error).message).slice(0, 160),
    });
  }
}

/** Файл движка модели: для профиля (`profile > 0`) или любой собранный. */
export function trtEngineFor(modelId: string, profile = 0): string {
  const all = trtRegistry();
  if (profile > 0) return all[`${modelId}|${profile}`] || "";
  const hit = Object.keys(all).find((k) => k.startsWith(`${modelId}|`));
  return hit ? all[hit] : "";
}

/**
 * Запомнить движок, который ORT собрал в этой папке профиля.
 *
 * Нужно и кнопке «Собрать движок», и обычному прогону: движок мог появиться при
 * первом задании, и панель моделей должна это показать.
 */
export function registerTrtEngine(modelId: string, profile: number, dir: string): string {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".engine"))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return "";
    // Папка принадлежит одной модели, поэтому самый свежий файл здесь — её движок.
    const file = `${profile}/${modelId}/${files[0].f}`;
    trtRegistryAdd(modelId, profile, file);
    return file;
  } catch (e) {
    logger.warn("upscale.trt_engine_scan", { error: String((e as Error).message).slice(0, 160) });
    return "";
  }
}

/**
 * Максимальная пачка в профиле TensorRT: движок собирается под диапазон 1..этого
 * значения. Большую пачку TRT не примет — пришлось бы пересобирать движок (минуты),
 * поэтому «сколько кадров за проход» подрезаем (см. upscaleVideoJob).
 */
/**
 * Потолок пачки в профиле TensorRT: движок собирается под диапазон 1..N.
 *
 * Почему 8: из замеров — пачка 8 быстрее пачки 2 на ~12%, а дальше растут только
 * буферы кадров в памяти. Переопределяется переменной окружения `MOONAPP_TRT_BATCH_MAX`
 * (замеру она нужна, чтобы честно снять пачку 16 — под неё движок собирается заново).
 */
export const TRT_BATCH_MAX = Math.min(
  128,
  Math.max(1, Math.round(Number(process.env.MOONAPP_TRT_BATCH_MAX) || 0) || 8),
);

/**
 * Размер входа, под который собирается профиль TensorRT (и он же — размер тайла).
 *
 * Почему одно число: профиль у TRT статический (min = max), поэтому любой «не
 * такой» размер входа означает пересборку движка или отказ. Считаем размер от
 * тайла модели/настроек, а кадр режем на тайлы ровно этого размера и добираем
 * крайние тайлы повтором края — тогда движок собирается один раз на всё видео.
 */
export function trtProfileSize(m: ManifestModel | null | undefined, tile: number): number {
  return Math.max(64, Math.round(tile || m?.tile || 512));
}

/**
 * Опции сессии для TensorRT: fp16, кэш движка/таймингов и профиль формы.
 *
 * Профиль: пространственные размеры жёстко равны `trtProfileSize` (так движок не
 * пересобирается), а пачка — диапазон 1..`batchMax`, потому что последняя пачка
 * видео всегда короче полной.
 *
 * Экспортируется ради теста: имена ключей — часть контракта с ORT, и опечатка в них
 * (например `trt_opt_profile_shapes` вместо `trt_profile_opt_shapes`) роняет сессию
 * целиком с «Unknown provider option».
 */
export function trtOptions(
  m: ManifestModel,
  tile: number,
  dir: string,
  batchMax = TRT_BATCH_MAX,
): Record<string, unknown> {
  const size = trtProfileSize(m, tile);
  const shape = (n: number) => `input:${n}x3x${size}x${size}`;
  const maxN = Math.max(1, Math.round(batchMax) || 1);
  // ВАЖНО: опции провайдера передаются В ОБЪЕКТЕ провайдера — так их читает
  // биндинг (`ParseExecutionProviders`) и наш патч опций TRT. В опциях сессии они
  // игнорируются, и TRT молча работает на умолчаниях (без fp16 и без кэша).
  return {
    executionProviders: [
      {
        name: "tensorrt",
        trt_fp16_enable: true,
        trt_engine_cache_enable: true,
        trt_engine_cache_path: dir,
        trt_timing_cache_enable: true,
        trt_timing_cache_path: dir,
        trt_builder_optimization_level: 3,
        // 2 ГБ, а не 4: на картах, которые заодно тянут экран (нет отдельной
        // headless-карты под TRT), больший воркспейс во время автотюнинга дольше
        // держит GPU занятым сборкой — на части связок драйвер/модель это
        // упиралось в таймаут Windows (TDR) и ронял драйвер целиком. Сборка теперь
        // ещё и в отдельном процессе (см. trtWorker.ts), но воркспейс поменьше —
        // это снижает саму вероятность зависания GPU, а не только его последствия.
        trt_max_workspace_size: 2 * 1024 * 1024 * 1024,
        // Один профиль: тайл фиксирован, пачка — от 1 до maxN. Имя ключа —
        // ровно как в ORT (`trt_profile_opt_shapes`), иначе провайдер отвергнет
        // ВСЕ опции с «Unknown provider option».
        trt_profile_min_shapes: shape(1),
        trt_profile_opt_shapes: shape(maxN),
        trt_profile_max_shapes: shape(maxN),
      },
    ],
    graphOptimizationLevel: "all",
    // Уровень логов ORT: по умолчанию только ошибки, MOONAPP_TRT_LOG=1 включает info
    // (нужно, когда смотрим, подхватился ли кэш движка).
    logSeverityLevel: Number(process.env.MOONAPP_TRT_LOG || 3),
  };
}

export function trtStatus(): TrtStatus {
  const backends = supportedBackends();
  return {
    available: backends.includes("tensorrt"),
    backends,
    dir: trtDir(),
    engines: trtEngines(),
  };
}

/**
 * Собрать движок TensorRT FP16 для модели (кнопка в панели моделей).
 *
 * Это тот же ONNX-файл: TRT компилирует граф под GPU и кладёт .engine в кэш,
 * дальнейшие запуски с провайдером `tensorrt` грузят его мгновенно. Для AMD,
 * Intel и CPU ничего не нужно — работает обычный ONNX-путь.
 */
const TRT_DROP_ONNX_MAX_MB = 64;

/**
 * Убрать ONNX, оставив собранный движок TensorRT.
 *
 * Движок TensorRT — скомпилированный под GPU план графа, но ONNX Runtime читает
 * сам граф при создании сессии, поэтому «совсем без ONNX» модель жить не может.
 * Зато файл можно не держать на диске: как только движок собран, ONNX удаляется
 * (освобождает место), а при следующем запуске движок скачивает его сам
 * (см. getSession) — граф тот же, поэтому кэш движка переиспользуется.
 */
function dropOnnx(id: string): number {
  const m = findModel(id);
  if (!m || !m.url) return 0;
  const p = path.join(DIRS.upscaleModels, m.file);
  if (!fs.existsSync(p)) return 0;
  const freed = Math.round(fs.statSync(p).size / 1048576);
  // Файл держит только загруженная сессия: убираем её и пробуем удалить.
  clearSessions();
  try {
    fs.rmSync(p, { force: true });
  } catch (e) {
    logger.warn("upscale.onnx_in_use", { id, error: String((e as Error).message).slice(0, 160) });
    return 0;
  }
  logger.action("upscale.onnx_dropped", { id, freedMb: freed, engine: trtEngineFor(id) });
  return freed;
}

/** Ручное «освободить ONNX»: только когда движок собран и модель есть откуда взять. */
export function removeOnnx(id: string): { ok: boolean; freedMb: number } {
  const m = findModel(id);
  if (!m) throw new Error("model_unknown");
  if (!trtEngineFor(id)) throw new Error("trt_engine_missing");
  if (!m.url) throw new Error("model_no_url");
  return { ok: true, freedMb: dropOnnx(id) };
}

/** Убрать движки модели (при её удалении): файлы + записи реестра. */
export function dropEngines(id: string): void {
  const root = path.join(DIRS.upscaleModels, ".trt");
  const entries = Object.keys(trtRegistry()).filter((k) => k.startsWith(`${id}|`));
  const files = trtEngines()
    .filter((e) => e.file.split("/")[1] === id)
    .map((e) => e.file);
  for (const rel of files) fs.rmSync(path.join(root, ...rel.split("/")), { force: true });
  if (entries.length) {
    const all = trtRegistry();
    for (const k of entries) delete all[k];
    try {
      fs.writeFileSync(trtRegistryPath(), JSON.stringify(all, null, 1));
    } catch (e) {
      logger.warn("upscale.trt_registry_write", {
        error: String((e as Error).message).slice(0, 160),
      });
    }
  }
  // Пустые папки моделей после себя не оставляем.
  try {
    for (const seg of fs.readdirSync(root, { withFileTypes: true })) {
      if (!seg.isDirectory()) continue;
      const sub = path.join(root, seg.name, id);
      if (fs.existsSync(sub) && fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
    }
  } catch (e) {
    logger.warn("upscale.trt_prune", { error: String((e as Error).message).slice(0, 160) });
  }
}

export async function buildTrtEngine(
  id: string,
  o: { tile?: number } = {},
): Promise<TrtBuildResult> {
  const ort = loadOrt();
  if (!ort) throw new Error("runtime_missing");
  const m = findModel(id);
  if (!m) throw new Error("model_unknown");
  const file = path.join(DIRS.upscaleModels, m.file);
  if (!fs.existsSync(file)) throw new Error("model_missing");
  const backends = supportedBackends();
  if (!backends.includes("tensorrt")) throw new Error("trt_unavailable");

  const profile = trtProfileSize(m, o.tile || 0);
  const dir = trtDir(profile, id);
  const before = new Set(trtEngines().map((e) => e.file));
  const t0 = Date.now();
  // Первый заход по этому профилю компилирует граф (минуты), повторный — просто
  // грузит готовый движок из кэша за доли секунды. Отсюда reused в ответе.
  const session = await ort.InferenceSession.create(file, trtOptions(m, o.tile || 0, dir));
  const ms = Date.now() - t0;
  const fresh = trtEngines().filter((e) => !before.has(e.file));
  const engine = registerTrtEngine(id, profile, dir);
  const engineMb = trtEngines().find((e) => e.file === engine)?.sizeMb || 0;
  // Сессия нужна была только для сборки: движок уже на диске.
  await session.release?.().catch(() => undefined);
  // Модель стала «тензорной»: движок собран, ONNX на диске больше не нужен —
  // освобождаем место (крупные модели оставляем, их докачка была бы долгой).
  const onnxFreedMb = engine && m.url && m.sizeMb <= TRT_DROP_ONNX_MAX_MB ? dropOnnx(id) : 0;
  const total = trtEngines().length;
  logger.action("upscale.trt_built", {
    model: id,
    profile,
    ms,
    reused: fresh.length === 0,
    onnxFreedMb,
    engines: fresh.map((e) => e.file),
  });
  return {
    ok: true,
    ms,
    profile,
    engines: fresh.map((e) => ({ file: e.file, sizeMb: e.sizeMb })),
    reused: fresh.length === 0,
    engine,
    engineMb,
    total,
    onnxFreedMb,
  };
}

