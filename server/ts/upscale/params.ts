import { execFile, spawn } from "child_process";
import os from "os";
import path from "path";
import { MAX_INTERP_MULT, ffmpegCaps, crfMax, pickHwaccel, pickVideoEncoder } from "../upscalePipeline";
import type { VideoCodec } from "../upscalePipeline";
import type { RawUpParams, UpParams, UpPreset } from "./types";
import { clamp, toBool } from "./util";
import { findModel, interpMult, listModels, modelKind } from "./manifest";
import { getCurrentJobId, trackProc } from "./procTracking";
import { targetDims } from "./bench";
import { TRT_BATCH_MAX } from "./trt";

export const NO_UPSCALE = "none";

/** Выбран режим «без апскейла» (только плавность/перекодирование). */
export function isNoUpscale(modelId: string): boolean {
  return String(modelId || "") === NO_UPSCALE;
}

/** Параметры задания: всё, что приходит из UI (multipart отдаёт строками). */
const PROVIDERS = ["auto", "cpu", "cuda", "dml", "tensorrt"];
const FORMATS = ["png", "jpeg", "webp", "avif"];
const VCODECS = ["x264", "x265", "av1"];
const AUDIO = ["copy", "aac"];
const INTERP_MODES = ["off", "ffmpeg", "model"];
const MINTERP_MODES = ["mci", "blend", "dup"];
const MINTERP_SIDES = ["decode", "encode"];
/**
 * Размеры пачки для ONNX: один `session.run` на несколько кадров экономит
 * накладные расходы. Диапазон до 128 — для мелких кадров и маленьких тайлов;
 * на больших кадрах движок сам урезает пачку по бюджету памяти
 * (см. `batchFramesFor`), чтобы не упасть с нехваткой памяти.
 */
export const BATCH_SIZES = [1, 2, 4, 8, 16, 32, 64, 128];

/**
 * Потолок и минимум бюджета оперативной памяти под одну пачку: пачка полных
 * RGB-кадров живёт в памяти до записи в энкодер, поэтому берём долю свободной.
 */
const BATCH_RAM_MAX_MB = 6 * 1024;
const BATCH_RAM_MIN_MB = 512;

/**
 * Бюджет оперативной памяти на одну пачку: ~40% свободной памяти машины, но не
 * больше 6 ГБ. Так «Авто» даёт большую пачку на мощной машине и не загоняет в
 * swap слабую.
 */
export function ramBudgetMb(): number {
  const freeMb = os.freemem() / (1024 * 1024);
  return Math.round(Math.min(BATCH_RAM_MAX_MB, Math.max(BATCH_RAM_MIN_MB, freeMb * 0.4)));
}

/**
 * Бюджет оперативной памяти под одну пачку полных кадров результата: их движок
 * создаёт заранее (`upscaleRgbBatch`). Точное значение берём из `ramBudgetMb` —
 * доля реально свободной памяти машины, а не фиксированные 1.5 ГБ.
 */

/**
 * «Авто» для пачки кадров: движок сам подбирает размер по свободной видеопамяти
 * (и по памяти под сами кадры), чтобы получить максимум скорости без OOM.
 */
export const AUTO_BATCH = 0;

/** Выбор пачки из UI: 0 — авто, иначе значение из списка (иначе — авто). */
export function batchChoiceOf(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (n === AUTO_BATCH) return AUTO_BATCH;
  return BATCH_SIZES.includes(n) ? n : AUTO_BATCH;
}

/**
 * Разбор вывода `nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits`:
 * строки вида «8151, 6525» или «NVIDIA GeForce RTX 5060 Ti, 8151, 6247» (МБ).
 * Берём два последних числа строки: имя карты тоже может содержать цифры
 * («RTX 4060»), а total/free всегда идут в конце.
 */
