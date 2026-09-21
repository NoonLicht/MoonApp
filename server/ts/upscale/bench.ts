import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import { removePath } from "../fsUtil";
import {
  frameLimitOrInf,
  planInterp,
  planOutFrames,
  rateFps,
} from "../upscalePipeline";
import type {
  BenchEntry,
  BenchResults,
  ManifestModel,
  OrtModule,
  ReadySession,
  UpEstimate,
  UpParams,
} from "./types";
import { tileRects } from "./tiling";
import { findModel, interpMultMax, modelKind } from "./manifest";
import { loadOrt, runtimeAvailable } from "./runtime";
import { TRT_BATCH_MAX, trtEngineFor, trtProfileSize } from "./trt";
import { BATCH_MAX, MAX_OUT_PX, SLOW_FACTORS, isNoUpscale, normalizeParams } from "./params";
import {
  isBatchMismatch,
  markBatchUnsupported,
  pickInterpModel,
  upscaleRgb,
  upscaleRgbBatch,
} from "./inference";

const { DIRS } = config;

let mpxPerSec = 0;

export function recordThroughput(outPixels: number, ms: number): void {
  if (!(outPixels > 0) || !(ms > 100)) return;
  const speed = outPixels / 1e6 / (ms / 1000);
  // EMA: свежие задания важнее (железо/настройки могли измениться).
  mpxPerSec = mpxPerSec > 0 ? mpxPerSec * 0.4 + speed * 0.6 : speed;
}

/** Текущая оценка скорости (Мп/с) — для тестов и подсказок. */
export function throughputMpx(): number {
  return Math.round(mpxPerSec * 100) / 100;
}

// ================== ЗАМЕР СКОРОСТИ МОДЕЛЕЙ ==================
// Скорость зависит от машины: видеокарта, драйвер, собранный движок, провайдер.
// Поэтому цифры не «вшиты» в каталог, а считаются на месте и лежат в storage —
// у каждого пользователя свои. Экран замеров — окно каталога моделей: кнопка
// «Замерить все модели» и «Замер» в карточке (POST /api/upscale/bench).

/** Эталонный кадр замера — тот же, что у скриптов (scripts/bench-models.js). */
export const BENCH_FRAME = { w: 848, h: 480 };

/** Прогонов по умолчанию: первый заход — прогрев, дальше берём лучшее время. */
export const BENCH_RUNS = 3;

/** Что пробуем в пачке: ступени движка (BATCH_SIZES), у TensorRT — по профилю. */
export const BENCH_BATCH_STEPS = [2, 4, 8, 16];

/** Потолок памяти одной пробы пачки: вход+выход n кадров, МБ. */
export const BENCH_BATCH_MB = 512;

function benchFile(): string {
  return path.join(DIRS.storage, "upscale-bench.json");
}

/**
 * Чтение файла замеров: файл мог остаться от старой версии или быть испорченным
 * (питание, антивирус) — панель моделей не должна из-за этого падать, поэтому
 * всё лишнее отбрасываем, а не пробрасываем как есть.
 */
export function sanitizeBench(raw: unknown): BenchResults {
  const out: BenchResults = {};
  if (!raw || typeof raw !== "object") return out;
  const box = raw as { results?: unknown };
  const src = (box.results && typeof box.results === "object" ? box.results : raw) as Record<
    string,
    unknown
  >;
  for (const [id, list] of Object.entries(src)) {
    if (!Array.isArray(list)) continue;
    const rows: BenchEntry[] = [];
    for (const r of list) {
      const e = (r || {}) as Partial<BenchEntry>;
      const ms = Number(e.ms);
      if (!(ms > 0)) continue;
      rows.push({
        model: String(e.model || id).slice(0, 60),
        provider: String(e.provider || "").slice(0, 20),
        tile: Math.max(0, Math.round(Number(e.tile) || 0)),
        batch: Math.max(1, Math.round(Number(e.batch) || 1)),
        batchMax: Math.max(0, Math.min(BATCH_MAX, Math.round(Number(e.batchMax) || 0))),
        ms: Math.round(ms * 10) / 10,
        frameMs: Math.max(0, Math.round(Number(e.frameMs) || 0)),
        fps: Math.max(0, Math.round((Number(e.fps) || 0) * 10) / 10),
        tiles: Math.max(0, Math.round(Number(e.tiles) || 0)),
        runs: Math.max(1, Math.round(Number(e.runs) || 1)),
        engine: String(e.engine || "").slice(0, 80),
        when: Math.max(0, Math.round(Number(e.when) || 0)),
      });
      if (rows.length >= 8) break;
    }
    if (rows.length) out[id.slice(0, 60)] = rows;
  }
  return out;
}