export function parseNvidiaSmi(out: string): { totalMb: number; freeMb: number } {
  const lines = String(out || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let totalMb = 0;
  let freeMb = 0;
  for (const line of lines) {
    const nums = (line.match(/\d+/g) || []).map(Number);
    if (nums.length < 2) continue;
    const free = nums[nums.length - 1];
    const total = nums[nums.length - 2];
    // Несколько карт: берём ту, у которой больше свободной памяти.
    if (free > freeMb) {
      freeMb = free;
      totalMb = total;
    }
  }
  return { totalMb, freeMb };
}

/** Кэш опроса видеопамяти: nvidia-smi на каждый кадр — это лишние 100 мс. */
let gpuMemAt = 0;
let gpuMemMb = 0;
const GPU_MEM_TTL_MS = 5000;

/**
 * Свободная видеопамять дискретной карты, МБ. 0 — данных нет (нет nvidia-smi,
 * встроенная графика или работаем на CPU): тогда «Авто» считает по памяти кадров.
 */
export async function gpuFreeMb(force = false): Promise<number> {
  const override = Number(process.env.MOONAPP_GPU_FREE_MB);
  if (Number.isFinite(override) && override > 0) return override;
  const now = Date.now();
  if (!force && gpuMemAt && now - gpuMemAt < GPU_MEM_TTL_MS) return gpuMemMb;
  const out = await new Promise<string>((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => resolve(err ? "" : String(stdout || "")),
    );
  });
  gpuMemMb = parseNvidiaSmi(out).freeMb;
  gpuMemAt = now;
  return gpuMemMb;
}

/** Резерв видеопамяти: контекст CUDA/Ort и фрагментация аллокатора. */
const GPU_RESERVE_MB = 512;
/** Потолок пачки: больше 128 кадров смысла нет, а очередь кадров растёт. */
export const BATCH_MAX = 128;
/**
 * Потолок «Авто»-пачки. 8 — из замеров: пачка 8 быстрее пачки 2 на ~12%, а больше
 * профиль TensorRT не примет без пересборки движка (TRT_BATCH_MAX = 8). Дальше
 * растут только буферы кадров в памяти, скорость не меняется.
 */
export const AUTO_BATCH_MAX = 8;
/**
 * Потолок «Авто»-пачки в зависимости от провайдера. TensorRT — тот же
 * TRT_BATCH_MAX, что и профиль движка (больше он всё равно не примет, см.
 * клэмп ниже по коду). На CUDA/DML/CPU профиля нет — потолок можно поднять
 * заметно выше, не больше чем вдвое от прежнего значения (8 → 16), чтобы не
 * спровоцировать OOM на GPU со скромной видеопамятью (byVram/byRam всё равно
 * урезают дальше по факту свободной памяти). Без провайдера (обратная
 * совместимость старых вызовов/тестов) — прежний AUTO_BATCH_MAX.
 */
export function autoBatchCeilingFor(provider?: string): number {
  if (!provider) return AUTO_BATCH_MAX;
  if (provider === "tensorrt") return TRT_BATCH_MAX;
  return 16;
}

/**
 * Сколько пачек кадров одновременно живёт в памяти: одна считается на GPU, вторая
 * набирается из декодера (двойная буферизация очереди в пайплайне). Раньше очередь
 * ждала ровно одну пачку, поэтому GPU простаивал, пока декодер отдаёт следующую, —
 * это и было «лестницей» из залпов и пауз.
 */
export const QUEUE_BATCHES = 2;

/**
 * «Авто»-пачка: сколько кадров влезает в свободную видеопамять и в память под
 * сами кадры.
 *
 * Считаем не «на глазок»: ONNX-пачка держит в видеопамяти float32-буферы входа
 * и выхода тайла (3 канала × 4 байта), то есть ~24 байта на пиксель тайла на
 * каждый кадр пачки. Плюс RAM-бюджет на полные кадры (RGB, 3 байта на пиксель):
 * их держит и пачка в работе, и набираемая следом.
 */
export function autoBatchFrames(o: {
  w: number;
  h: number;
  scale: number;
  /** Сторона тайла (0 — обработка кадром целиком). */
  tile: number;
  /** Свободная видеопамять в МБ (0 — нет данных). */
  freeMb: number;
  /** Размер модели в МБ: сессия занимает его ещё до пачки. */
  modelMb: number;
  /** Бюджет оперативной памяти под пачку, МБ (по умолчанию — консервативный). */
  ramBudgetMb?: number;
  /** Предел модели: 1 — пачка невозможна, N — не больше N кадров за run. */
  maxBatch?: number;
  /** Сколько пачек живёт одновременно (двойная буферизация — QUEUE_BATCHES). */
  queueBatches?: number;
  /**
   * Провайдер инференса (cpu/cuda/dml/tensorrt) — определяет потолок «Авто»
   * (см. autoBatchCeilingFor). Не задан — прежнее поведение (AUTO_BATCH_MAX).
   */
  provider?: string;
}): number {
  const px = Math.max(1, o.w) * Math.max(1, o.h);
  const s = Math.max(1, Math.round(o.scale) || 1);
  const s2 = s * s;
  const tilePx = o.tile > 0 ? o.tile * o.tile : px;
  // Видеопамять: вход+выход пачки в float32 (3 канала × 4 байта × 2 буфера).
  const vramPerFrame = (tilePx * 24) / (1024 * 1024);
  const vramBudget = o.freeMb > 0 ? Math.max(0, o.freeMb * 0.7 - o.modelMb - GPU_RESERVE_MB) : 0;
  // RAM: полные кадры (вход очереди в RGB + выход пачки в RGB), которых
  // одновременно до `queueBatches` пачек.
  const queue = Math.max(1, Math.round(o.queueBatches || QUEUE_BATCHES));
  const ramPerFrame = (px * 3 * (s2 + queue)) / (1024 * 1024);
  const ramBudget = o.ramBudgetMb && o.ramBudgetMb > 0 ? o.ramBudgetMb : ramBudgetMb();
  const autoCeiling = autoBatchCeilingFor(o.provider);
  const ceiling = Math.min(
    autoCeiling,
    o.maxBatch && o.maxBatch > 1 ? Math.min(o.maxBatch, BATCH_MAX) : autoCeiling,
  );
  const byVram = o.freeMb > 0 ? Math.floor(vramBudget / Math.max(0.01, vramPerFrame)) : ceiling;
  const byRam = Math.floor(ramBudget / Math.max(0.01, ramPerFrame));
  const fits = Math.min(byVram, byRam, ceiling);
  // Нет данных о видеопамяти (CPU или встроенная графика) — работаем по RAM.
  return Math.max(1, fits || 1);
}

/**
 * Сколько кадров реально пускать в пачку: выбор пользователя, урезанный по
 * памяти (у ONNX держим и вход, и полные кадры результата в RGB).
 *
 * Бюджеты считаются от РЕАЛЬНО свободной памяти: RAM — доля свободной памяти
 * машины (см. `ramBudgetMb`), VRAM — свободная видеопамять минус модель и
 * резерв (передаётся `freeMb`). Раньше здесь стоял фикс 1.5 ГБ, из-за которого
 * запрос 32/64 на 1080p×4 молча превращался в 14–16 кадров при 17 ГБ свободной
 * памяти. Минимум — 1 кадр (это можно всегда).
 */