/** Все замеры этой машины. */
export function benchResults(): BenchResults {
  try {
    if (!fs.existsSync(benchFile())) return {};
    return sanitizeBench(JSON.parse(fs.readFileSync(benchFile(), "utf8")));
  } catch (e) {
    logger.warn("upscale.bench_read", { error: String((e as Error).message).slice(0, 160) });
    return {};
  }
}

/** «Забыть замеры»: железо сменилось — старые цифры только путают. */
export function clearBench(): { ok: boolean } {
  try {
    removePath(benchFile());
  } catch {
    /* файла нет — и хорошо */
  }
  return { ok: true };
}

/** Сколько тайлов придётся обработать в эталонном кадре (нужно для оценки fps). */
export function benchTiles(tile: number, m?: ManifestModel | null, provider = ""): number {
  const size = Math.max(0, Math.round(tile));
  if (!size) return 0;
  // TensorRT считает по размеру своего профиля, а не по «желаемому» тайлу.
  const use = provider === "tensorrt" && m ? trtProfileSize(m, size) : size;
  return tileRects(BENCH_FRAME.w, BENCH_FRAME.h, use, 16).length;
}

/** Время одного тайла → запись замера (оценка кадра и fps по числу тайлов). */
export function benchEntry(o: {
  model: string;
  provider: string;
  tile: number;
  batch?: number;
  batchMax?: number;
  ms: number;
  tiles: number;
  runs?: number;
  engine?: string;
  when?: number;
}): BenchEntry {
  const tiles = Math.max(0, Math.round(o.tiles));
  const frameMs = Math.round(o.ms * Math.max(1, tiles));
  return {
    model: String(o.model).slice(0, 60),
    provider: String(o.provider || "").slice(0, 20),
    tile: Math.max(0, Math.round(o.tile)),
    batch: Math.max(1, Math.round(o.batch || 1)),
    batchMax: Math.max(0, Math.min(BATCH_MAX, Math.round(o.batchMax || 0))),
    ms: Math.round(o.ms * 10) / 10,
    frameMs,
    fps: frameMs > 0 ? Math.round((1000 / frameMs) * 10) / 10 : 0,
    tiles,
    runs: Math.max(1, Math.round(o.runs || 1)),
    engine: String(o.engine || "").slice(0, 80),
    when: o.when || Date.now(),
  };
}

/** Синтетический кадр замера: градиент и шахматка — графу есть что считать. */
export function benchFrameSrc(w: number, h: number): Buffer {
  const src = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      src[i] = Math.round((x * 255) / Math.max(1, w - 1));
      src[i + 1] = Math.round((y * 255) / Math.max(1, h - 1));
      src[i + 2] = (x + y) % 32 < 16 ? 200 : 40;
    }
  }
  return src;
}

/** Сколько мегабайт займёт одна проба пачки: вход + выход n кадров. */
export function batchProbeMb(n: number, side: number, scale: number): number {
  const inPx = side * side * 3 * 4;
  const outPx = side * scale * side * scale * 3 * 4;
  return Math.round(((inPx + outPx) * n) / 1e6);
}

/**
 * Сколько кадров модель принимает за один проход — по факту, на этой машине.
 *
 * В каталоге этот факт есть не у всех моделей (у них в панели и стояло «пачка ?»),
 * поэтому замер выясняет его сам: пробуем ступени 2/4/8/16 на мелком кадре и
 * останавливаемся на первой ошибке графа. `1` — граф ждёт ровно один кадр (то же,
 * что `batch: 1` в каталоге), `0` — не проверяли.
 *
 * Проба идёт на кадре ≤128 px (у TensorRT — на размере профиля, иначе он просто
 * не примет вход) и на одном тайле: память и время остаются в разумных рамках,
 * а сам факт от размера тайла не зависит.
 */
export async function probeBatchMax(o: {
  src: Buffer;
  p: UpParams;
  size: number;
  /** Сторона входа: у TensorRT — размер профиля, иначе тот же кадр. */
  side: number;
  provider: string;
  scale: number;
  /** Ид модели: по нему запоминаем «граф ждёт один кадр» на процесс. */
  model?: string;
  mbLimit?: number;
  deps?: { ort: OrtModule; ready: ReadySession; model?: ManifestModel };
}): Promise<number> {
  const cap = o.provider === "tensorrt" ? TRT_BATCH_MAX : BATCH_MAX;
  const limit = o.mbLimit || BENCH_BATCH_MB;
  let max = 0;
  for (const n of BENCH_BATCH_STEPS) {
    // Профиль TensorRT и общий предел пачки выше не пускают, а проба «на вырост»
    // съела бы память впустую.
    if (n > cap) break;
    if (batchProbeMb(n, o.side, o.scale) > limit) break;
    try {
      await upscaleRgbBatch({
        frames: Array.from({ length: n }, () => o.src),
        w: o.size,
        h: o.size,
        p: o.p,
        deps: o.deps,
      });
      max = n;
    } catch (e) {
      // «Expected: 1» — граф ждёт ровно один кадр: дальше пробовать нечего, и это
      // факт на процесс — движок больше не будет тратить время на «залпы».
      if (isBatchMismatch(e)) {
        if (o.model) markBatchUnsupported(o.model);
        return 1;
      }
      break;
    }
  }
  return max;
}