export function batchFramesFor(
  requested: number,
  w: number,
  h: number,
  scale: number,
  opts?: {
    /** Свободная видеопамять, МБ (0/не задано — ограничения по VRAM нет). */
    freeMb?: number;
    /** Размер модели, МБ: сессия занимает его до пачки. */
    modelMb?: number;
    /** Сторона тайла (0 — кадр целиком): по ней считаем буферы ONNX. */
    tile?: number;
    /** Бюджет RAM под пачку, МБ (по умолчанию — доля свободной памяти машины). */
    ramBudgetMb?: number;
    /** Предел модели: 1 — пачка невозможна, N — не больше N кадров за run. */
    maxBatch?: number;
    /** Сколько пачек живёт одновременно (двойная буферизация — QUEUE_BATCHES). */
    queueBatches?: number;
  },
): number {
  const want = Math.max(0, Math.round(requested) || 0);
  if (want <= 1) return 1;
  // Модель принимает ровно один вход — пачки не будет, сколько бы ни просили.
  if (opts?.maxBatch === 1) return 1;
  const px = Math.max(1, w) * Math.max(1, h);
  const s = Math.max(1, Math.round(scale) || 1);
  // Полные кадры (вход очереди + выход пачки): движок держит их одновременно
  // до `queueBatches` пачек — очередь работает с опережением на одну пачку.
  const queue = Math.max(1, Math.round(opts?.queueBatches || QUEUE_BATCHES));
  const perFrameRam = (px * 3 * (s * s + queue)) / (1024 * 1024);
  const byRam = Math.floor(
    (opts?.ramBudgetMb && opts.ramBudgetMb > 0 ? opts.ramBudgetMb : ramBudgetMb()) /
      Math.max(0.01, perFrameRam),
  );
  // Буферы ONNX на кадр: вход+выход float32 (3 канала × 4 байта × 2) по тайлу.
  const tileSide = opts?.tile || 0;
  const tilePx = tileSide > 0 ? tileSide ** 2 : px;
  const perFrameVram = (tilePx * 24) / (1024 * 1024);
  const freeMb = opts?.freeMb || 0;
  const vramBudget =
    freeMb > 0 ? Math.max(0, freeMb * 0.7 - (opts?.modelMb || 0) - GPU_RESERVE_MB) : 0;
  const byVram = freeMb > 0 ? Math.floor(vramBudget / Math.max(0.01, perFrameVram)) : want;
  // Заявленный моделью предел важнее желания пользователя: граф с динамической
  // осью падает на n больше, чем он умеет.
  const ceiling =
    opts?.maxBatch && opts.maxBatch > 1 ? Math.min(opts.maxBatch, BATCH_MAX) : BATCH_MAX;
  return Math.max(1, Math.min(want, byRam, byVram, ceiling));
}
/** Множители замедления: 0.25 — «супер-слоумо», 1 — без замедления. */
export const SLOW_FACTORS = [1, 0.5, 0.25];

export async function encoderPlan(ffmpeg: string): Promise<{
  decode: string;
  x264: string;
  x265: string;
  av1: string;
  hardware: boolean;
}> {
  const caps = await ffmpegCaps(ffmpeg);
  const pick = (codec: VideoCodec) => pickVideoEncoder({ codec, crf: 20, caps, hw: true });
  const x264 = pick("x264");
  const x265 = pick("x265");
  const av1 = pick("av1");
  return {
    decode: pickHwaccel(caps),
    x264: x264.label,
    x265: x265.label,
    av1: av1.label,
    hardware: x264.hardware || x265.hardware || av1.hardware,
  };
}

export function normalizeParams(raw: RawUpParams): UpParams {
  const fallbackModel = listModels().find((m) => m.available)?.id || "realesr-general-x4v3";
  // «Без апскейла» — спец-значение модели: нужен режим «только плавность», когда
  // апскейлер не нужен вовсе (например 4K-источник и надо лишь поднять fps).
  const wantModel = String(raw.model || "").trim();
  const model = wantModel === NO_UPSCALE ? NO_UPSCALE : (wantModel || fallbackModel).slice(0, 60);
  // Кодек нужен раньше CRF: у AV1 шкала качества длиннее (0–63 против 0–51).
  const vcodec: VideoCodec = VCODECS.includes(String(raw.vcodec))
    ? (String(raw.vcodec) as VideoCodec)
    : "x264";
  const p: UpParams = {
    model,
    model2: String(raw.model2 || "").slice(0, 60),
    blendAmount: clamp(Number(raw.blendAmount ?? 0), 0, 100),
    scale: [2, 3, 4].includes(Number(raw.scale)) ? Number(raw.scale) : 4,
    targetW: clamp(Math.round(Number(raw.targetW ?? 0)), 0, 32768),
    targetH: clamp(Math.round(Number(raw.targetH ?? 0)), 0, 32768),
    tile: clamp(Math.round(Number(raw.tile ?? 0)), 0, 4096),
    overlap: clamp(Math.round(Number(raw.overlap ?? 16)), 0, 128),
    threads: clamp(Math.round(Number(raw.threads ?? 0)), 0, 64),
    provider: PROVIDERS.includes(String(raw.provider)) ? String(raw.provider) : "auto",
    format: FORMATS.includes(String(raw.format)) ? String(raw.format) : "png",
    quality: clamp(Math.round(Number(raw.quality ?? 100)), 1, 100),
    sharpen: clamp(Math.round(Number(raw.sharpen ?? 0)), 0, 100),
    denoise: clamp(Math.round(Number(raw.denoise ?? 0)), 0, 100),
    vcodec,
    vcrf: clamp(Math.round(Number(raw.vcrf ?? 20)), 0, crfMax(vcodec)),
    audioAction: AUDIO.includes(String(raw.audioAction)) ? String(raw.audioAction) : "copy",
    presetId: String(raw.presetId || "").slice(0, 40),
    interpMode: INTERP_MODES.includes(String(raw.interpMode)) ? String(raw.interpMode) : "off",
    interpModel: String(raw.interpModel || "").slice(0, 60),
    interpMult: clamp(Math.round(Number(raw.interpMult ?? 2)), 2, MAX_INTERP_MULT),
    minterpolateMode: MINTERP_MODES.includes(String(raw.minterpolateMode))
      ? String(raw.minterpolateMode)
      : "mci",
    minterpolateSide: MINTERP_SIDES.includes(String(raw.minterpolateSide))
      ? String(raw.minterpolateSide)
      : "decode",
    sceneCutThreshold: clamp(Math.round(Number(raw.sceneCutThreshold ?? 12)), 0, 100),
    // Пачка кадров: 0 — «Авто» (движок подберёт по видеопамяти), иначе значение
    // из списка BATCH_SIZES (1…128); на больших кадрах пачка режется по памяти.
    batchFrames: batchChoiceOf(raw.batchFrames),
    // Пачка тайлов интерполятора: вторая «пачка», отдельная от кадров апскейла
    // (интерполятор считает пару кадров и тайлит их сам).
    interpBatch: batchChoiceOf(raw.interpBatch),
    // Лимит кадров: 0 (весь файл) или 1…100000 — защита от случайного «одного кадра».
    frameLimit: clamp(Math.round(Number(raw.frameLimit ?? 0)), 0, 100000),
    slowMotion: SLOW_FACTORS.includes(Number(raw.slowMotion)) ? Number(raw.slowMotion) : 1,
    // Видеокарта: по умолчанию включена — аппаратные кодировщик и декодер
    // берутся только если сборка ffmpeg их действительно умеет (см. runVideo).
    hwAccel: toBool(raw.hwAccel, true),
  };
  if (p.model2 === p.model) p.model2 = "";
  if (p.model2 && p.blendAmount <= 0) p.blendAmount = 50;
  if (!p.model2) p.blendAmount = 0;
  return p;
}

/**
 * Системные пресеты: модели и настройки подобраны под задачу, а не «на глаз» —
 * у каждой модели в манифесте есть rec (тайл/перекрытие/резкость/шум), и пресеты
 * берут именно их. Подписи — из i18n (up.preset_<id>).
 */