let benchRunning = false;

/**
 * Монотонное время в миллисекундах с долями: у быстрых моделей и мелких тайлов
 * `Date.now()` даёт ровно 0 мс, и замер терял смысл.
 */
function benchNow(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** Идёт замер: второй запуск не начинаем (замер греет GPU и мешает заданиям). */
export function benchBusy(): boolean {
  return benchRunning;
}

/**
 * Замер одной модели: считаем ровно один тайл её размера несколько раз и берём
 * лучшее время (первый заход — прогрев сессии, в зачёт не идёт).
 *
 * Полный кадр 848×480 на тяжёлой модели считался бы минутами, а время тайла
 * хорошо предсказывает кадр: оценка кадра — арифметика по числу тайлов
 * (benchEntry), и в панели видно, что это оценка.
 */
export async function benchModel(
  id: string,
  o: {
    provider?: string;
    tile?: number;
    runs?: number;
    size?: number;
    deps?: { ort: OrtModule; ready: ReadySession; model?: ManifestModel };
  } = {},
): Promise<{ entry: BenchEntry; results: BenchResults }> {
  if (benchRunning) throw new Error("bench_busy");
  const m = o.deps?.model || findModel(id);
  if (!m) throw new Error("model_unknown");
  const tile = Math.max(64, Math.round(Number(o.tile) || m.rec?.tile || m.tile || 0) || 256);
  const size = Math.max(64, Math.round(Number(o.size) || tile));
  const runs = Math.min(10, Math.max(1, Math.round(Number(o.runs) || BENCH_RUNS)));
  const p = normalizeParams({
    model: id,
    provider: String(o.provider || "auto"),
    tile,
    overlap: 16,
    scale: m.scale || 4,
    batchFrames: 1,
  });
  const src = benchFrameSrc(size, size);
  if (!o.deps && !loadOrt()) throw new Error("runtime_missing");

  benchRunning = true;
  try {
    let best = Infinity;
    let provider = "";
    for (let i = 0; i <= runs; i++) {
      const t0 = benchNow();
      const r = await upscaleRgb({ src, w: size, h: size, p, deps: o.deps });
      const ms = benchNow() - t0;
      if (i > 0) best = Math.min(best, ms);
      provider = r.provider;
    }
    // Пачка: в каталоге предел есть не у всех моделей, поэтому выясняем его тут же
    // и запоминаем в замере — панель показывает не «пачка ?», а факт этой машины.
    const probeSize = Math.max(64, Math.min(128, tile, size));
    const batchMax = await probeBatchMax({
      src: benchFrameSrc(probeSize, probeSize),
      p,
      size: probeSize,
      side: provider === "tensorrt" ? trtProfileSize(m, tile) : probeSize,
      provider,
      scale: m.scale || 4,
      model: id,
      deps: o.deps,
    });

    const entry = benchEntry({
      model: id,
      provider,
      tile,
      batch: 1,
      batchMax,
      ms: best,
      tiles: benchTiles(tile, m, provider),
      runs,
      engine: provider === "tensorrt" ? trtEngineFor(id, trtProfileSize(m, tile)) : "",
    });
    const all = benchResults();
    // Провайдер + тайл — ключ замера: свежий заменяет старый, чужие остаются.
    const keep = (all[id] || []).filter(
      (e) => !(e.provider === entry.provider && e.tile === entry.tile),
    );
    all[id] = [entry, ...keep].slice(0, 8);
    try {
      fs.writeFileSync(benchFile(), JSON.stringify({ version: 1, results: all }, null, 2), "utf8");
    } catch (e) {
      logger.warn("upscale.bench_write", { error: String((e as Error).message).slice(0, 160) });
    }
    return { entry, results: all };
  } finally {
    benchRunning = false;
  }
}

export function estimateUpscale(
  p: UpParams,
  probe: {
    kind?: string;
    width: number;
    height: number;
    duration?: number;
    fps?: number;
    fpsNum?: number;
    fpsDen?: number;
  },
): UpEstimate {
  const kind: "photo" | "video" = probe.kind === "video" ? "video" : "photo";
  const warnings: string[] = [];
  const noUpscale = isNoUpscale(p.model);
  const want = noUpscale
    ? targetDims(probe.width, probe.height, 1, p.targetW, p.targetH)
    : targetDims(probe.width, probe.height, p.scale, p.targetW, p.targetH);
  const model = noUpscale ? null : findModel(p.model);
  if (noUpscale) {
    // Апскейл выключен: ни модели, ни её файла не ждём — предупреждать не о чем.
  } else if (!model || modelKind(model) !== "upscale") warnings.push("model_unknown");
  else if (!fs.existsSync(path.join(DIRS.upscaleModels, model.file)))
    warnings.push("model_missing");
  if (!runtimeAvailable()) warnings.push("runtime_missing");
  if (want.w * want.h > MAX_OUT_PX) warnings.push("too_large");

  const srcRate = {
    num: Math.max(0, Math.round(probe.fpsNum || 0)),
    den: Math.max(0, Math.round(probe.fpsDen || 0)),
  };
  const rate =
    srcRate.num > 0 && srcRate.den > 0
      ? srcRate
      : { num: Math.max(0, Math.round((probe.fps || 0) * 1000)), den: 1000 };

  let inFrames = 1;
  let outFrames = 1;
  let fpsOut = probe.fps || 0;
  if (kind === "video") {
    inFrames = frameLimitOrInf(probe.duration || 0, rateFps(rate), p.frameLimit);
    // Тот же предел множителя, что и при запуске: у CAIN он 2.
    const estInterpMult = Math.min(
      p.interpMult,
      interpMultMax(p.interpMode === "model" ? pickInterpModel(p.interpModel) : null),
    );
    const plan = planInterp({
      probe: {
        duration: probe.duration || 0,
        fps: probe.fps || 0,
        fpsNum: rate.num,
        fpsDen: rate.den,
      },
      mode: p.interpMode,
      mult: estInterpMult,
      minterpolateMode: p.minterpolateMode,
      side: p.minterpolateSide,
      scdThreshold: p.sceneCutThreshold,
      filters: [],
    });
    outFrames = planOutFrames(inFrames, plan.outPerIn);
    fpsOut = plan.outFps;
    if (p.interpMode === "model") {
      const im = pickInterpModel(p.interpModel);
      if (!interpRuntimeOk(im)) warnings.push("interp_model_missing");
    }
    if (p.frameLimit > 0) warnings.push("frame_limit");
  }

  const slow = SLOW_FACTORS.includes(Number(p.slowMotion)) ? Number(p.slowMotion) : 1;
  const durationSec =
    kind === "video" && fpsOut > 0 ? outFrames / fpsOut / (slow || 1) : probe.duration || 0;
  const totalMegapixels = ((want.w * want.h) / 1e6) * outFrames;
  // Без апскейла измеренная скорость ONNX-апскейла неприменима: время честно
  // не оцениваем, а не показываем цифру «от другого режима».
  const etaSec = !noUpscale && mpxPerSec > 0 ? Math.round(totalMegapixels / mpxPerSec) : null;
  if (etaSec != null && etaSec > 6 * 3600) warnings.push("too_slow");

  return {
    kind,
    outWidth: want.w,
    outHeight: want.h,
    inFrames,
    outFrames,
    fpsOut: Math.round(fpsOut * 100) / 100,
    durationSec: Math.round(durationSec * 100) / 100,
    slowMotion: slow,
    totalMegapixels: Math.round(totalMegapixels * 10) / 10,
    etaSec,
    warnings,
  };
}

/** Интерполятор-модель есть и файл на диске — иначе плавность будет дублями. */
function interpRuntimeOk(m: ManifestModel | null): boolean {
  return !!m && fs.existsSync(path.join(DIRS.upscaleModels, m.file));
}

// ================== РАЗМЕР РЕЗУЛЬТАТА ==================

/**
 * Итоговые размеры: явные targetW/targetH (сторона считается по пропорции,
 * если задана одна), иначе множитель scale. Размеры делаем чётными — этого
 * требует yuv420p у видео, да и лишним для картинок не будет.
 */
export function targetDims(
  srcW: number,
  srcH: number,
  scale: number,
  targetW: number,
  targetH: number,
): { w: number; h: number } {
  let w = targetW > 0 ? targetW : srcW * (scale || 1);
  let h = targetH > 0 ? targetH : srcH * (scale || 1);
  if (targetW > 0 && targetH <= 0) h = Math.round((w * srcH) / srcW);
  if (targetH > 0 && targetW <= 0) w = Math.round((h * srcW) / srcH);
  w = Math.max(2, w - (w % 2));
  h = Math.max(2, h - (h % 2));
  return { w, h };
}

// ================== ЗАДАНИЯ ==================
// id -> job; завершённые остаются для скачивания, самые старые вытесняет trimJobs.