export const SYSTEM_PRESETS: UpPreset[] = [
  {
    // Максимальная детализация: модель для волос, тканей и листвы.
    id: "photo-hero",
    kind: "photo",
    model: "ultrasharp-v2",
    scale: 2,
    format: "png",
    tile: 192,
    overlap: 16,
    provider: "auto",
  },
  {
    // Портреты и кожа: RealPLSKR (rec модели — денойз 25, чтобы не усилить шум кожи).
    id: "photo-portrait",
    kind: "photo",
    model: "photo-plskr",
    scale: 2,
    format: "png",
    tile: 192,
    overlap: 16,
    denoise: 25,
    provider: "auto",
  },
  {
    // Соцсети/JPEG: Nomos8k DAT против сильного сжатия (rec: тайл 128, денойз 20).
    id: "photo-restore",
    kind: "photo",
    model: "nomos8k-dat",
    scale: 2,
    format: "jpeg",
    quality: 95,
    tile: 128,
    overlap: 16,
    denoise: 20,
    provider: "auto",
  },
  {
    id: "photo-anime",
    kind: "photo",
    model: "realesrgan-anime-x4",
    scale: 2,
    format: "png",
    tile: 320,
    overlap: 16,
    provider: "auto",
  },
  {
    // Универсальный ×2: хватает для 1080p → 4K с приемлемым временем даже на CPU.
    id: "photo-2x",
    kind: "photo",
    model: "realesr-general-x4v3",
    scale: 2,
    format: "png",
    tile: 512,
    overlap: 16,
    provider: "auto",
  },
  {
    // Печать: сначала шум/зерно, потом резкость — иначе усилится шум.
    id: "photo-print",
    kind: "photo",
    model: "ultrasharp-v2",
    scale: 4,
    format: "png",
    tile: 192,
    overlap: 16,
    denoise: 15,
    sharpen: 10,
    provider: "auto",
  },
  {
    id: "photo-web",
    kind: "photo",
    model: "realesr-general-x4v3",
    scale: 2,
    format: "webp",
    quality: 90,
    tile: 512,
    overlap: 16,
    provider: "auto",
  },
  {
    // Самая лёгкая модель каталога (1.6 МБ, ~24 мс): пачка обработок на слабом CPU/GPU.
    id: "photo-fast",
    kind: "photo",
    model: "clearreality",
    scale: 2,
    format: "png",
    tile: 384,
    overlap: 16,
    provider: "auto",
  },
  {
    id: "video-hd",
    kind: "video",
    model: "realesr-general-wdn",
    scale: 2,
    tile: 384,
    overlap: 16,
    vcodec: "x264",
    vcrf: 18,
    audioAction: "copy",
    provider: "auto",
  },
  {
    id: "video-4k",
    kind: "video",
    model: "realesr-general-wdn",
    scale: 4,
    tile: 288,
    overlap: 16,
    vcodec: "x265",
    vcrf: 20,
    audioAction: "copy",
    provider: "auto",
  },
  {
    // Быстрое превью: крупный тайл и меньший CRF-вес — посмотреть результат
    // до длинного прогона.
    id: "video-fast",
    kind: "video",
    model: "realesr-general-x4v3",
    scale: 2,
    tile: 512,
    overlap: 8,
    vcodec: "x264",
    vcrf: 22,
    audioAction: "copy",
    provider: "auto",
  },
  {
    // 4K + плавность: ×4 апскейл и ×2 кадров за один проход (одно перекодирование).
    id: "video-smooth-4k",
    kind: "video",
    model: "ultrasharp-v2-lite",
    scale: 2,
    tile: 288,
    overlap: 16,
    vcodec: "x265",
    vcrf: 20,
    audioAction: "copy",
    provider: "auto",
    interpMode: "ffmpeg",
    interpMult: 2,
    minterpolateMode: "mci",
    minterpolateSide: "decode",
    sceneCutThreshold: 12,
  },
  {
    // Плавность без моделей: ffmpeg minterpolate работает сразу после установки
    // ffmpeg. ×2 при 30 fps → 60 fps, при 25 → 50 (это и нужно большинству
    // мониторов); интерполяция считается ДО апскейла, на исходном разрешении.
    id: "video-smooth60",
    kind: "video",
    model: "realesr-general-wdn",
    scale: 2,
    tile: 384,
    overlap: 16,
    vcodec: "x264",
    vcrf: 18,
    audioAction: "copy",
    provider: "auto",
    interpMode: "ffmpeg",
    interpMult: 2,
    minterpolateMode: "mci",
    minterpolateSide: "decode",
    sceneCutThreshold: 12,
  },
  {
    // Плавность интерполятором-моделью: картинка глаже minterpolate, но на CPU
    // это единицы кадров в секунду — для коротких клипов. Вставки считаем ПОСЛЕ
    // апскейла: апскейл (самая дорогая часть) работает по исходным кадрам.
    id: "video-interp-rife",
    kind: "video",
    model: "realesr-general-wdn",
    scale: 2,
    tile: 256,
    overlap: 16,
    vcodec: "x264",
    vcrf: 18,
    audioAction: "copy",
    provider: "auto",
    interpMode: "model",
    interpModel: "rife-v49",
    interpMult: 2,
    minterpolateSide: "encode",
    sceneCutThreshold: 12,
  },
  {
    // Слоумо: ×2 кадров и замедление 0.5 — итог вдвое медленнее и вдвое плавнее.
    id: "video-slowmo",
    kind: "video",
    model: "realesr-general-wdn",
    scale: 2,
    tile: 256,
    overlap: 16,
    vcodec: "x264",
    vcrf: 20,
    audioAction: "aac",
    provider: "auto",
    interpMode: "ffmpeg",
    interpMult: 2,
    minterpolateMode: "mci",
    minterpolateSide: "decode",
    slowMotion: 0.5,
  },
  {
    // Быстрая проба настроек: 60 кадров пачками по 4 — видно качество и скорость
    // за секунды, а не за часы.
    id: "video-preview",
    kind: "video",
    model: "realesr-general-x4v3",
    scale: 2,
    tile: 384,
    overlap: 16,
    vcodec: "x264",
    vcrf: 26,
    audioAction: "copy",
    provider: "auto",
    frameLimit: 60,
    batchFrames: 4,
  },
  {
    // Восстановление сжатого видео: сначала шум/артефакты, потом апскейл.
    id: "video-restore",
    kind: "video",
    model: "nerve-4x",
    scale: 2,
    tile: 192,
    overlap: 16,
    denoise: 20,
    vcodec: "x265",
    vcrf: 22,
    audioAction: "copy",
    provider: "auto",
  },
  {
    // Аниме-видео: Real-CUGAN чистит артефакты сжатия и не «дёргает» контуры.
    id: "video-anime-cugan",
    kind: "video",
    model: "real-cugan-2x-anime",
    scale: 2,
    tile: 384,
    overlap: 16,
    denoise: 20,
    vcodec: "x264",
    vcrf: 18,
    audioAction: "copy",
    provider: "auto",
  },
  {
    // Аниме-видео «на скорость»: Anime4K ×3 — самый лёгкий вариант из аниме-моделей.
    id: "video-anime-anime4k",
    kind: "video",
    model: "anime4k-x3-l",
    scale: 3,
    tile: 512,
    overlap: 16,
    vcodec: "x264",
    vcrf: 20,
    audioAction: "copy",
    provider: "auto",
  },
  {
    // Долгие видео: компактная модель (2.4 МБ) — покадровая обработка почти без пауз.
    id: "video-compact",
    kind: "video",
    model: "realesr-compact-x4",
    scale: 2,
    tile: 512,
    overlap: 8,
    vcodec: "x264",
    vcrf: 20,
    audioAction: "copy",
    provider: "auto",
  },
  {
    // Аниме-арт: Real-CUGAN 4× «осторожный» — детализация без пересвета.
    id: "photo-anime-cugan",
    kind: "photo",
    model: "real-cugan-4x",
    scale: 4,
    format: "png",
    tile: 384,
    overlap: 16,
    provider: "auto",
  },
];

/**
 * Оптимальные настройки для модели (поле rec в манифесте) — то, что подставляет
 * кнопка «Применить» в панели моделей. Для интерполятора включаем плавность
 * моделью и ставим множитель со порогом сцены вместо тайлинга апскейла.
 */
export function modelRecommended(id: string): Partial<UpParams> | null {
  const m = findModel(id);
  if (!m) return null;
  const r = m.rec || {};
  if (modelKind(m) === "interp") {
    return {
      interpMode: "model",
      interpModel: m.id,
      interpMult: r.interpMult ?? interpMult(m),
      sceneCutThreshold: r.sceneCut ?? 12,
      presetId: "",
    };
  }
  return {
    model: m.id,
    scale: r.scale ?? m.scale ?? 4,
    tile: r.tile ?? m.tile ?? 0,
    overlap: r.overlap ?? m.overlap ?? 16,
    sharpen: r.sharpen ?? 0,
    denoise: r.denoise ?? 0,
    presetId: "",
  };
}

// ================== ПИКСЕЛЬНЫЙ I/O ЧЕРЕЗ FFMPEG ==================
// Декодирование/кодирование картинок делаем уже имеющимся ffmpeg: свой PNG/JPEG
// парсер не нужен, а второй нативной библиотеки (sharp) в проекте нет.

/**
 * Запуск процесса с захватом stdout в буфер (rawvideo может быть десятки МБ).
 *
 * Через `spawn`, а не `execFile`: процесс надо зарегистрировать в реестре
 * задания, иначе «Стоп» не убьёт декодер/энкодер фото (раньше именно так и было —
 * фото-путь жил своей жизнью до самого конца).
 */
export function runCapture(cmd: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    trackProc(getCurrentJobId(), "capture", proc);
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const finish = (err: Error | null, out?: Buffer) => {
      if (failed) return;
      failed = true;
      if (!proc.killed) {
        try {
          proc.kill();
        } catch {
          /* уже мёртв */
        }
      }
      if (err) reject(err);
      else resolve(out as Buffer);
    };
    proc.stdout.on("data", (d: Buffer) => {
      if (failed) return;
      size += d.length;
      if (size > maxBuffer) {
        finish(new Error("capture_overflow"));
        return;
      }
      chunks.push(d);
    });
    proc.stderr?.on("data", () => {
      /* хвост не нужен: ошибку опишет код выхода */
    });
    proc.on("error", (e) => finish(e as Error));
    proc.on("close", (code) => {
      if (code === 0) finish(null, Buffer.concat(chunks, size));
      else finish(new Error(`capture_failed:${code}`));
    });
  });
}

/** Максимум пикселей результата: защита от OOM на огромных апскейлах ×4. */
export const MAX_OUT_PX = 240_000_000;

/**
 * Фильтры ffmpeg: сначала приведение к запрошенному размеру (если модель даёт
 * не тот множитель, что выбрал пользователь), затем резкость.
 */
export function buildFilters(o: {
  srcW: number;
  srcH: number;
  nativeScale: number;
  scale: number;
  targetW: number;
  targetH: number;
  sharpen: number;
}): string[] {
  const filters: string[] = [];
  const nativeW = o.srcW * o.nativeScale;
  const nativeH = o.srcH * o.nativeScale;
  const want = targetDims(o.srcW, o.srcH, o.scale, o.targetW, o.targetH);
  if (want.w !== nativeW || want.h !== nativeH) {
    filters.push(`scale=${want.w}:${want.h}:flags=lanczos`);
  }
  if (o.sharpen > 0) {
    const amount = (o.sharpen / 100) * 1.5;
    filters.push(`unsharp=5:5:${amount.toFixed(2)}:5:5:0`);
  }
  return filters;
}

/** Декодирование файла в rgb24 (с необязательным шумоподавлением до апскейла). */
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".gif"];

/** Картинка или видео — по расширению исходника. */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.includes(path.extname(String(name || "")).toLowerCase());
}

/** Имя результата-картинки: множитель формата берётся из настроек. */
export function photoOutName(inputName: string, format: string): string {
  const stem = String(inputName || "photo").replace(/\.[^.]+$/, "") || "photo";
  const ext = format === "jpeg" ? "jpg" : format;
  return `${stem}_upscaled.${ext}`;
}

// ================== ИНФЕРЕНС: ТАЙЛ → ONNX → СКЛЕЙКА ==================

/**
 * Кусок картинки → вход ONNX: NCHW, float32, [0,1] (порядок каналов — по модели).
 *
 * Раскладка именно ПЛОСКАЯ (плоскости R, G, B подряд): так объявлены тензоры
 * моделей — вход `[batch,3,height,width]` (проверено по заголовку
 * realesr-general-x4v3.onnx) — и так же читается выход в blendTile. Если писать
 * сюда пиксельно-перемешанные байты (R,G,B,R,G,B…), модель получит чужие каналы
 * и результат будет мусором.
 */
