/**
 * Видео-пайплайн апскейла: порт логики Video2X на Node/TypeScript.
 *
 * Схема (без промежуточных файлов на диске):
 *   1) РАСПАКОВКА — длительно живущий ffmpeg отдаёт кадры в stdout как
 *      rawvideo/rgb24 (это и есть «extract frames», только не в PNG-секвенцию,
 *      а в память: PNG-секвенция 1080p×10 мин съедала десятки ГБ на диске).
 *   2) ОБРАБОТКА — кадры по одному уходят в колбэк processFrame (ONNX-апскейл,
 *      см. server/ts/upscale.ts). Чтение из stdout приостанавливается
 *      (backpressure), пока кадр не обработан, — память ограничена одним кадром.
 *   3) СБОРКА — второй длительно живущий ffmpeg читает обработанные rgb24 из
 *      stdin, а звук и субтитры БЕРЁТ ИЗ ОРИГИНАЛА КОПИЕЙ (-c:a copy -c:s copy),
 *      т.е. без потери качества.
 *
 * Модуль намеренно НЕ знает про onnxruntime: обработку кадра передаёт движок
 * (server/ts/upscale.ts), поэтому циклического импорта нет, а чистые функции
 * (parseFps, parseRate, planFrames, planOutFrames, buildMinterpolateFilter,
 * buildDecodeArgs, buildEncodeArgs) тестируются без ffmpeg, моделей и GPU.
 */
import { spawn, execFile } from "child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "child_process";

/** Что мы узнали про исходное видео (ffprobe). */
export interface MediaProbe {
  width: number;
  height: number;
  /** Округлённая частота — для UI и для совместимости с v1. */
  fps: number;
  /**
   * Точная частота кадров дробью из avg_frame_rate. Нужна там, где важна
   * арифметика (интерполяция, `-r num/den`): 29.97 — это 30000/1001, и
   * `-r 30` дал бы дрейф звука.
   */
  fpsNum: number;
  fpsDen: number;
  duration: number;
  hasAudio: boolean;
  hasSubs: boolean;
  codec: string;
}

/** Обработанный кадр: rgb24-байты + его размеры (апскейл меняет их). */
export interface ProcessedFrame {
  data: Buffer;
  width: number;
  height: number;
}

export type ProcessFrameFn = (
  rgb: Buffer,
  index: number,
  w: number,
  h: number,
) => Promise<ProcessedFrame>;

/** Прогресс: кадры + мгновенная скорость + честный ETA. */
export interface PipelineProgress {
  /** Кадров на выходе (с вставками интерполяции, если она включена). */
  framesDone: number;
  framesTotal: number;
  /** Кадров исходника обработано — видно, сколько «настоящих» кадров позади. */
  inFramesDone: number;
  /** Частота кадров результата: для бейджа «29.97 → 59.94 fps» в UI. */
  outFps: number;
  fps: number;
  etaSec: number;
}

export interface VideoPipelineOptions {
  ffmpeg: string;
  ffprobe: string;
  inputPath: string;
  outFile: string;
  probe: MediaProbe;
  /**
   * Кодировщик, выбранный под конкретную сборку ffmpeg (см. pickVideoEncoder):
   * жёстко прописанный libsvtav1 падал в сборках без SVT-AV1.
   */
  encoder: string;
  /** Параметры качества выбранного кодировщика. */
  qualityArgs: string[];
  /** Метод `-hwaccel` для распаковки на видеокарте ("" — только CPU). */
  decodeHwaccel?: string;
  audioAction: "copy" | "aac";
  /** Дополнительные -vf фильтры энкодера (приведение к целевому размеру, резкость). */
  filters?: string[];
  /** Дополнительные -vf фильтры декодера (интерполяция «до апскейла»). */
  decodeFilters?: string[];
  /**
   * Частота кадров, идущих по pipe (decode side). По умолчанию = probe.fps.
   * При интерполяции на стороне декодера здесь уже удвоенная частота.
   */
  pipeRateNum?: number;
  pipeRateDen?: number;
  /**
   * Частота кадров энкодинга. По умолчанию = pipeRate × outPerIn.
   * Задаётся явно, когда интерполяция идёт в фильтрах энкодера.
   */
  outRateNum?: number;
  outRateDen?: number;
  /** Сколько выходных кадров даёт один входной (1 в режиме «как есть»). */
  outPerIn?: number;
  /**
   * Вставка промежуточных кадров: (предыдущий_выход, текущий_выход, индекс) →
   * кадры МЕЖДУ ними. Порядок выдачи: up₀ → ins(up₀,up₁) → up₁ → …; для
   * последнего кадра вставок не бывает. При mult=1 не вызывается вовсе.
   *
   * Какой кадр приходит в колбэк, зависит от `interpSide`: при `encode` — уже
   * увеличенный (интерполяция после апскейла), при `decode` — исходный.
   */
  interpolate?: (prev: ProcessedFrame, cur: ProcessedFrame, index: number) => Promise<Buffer[]>;
  /**
   * Где считаются вставки: `encode` (по умолчанию) — после апскейла, `decode` —
   * до него (`interpolate` получает исходные кадры, а апскейлер — уже умноженный
   * поток). Второй вариант дороже по инференсу, но вставки считаются дешевле.
   */
  interpSide?: "decode" | "encode";
  /**
   * Пакетная обработка кадров: (кадры, индекс первого) → результаты в том же
   * порядке. Нужна для ONNX: один `session.run` на пачку тайлов дешевле, чем
   * по одному кадру. Размер пачки — `batchFrames`.
   */
  processFrames?: (frames: Buffer[], startIndex: number) => Promise<ProcessedFrame[]>;
  /** Размер пачки для processFrames (1 — обработка по одному кадру). */
  batchFrames?: number;
  /**
   * Сколько пачек держать в памяти одновременно (по умолчанию 1 — очередь ждёт
   * обработку). 2 — двойная буферизация: пока GPU считает пачку, декодер набирает
   * следующую. Движок передаёт `QUEUE_BATCHES` из upscale.ts.
   */
  queueBatches?: number;
  /** Обработать только первые N кадров исходника (превью, экономия времени). */
  frameLimit?: number;
  /** Замедление результата: 1 — как есть, 0.5 — вдвое медленнее, 0.25 — вчетверо. */
  slowMotion?: number;
  /** Копировать метаданные и главы оригинала в результат (-map_metadata/-map_chapters). */
  metadata?: boolean;
  /**
   * Покадровая обработка (ONNX-апскейл). Не задана — кадр идёт в энкодер как
   * есть: это режим «только плавность/перекодирование», без апскейла.
   */
  processFrame?: ProcessFrameFn;
  onProgress: (p: PipelineProgress) => void;
  /** Внешний стоп (удаление задания): проверяется между кадрами. */
  shouldStop?: () => boolean;
  /**
   * Пауза: кадры и процессы остаются живыми, обработка стоит.
   *
   * Проверяется между кадрами и перед каждой пачкой — декодер при этом стоит
   * (пайп заполняется и ffmpeg сам засыпает), а выгрузка моделей не происходит:
   * возобновление продолжается ровно с того кадра, на котором остановились.
   */
  isPaused?: () => boolean;
  /**
   * Регистрация ffmpeg-процессов задания: движок хранит их, чтобы по «Стоп»
   * погасить оба (декодер и энкодер) немедленно, не дожидаясь пайплайна.
   * `proc === null` — процесс закрылся.
   */
  onProc?: (kind: "decode" | "encode", proc: ChildProcess | null) => void;
  /** Вход в паузу/выход из неё — для журнала (состояние задания меняет API). */
  onPaused?: (paused: boolean) => void;
}

// ================== ЧИСТЫЕ ФУНКЦИИ (тестируются без ffmpeg) ==================

/**
 * Точная частота кадров дробью: "30000/1001" → {30000,1001}; "29.97" → {2997,100};
 * "25" → {25,1}; мусор и 0 → {0,0}. Нужна для `-r num/den` и для интерполяции:
 * округление до целого на 23.976/29.97 копит дрейф звука.
 */
export function parseRate(raw: string | number | undefined): { num: number; den: number } {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return { num: 0, den: 0 };
    // Тысячных достаточно: 23.976 / 29.97 / 59.94 именно так и записываются.
    return reduceRate(Math.round(raw * 1000), 1000);
  }
  const s = String(raw || "").trim();
  if (!s) return { num: 0, den: 0 };
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    return num > 0 && den > 0 ? reduceRate(num, den) : { num: 0, den: 0 };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { num: 0, den: 0 };
  return reduceRate(Math.round(n * 1000), 1000);
}

/** НОД — чтобы "50/2" не попадал в аргументы ffmpeg как есть. */
function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

/** Сокращение дроби частоты; нули остаются нулями. */
export function reduceRate(num: number, den: number): { num: number; den: number } {
  if (!(num > 0) || !(den > 0)) return { num: 0, den: 0 };
  const n = Math.round(num);
  const d = Math.round(den);
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

/** Частота в виде числа (для ETA и планирования кадров). */
export function rateFps(r: { num: number; den: number }): number {
  return r.den > 0 ? r.num / r.den : 0;
}

/**
 * Пара num/den из полей задания: обе части заданы — берём их (с сокращением),
 * иначе считаем из округлённой частоты. Нужна, чтобы вызывающий код мог не
 * знать про дроби, а `-r` всё равно получал 30000/1001 вместо 30.
 */
export function effectiveRate(
  num?: number,
  den?: number,
  fallbackFps = 0,
): { num: number; den: number } {
  if (num && num > 0 && den && den > 0) return reduceRate(num, den);
  return parseRate(fallbackFps);
}

/**
 * Частота, умноженная на множитель интерполяции: 30000/1001 ×2 → 60000/1001.
 * Множитель округляем и снизу ограничиваем единицей — иначе делим на ноль.
 */
export function outRate(num: number, den: number, mult: number): { num: number; den: number } {
  const m = Math.max(1, Math.round(mult || 1));
  return reduceRate(num * m, den);
}

/**
 * Частота для фильтра: ["-vf", "fps=30000/1001"]. Фильтр `fps` заодно приводит
 * VFR-исходник к CFR — без этого шаг между кадрами «плавает» и интерполятор
 * (особенно модель) даёт артефакты.
 */
export function fpsFilterArgs(num: number, den: number): string[] {
  const r = reduceRate(num, den);
  if (!r.den) return [];
  return ["-vf", `fps=${r.num}/${r.den}`];
}

/** "30000/1001" → 29.97; "25" → 25; мусор → 0. */
export function parseFps(raw: string | number | undefined): number {
  return rateFps(parseRate(raw));
}

/** Сколько кадров ждём на выходе; 0 длительность → 0 (тотал неизвестен). */
export function planFrames(duration: number, fps: number): number {
  if (!(duration > 0) || !(fps > 0)) return 0;
  return Math.max(1, Math.round(duration * fps));
}

/**
 * Сколько кадров даст интерполяция с множителем mult: между n кадрами
 * (n−1) перехода, каждый добавляет (mult−1) вставок.
 *   n=100, ×2 → 199; n=100, ×3 → 298; n=1 → 1; mult≤1 → n.
 */
export function planOutFrames(inFrames: number, mult: number): number {
  const n = Math.max(0, Math.round(inFrames || 0));
  if (!n) return 0;
  const m = Math.max(1, Math.round(mult || 1));
  return (n - 1) * m + 1;
}

/**
 * Сколько промежуточных кадров вставить ПЕРЕД входным кадром с этим индексом
 * (0-based): у первого кадра вставок нет, у всех остальных — (mult−1). Именно
 * по такому счёту кадры пишутся в энкодер, и по нему же проверяем результат
 * интерполятора — лишний или пропущенный вставленный кадр сдвигает звук.
 */
export function insertsBefore(index: number, mult: number): number {
  if (!(index > 0)) return 0;
  return Math.max(0, Math.round(mult || 1) - 1);
}

/** Байт в одном rgb24-кадре заданного размера. */
export function frameBytes(width: number, height: number): number {
  return Math.max(0, Math.round(width) * Math.round(height) * 3);
}

/**
 * Насколько сильно отличаются два rgb24-кадра (0–100).
 *
 * Считаем по прореженной яркости (каждый `step`-й пиксель): полноценный обход
 * 4K-кадра на каждом переходе стоил бы дороже самого интерполятора. Шкала та же,
 * что у `scd_threshold` minterpolate, поэтому порог смены сцены один на оба
 * режима плавности — и его можно задать одним ползунком в UI.
 */
export function frameDiffScore(
  prev: Uint8Array,
  cur: Uint8Array,
  w: number,
  h: number,
  step = 8,
): number {
  if (!(w > 0) || !(h > 0)) return 0;
  const st = Math.max(1, Math.round(step));
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += st) {
    let i = y * w * 3;
    for (let x = 0; x < w; x += st, i += st * 3) {
      if (i + 2 >= prev.length || i + 2 >= cur.length) break;
      // Яркость без делений: 0.299R + 0.587G + 0.114B, коэффициенты ×1000.
      const a = 299 * prev[i] + 587 * prev[i + 1] + 114 * prev[i + 2];
      const b = 299 * cur[i] + 587 * cur[i + 1] + 114 * cur[i + 2];
      sum += Math.abs(a - b) / 255000;
      n++;
    }
  }
  if (!n) return 0;
  return Math.min(100, (sum / n) * 100);
}

/**
 * Смена сцены: средняя разница кадров выше порога (шкала 0–100). На склейке
 * интерполятор «склеил» бы два разных плана и в кадре появились бы двойники,
 * поэтому такой переход отдаём дублями — частота и длительность сохраняются,
 * звук (`-c:a copy`) остаётся синхронным.
 */
export function isSceneCut(
  prev: Uint8Array,
  cur: Uint8Array,
  w: number,
  h: number,
  threshold: number,
  step = 8,
): boolean {
  if (!(threshold > 0)) return false;
  return frameDiffScore(prev, cur, w, h, step) > threshold;
}

/**
 * Дубли вместо вставок: последний показанный кадр повторяется столько раз,
 * сколько дал бы интерполятор. Копий не делаем — буфер только читается.
 */
export function staticDuplicates(frame: Buffer, count: number): Buffer[] {
  const n = Math.max(0, Math.round(count || 0));
  return Array.from({ length: n }, () => frame);
}

/**
 * Распаковка: input → rawvideo/rgb24 в stdout.
 *
 * Фильтры (`-vf`) нужны для интерполяции «до апскейла»: minterpolate на 1080p
 * в разы дешевле, чем на 4K, поэтому по умолчанию плавность считается здесь,
 * а ONNX-апскейл получает уже большее число кадров.
 *
 * `frameLimit` — только первые N кадров (превью «посмотреть на куске»). Кладём
 * это в аргументы декодера, а не убиваем процесс: `-frames:v` как выходная
 * опция завершает декодер с кодом 0, тогда как kill дал бы «ошибку декодера».
 *
 * `-map 0:V:0` — берём именно видеопоток: `V` исключает обложки (attached_pic),
 * которые ffmpeg иначе мог выбрать как «лучший» поток, и вместо фильма в
 * пайплайн уходил один кадр PNG-обложки.
 *
 * `hwaccel` (cuda/qsv/d3d11va/…) переносит распаковку на видеокарту; кадры
 * всё равно отдаются в системную память — дальше их читает ONNX.
 */
export function buildDecodeArgs(
  inputPath: string,
  filters?: string[],
  frameLimit = 0,
  hwaccel = "",
): string[] {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (hwaccel) args.push("-hwaccel", hwaccel);
  args.push("-i", inputPath, "-map", "0:V:0");
  if (filters && filters.length) args.push("-vf", filters.join(","));
  const limit = Math.max(0, Math.round(frameLimit || 0));
  if (limit > 0) args.push("-frames:v", String(limit));
  args.push("-f", "rawvideo", "-pix_fmt", "rgb24", "-");
  return args;
}

/**
 * Фильтры замедления звука: `atempo` принимает 0.5…100, поэтому для 0.25×
 * цепочка из двух звенев — иначе ffmpeg отказывается работать с 0.25.
 */
export function slowAudioFilters(slow: number): string[] {
  const s = Math.max(0.05, Math.min(1, slow || 1));
  if (s === 1) return [];
  const out: string[] = [];
  let rest = s;
  while (rest < 0.5) {
    out.push("atempo=0.5");
    rest /= 0.5;
  }
  out.push(`atempo=${rest.toFixed(4)}`);
  return out;
}

/**
 * Замедление видео: `setpts=PTS/slow` растягивает таймстемпы (0.5 — вдвое
 * медленнее). Ставим последним фильтром: сначала апскейл/интерполяция, потом
 * уже растяжка времени, иначе minterpolate считал бы по растянутым меткам.
 */
export function slowMotionFilter(slow: number): string[] {
  const s = Math.max(0.05, Math.min(1, slow || 1));
  return s === 1 ? [] : [`setpts=${(1 / s).toFixed(4)}*PTS`];
}

/**
 * Верхняя граница множителя интерполяции: ×4 — уже редкость, а ×8 превращает
 * 30-секундный клип в часы на CPU.
 */
export const MAX_INTERP_MULT = 4;

/**
 * Фильтры ffmpeg-интерполяции кадров: `fps=<вход>,minterpolate=fps=<выход>:…`.
 *
 * - `fps=…` первым — приводит VFR к CFR (иначе шаг между кадрами «плавает»);
 * - `mi_mode=dup` — просто дубли (быстро, для «проверить плавность»);
 *   `blend` — линейное смешивание кадров (дёшево, но «призраки» в движении);
 *   `mci` — оценка движения (лучшее качество, самая большая цена);
 * - `scd=fdiff` + `scd_threshold` — на склейке сцен возвращаем дубли: иначе
 *   интерполятор «склеивает» два разных плана и в кадре появляются двойники.
 */
export function buildMinterpolateFilter(o: {
  mode: "mci" | "blend" | "dup";
  inNum: number;
  inDen: number;
  outNum: number;
  outDen: number;
  scdThreshold: number;
  searchParam?: number;
  vsbmc?: boolean;
}): string[] {
  const inR = reduceRate(o.inNum, o.inDen);
  const outR = reduceRate(o.outNum, o.outDen);
  if (!inR.den || !outR.den) return [];
  const opts: string[] = [`fps=${outR.num}/${outR.den}`];
  if (o.mode === "blend") {
    opts.push("mi_mode=blend");
  } else if (o.mode === "dup") {
    opts.push("mi_mode=dup");
  } else {
    opts.push("mi_mode=mci", "mc_mode=aobmc", "me_mode=bidir", "vsbmc=1");
    if (o.vsbmc === false) opts[opts.length - 1] = "vsbmc=0";
    if (o.searchParam && o.searchParam > 0) {
      opts.push(`search_param=${Math.max(4, Math.min(1024, Math.round(o.searchParam)))}`);
    }
    opts.push(
      "scd=fdiff",
      `scd_threshold=${Math.max(0, Math.min(100, Math.round(o.scdThreshold)))}`,
    );
  }
  return [`fps=${inR.num}/${inR.den}`, `minterpolate=${opts.join(":")}`];
}

/**
 * План интерполяции для видео-задания: где считается фильтр, с какими
 * частотами идёт pipe и что получит энкодер. Чистая функция — её проверяют
 * тесты, а runVideo (server/ts/upscale.ts) только исполняет результат.
 */
export interface InterpPlan {
  /** off | ffmpeg (minterpolate) | model (ONNX-интерполятор). */
  kind: "off" | "ffmpeg" | "model";
  /** Интерполяция включена. */
  on: boolean;
  /** Фильтры для декодера (интерполяция «до апскейла», либо CFR для модели). */
  decodeFilters: string[];
  /** Фильтры для энкодера: базовые + интерполяция «после апскейла». */
  encodeFilters: string[];
  /** Частота кадров, идущих по pipe. */
  pipeRate: { num: number; den: number };
  /** Частота кадров результата. */
  outRate: { num: number; den: number };
  outFps: number;
  /** Сколько выходных кадров даёт один входной (1 — интерполяцию делает ffmpeg). */
  outPerIn: number;
  /**
   * Где считаются вставки нашей моделью: `decode` — до апскейла (интерполятор
   * работает на исходном разрешении, а апскейл считает в mult раз больше кадров),
   * `encode` — после апскейла (апскейл считает исходные кадры, интерполятор —
   * увеличенные). У ffmpeg-режима это сторона фильтра minterpolate.
   */
  interpSide: "decode" | "encode";
  /** Сколько кадров ожидаем на выходе (для прогресса). */
  framesTotal: number;
}

export function planInterp(o: {
  probe: { duration: number; fps: number; fpsNum: number; fpsDen: number };
  /** off | ffmpeg | model. */
  mode: string;
  mult: number;
  minterpolateMode: string;
  /** decode | encode — на какой стороне считать minterpolate (режим ffmpeg). */
  side: string;
  scdThreshold: number;
  /** Базовые фильтры энкодера (scale, unsharp) — интерполяция встаёт после них. */
  filters: string[];
}): InterpPlan {
  const src = effectiveRate(o.probe.fpsNum, o.probe.fpsDen, o.probe.fps);
  const mult = Math.max(1, Math.round(o.mult || 1));
  const ffmpegOn = o.mode === "ffmpeg" && mult > 1 && src.den > 0;
  const modelOn = o.mode === "model" && mult > 1 && src.den > 0;
  const on = ffmpegOn || modelOn;
  const outR = outRate(src.num, src.den, on ? mult : 1);
  const outFps = rateFps(outR) || o.probe.fps;
  const toScale = on && src.num !== outR.num;

  if (modelOn) {
    // Вставки считает наш движок (ONNX): энкодер получает уже готовые кадры,
    // поэтому фильтров интерполяции у него нет.
    //
    // Кадров в энкодере всегда N×mult, то есть по pipe идёт уже ВЫХОДНАЯ частота —
    // независимо от того, где мы считаем вставки (до апскейла или после). Если
    // отдать туда исходную частоту, ffmpeg растянет видео в mult раз, а `-shortest`
    // обрежет его по звуку.
    //
    // `fps` в декодере нужен для VFR-исходников: шаг между кадрами «плавает», и
    // интерполятор считал бы вставку не на t=0.5, а как получится.
    return {
      kind: "model",
      on: true,
      decodeFilters: toScale ? [`fps=${src.num}/${src.den}`] : [],
      encodeFilters: o.filters,
      pipeRate: outR,
      outRate: outR,
      outFps,
      outPerIn: mult,
      // decode — интерполяция до апскейла: апскейлер посчитает mult× кадров
      // (дороже, но вставки рождаются из исходных кадров), encode — после.
      interpSide: o.side === "decode" ? "decode" : "encode",
      framesTotal: planOutFrames(planFrames(o.probe.duration, rateFps(src)), mult),
    };
  }

  const interp = ffmpegOn
    ? buildMinterpolateFilter({
        mode: o.minterpolateMode as "mci" | "blend" | "dup",
        inNum: src.num,
        inDen: src.den,
        outNum: outR.num,
        outDen: outR.den,
        scdThreshold: o.scdThreshold,
      })
    : [];
  const decodeSide = o.side !== "encode";
  const decodeFilters = ffmpegOn && decodeSide ? interp : [];
  const encodeFilters = ffmpegOn && !decodeSide ? [...o.filters, ...interp] : o.filters;
  // На стороне декодера промежуточные кадры рождаются до ONNX, поэтому по pipe
  // идёт уже выходная частота; на стороне энкодера pipe — исходный fps.
  const pipeRate = decodeFilters.length ? outR : src;
  return {
    kind: ffmpegOn ? "ffmpeg" : "off",
    on: ffmpegOn,
    decodeFilters,
    encodeFilters,
    pipeRate,
    outRate: outR,
    outFps,
    outPerIn: 1,
    interpSide: decodeSide ? "decode" : "encode",
    framesTotal: planFrames(o.probe.duration, rateFps(pipeRate)),
  };
}

// ================== ВОЗМОЖНОСТИ СБОРКИ FFMPEG ==================
// Сборки ffmpeg сильно разные: в gyan «essentials» есть NVENC/QSV, но нет
// libsvtav1, в вендорной — наоборот. Поэтому кодировщик не хардкодим, а
// выбираем из того, что сборка реально умеет (`ffmpeg -encoders`).

/** Кодек результата: у нас три «ручки» в UI. */
export type VideoCodec = "x264" | "x265" | "av1";

/** Что умеет конкретная сборка ffmpeg (кэшируется по пути к бинарю). */
export interface FfmpegCaps {
  encoders: Set<string>;
  hwaccels: Set<string>;
}

/** Аппаратные кодировщики по кодекам: первый доступный и выигрывает. */
const HW_ENCODERS: Record<VideoCodec, string[]> = {
  x264: ["h264_nvenc", "h264_qsv", "h264_amf"],
  x265: ["hevc_nvenc", "hevc_qsv", "hevc_amf"],
  av1: ["av1_nvenc", "av1_qsv", "av1_amf"],
};

/** Программные кодировщики: lib* есть почти везде, но не все сразу. */
const SW_ENCODERS: Record<VideoCodec, string[]> = {
  x264: ["libx264", "libopenh264"],
  x265: ["libx265", "libkvazaar"],
  av1: ["libsvtav1", "libaom-av1", "librav1e"],
};

/** Максимум CRF у кодека: у AV1 шкала 0–63, у H.264/HEVC — 0–51. */
export function crfMax(codec: VideoCodec): number {
  return codec === "av1" ? 63 : 51;
}

/** Разбор `ffmpeg -encoders`: строки вида " V....D libsvtav1   SVT-AV1(…)". */
export function parseEncoders(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = /^\s*([A-Z.]{6})\s+(\S+)/.exec(line);
    if (m) out.add(m[2]);
  }
  return out;
}

/** Вывод `ffmpeg -hwaccels`: cuda / qsv / d3d11va / dxva2 / amf / vaapi … */
export function parseHwaccels(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const name = line.trim().toLowerCase();
    if (/^[a-z0-9_]+$/.test(name)) out.add(name);
  }
  return out;
}

const capsCache = new Map<string, FfmpegCaps>();

/** Сброс кэша: нужен тестам и после смены пути к ffmpeg в настройках. */
export function clearCapsCache(): void {
  capsCache.clear();
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (_err, stdout, stderr) => resolve(`${stdout || ""}${stderr || ""}`),
    );
  });
}

/**
 * Возможности сборки: два коротких вызова ffmpeg и кэш на процесс.
 * Если бинарь не отвечает — возвращаем пустые наборы: выбор кодировщика тогда
 * берёт программный вариант «по умолчанию» (так работало до этой правки).
 */
export async function ffmpegCaps(ffmpeg: string, force = false): Promise<FfmpegCaps> {
  const hit = capsCache.get(ffmpeg);
  if (hit && !force) return hit;
  const [encoders, hwaccels] = await Promise.all([
    runCapture(ffmpeg, ["-hide_banner", "-encoders"]),
    runCapture(ffmpeg, ["-hide_banner", "-hwaccels"]),
  ]);
  const caps: FfmpegCaps = {
    encoders: parseEncoders(encoders),
    hwaccels: parseHwaccels(hwaccels),
  };
  capsCache.set(ffmpeg, caps);
  return caps;
}

/** Кодировщик, выбранный под задачу. */
export interface EncoderChoice {
  /** Имя для `-c:v`; пусто — кодировать этим кодеком нечем. */
  encoder: string;
  /** Кодирование идёт на видеокарте (NVENC/QSV/AMF). */
  hardware: boolean;
  /** Параметры качества под конкретный кодировщик (-crf/-cq/-global_quality…). */
  qualityArgs: string[];
  /** Подпись для UI/лога: «NVENC», «SVT-AV1», «AOM-AV1»… */
  label: string;
}

/** Человеческое имя кодировщика: в UI видно, где считался результат. */
export function encoderLabel(name: string): string {
  if (name.endsWith("_nvenc")) return "NVENC";
  if (name.endsWith("_qsv")) return "QSV";
  if (name.endsWith("_amf")) return "AMF";
  if (name === "libsvtav1") return "SVT-AV1";
  if (name === "libaom-av1") return "AOM-AV1";
  if (name === "librav1e") return "rav1e";
  if (name === "libx264") return "x264";
  if (name === "libx265") return "x265";
  return name;
}

/**
 * Качество для выбранного кодировщика: у аппаратных другая ручка, чем у lib-*.
 * `-b:v 0` обязателен для CRF-режима NVENC и libaom, иначе включается битрейт.
 */
export function encoderQualityArgs(encoder: string, crf: number): string[] {
  const q = String(Math.max(0, Math.round(crf)));
  if (encoder.endsWith("_nvenc")) return ["-rc", "vbr", "-cq", q, "-b:v", "0", "-preset", "p5"];
  if (encoder.endsWith("_qsv")) return ["-global_quality", q, "-look_ahead", "0"];
  if (encoder.endsWith("_amf")) return ["-rc", "cqp", "-qp_i", q, "-qp_p", q];
  if (encoder === "libaom-av1") return ["-crf", q, "-b:v", "0"];
  if (encoder === "libsvtav1") return ["-crf", q, "-preset", "8"];
  if (encoder === "librav1e") return ["-qp", q];
  return ["-crf", q];
}

/**
 * Выбор кодировщика под кодек.
 *
 * `hw` — «можно считать на видеокарте»: сначала аппаратные (NVENC → QSV → AMF),
 * затем программные. Если сборка вообще не ответила на `-encoders`, берём
 * программный вариант по умолчанию — раньше он и был жёстко прописан.
 */
export function pickVideoEncoder(o: {
  codec: VideoCodec;
  crf: number;
  caps: FfmpegCaps;
  hw: boolean;
}): EncoderChoice {
  const q = Math.max(0, Math.min(crfMax(o.codec), Math.round(o.crf)));
  const order = o.hw ? [...HW_ENCODERS[o.codec], ...SW_ENCODERS[o.codec]] : SW_ENCODERS[o.codec];
  const known = o.caps.encoders.size > 0;
  const encoder = known ? order.find((e) => o.caps.encoders.has(e)) || "" : SW_ENCODERS[o.codec][0];
  if (!encoder) return { encoder: "", hardware: false, qualityArgs: [], label: "" };
  return {
    encoder,
    hardware: HW_ENCODERS[o.codec].includes(encoder),
    qualityArgs: encoderQualityArgs(encoder, q),
    label: encoderLabel(encoder),
  };
}

/** Предпочтение аппаратного декодирования: CUDA → D3D11 → DXVA2 → QSV → AMF. */
const HW_DECODE_ORDER = ["cuda", "d3d11va", "dxva2", "qsv", "amf"];

/** Метод `-hwaccel` или пустая строка, если видеокарта тут не поможет. */
export function pickHwaccel(caps: FfmpegCaps): string {
  return HW_DECODE_ORDER.find((h) => caps.hwaccels.has(h)) || "";
}

/**
 * Сборка: кадры из stdin (0) + оригинал (1) ради звука/субтитров копией.
 * Контейнер выбирается по расширению результата: субтитры копией требуют mkv.
 *
 * `-r` стоит ПЕРЕД `-i -`, то есть описывает частоту кадров, приходящих по pipe
 * (входную для rawvideo), а не частоту результата: результат выходит из фильтров
 * (`minterpolate`, `fps`) или совпадает с входной. Передавать сюда выходную
 * частоту нельзя — тогда ffmpeg растянет/сожмёт длительность.
 */
export function buildEncodeArgs(o: {
  /** Частота кадров, идущих по pipe (округлённая — если дроби нет). */
  fps: number;
  fpsNum?: number;
  fpsDen?: number;
  outWidth: number;
  outHeight: number;
  inputPath: string;
  outFile: string;
  /** Кодировщик под эту сборку ffmpeg: libx264/libsvtav1/h264_nvenc/… */
  encoder: string;
  /** Параметры качества этого кодировщика (-crf N / -cq N / -global_quality N). */
  qualityArgs: string[];
  audioAction: "copy" | "aac";
  hasSubs: boolean;
  filters?: string[];
  /** Копировать метаданные и главы оригинала (он здесь вход №1). */
  metadata?: boolean;
  /**
   * Замедление результата (1 — как есть). Один и тот же множитель применяем к
   * видео (`setpts`) и к звуку (`atempo`) — иначе звук уедет относительно
   * картинки. Копирование звука (`copy`) при замедлении невозможно: длительность
   * дорожки должна измениться, поэтому переходим на AAC.
   */
  slowMotion?: number;
}): string[] {
  const rate =
    o.fpsNum && o.fpsDen && o.fpsNum > 0 && o.fpsDen > 0
      ? `${Math.round(o.fpsNum)}/${Math.round(o.fpsDen)}`
      : String(o.fps || 25);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${o.outWidth}x${o.outHeight}`,
    "-r",
    rate,
    "-i",
    "-",
    "-i",
    o.inputPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a?",
  ];
  if (o.hasSubs) args.push("-map", "1:s?");
  // Вход №0 — rawvideo-поток без метаданных, поэтому оригинал — это №1:
  // без явных -map_metadata/-map_chapters заголовок и главы теряются.
  if (o.metadata) args.push("-map_metadata", "1", "-map_chapters", "1");
  args.push("-c:v", o.encoder, ...o.qualityArgs);
  args.push("-pix_fmt", "yuv420p");
  const slow = Math.max(0.05, Math.min(1, o.slowMotion || 1));
  // setpts — последним: апскейл и интерполяция считаются по нормальному времени.
  const vf = [...(o.filters || []), ...slowMotionFilter(slow)];
  if (vf.length) args.push("-vf", vf.join(","));
  const af = slowAudioFilters(slow);
  if (o.audioAction === "copy" && !af.length) args.push("-c:a", "copy");
  else {
    args.push("-c:a", "aac", "-b:a", "192k");
    if (af.length) args.push("-filter:a", af.join(","));
  }
  if (o.hasSubs) args.push("-c:s", "copy");
  args.push("-shortest", "-y", o.outFile);
  return args;
}

/** Имя результата: mkv — если в исходнике есть субтитры (copy надёжнее). */
export function outFileName(inputName: string, hasSubs: boolean): string {
  const stem = String(inputName || "video").replace(/\.[^.]+$/, "") || "video";
  return `${stem}_upscaled${hasSubs ? ".mkv" : ".mp4"}`;
}

// ================== ПРОБА МЕДИА ==================

/** Поток из ffprobe: нам нужны только тип, кодек, размеры и disposition. */
export interface MediaStreamInfo {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  /**
   * disposition.attached_pic = 1 — «обложка» файла (png/mjpeg-картинка внутри
   * mp4/mkv). Она крупнее самого видео и раньше попадала в пробу как основной
   * поток: UI показывал «формат PNG» и разрешение обложки вместо видео.
   */
  disposition?: { attached_pic?: number; default?: number };
}

type RawStream = MediaStreamInfo;

/**
 * Основной видеопоток файла.
 *
 * Обложки (attached_pic) не рассматриваем вообще, а среди настоящих видео
 * предпочитаем поток по умолчанию: сортировка «по площади» не помогала —
 * PNG-обложка 1280×720 оказывалась крупнее кадра видео 360×640.
 */
export function pickMainVideoStream(streams: RawStream[]): RawStream {
  const videos = (streams || []).filter(
    (s) => s && s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  return videos.find((s) => s.disposition?.default) || videos[0] || ({} as RawStream);
}

/**
 * Сколько кадров ожидаем из декодера: по длительности и частоте, но не больше
 * `frameLimit` (превью «первые N кадров»). Так прогресс и ETA считаются по
 * реальному объёму работы, а не по всей длительности файла.
 */
export function frameLimitOrInf(duration: number, fps: number, frameLimit?: number): number {
  const planned = planFrames(duration, fps);
  const limit = Math.max(0, Math.round(frameLimit || 0));
  return limit > 0 ? Math.min(planned, limit) : planned;
}

/**
 * Один вызов ffprobe: разрешение, fps, длительность, наличие звука/субтитров.
 */
export function probeMedia(ffprobe: string, file: string): Promise<MediaProbe> {
  return new Promise((resolve) => {
    execFile(
      ffprobe,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const empty: MediaProbe = {
          width: 0,
          height: 0,
          fps: 0,
          fpsNum: 0,
          fpsDen: 0,
          duration: 0,
          hasAudio: false,
          hasSubs: false,
          codec: "",
        };
        if (err) return resolve(empty);
        try {
          const parsed = JSON.parse(String(stdout)) as {
            streams?: RawStream[];
            format?: { duration?: string };
          };
          const streams = (parsed.streams || []).filter((s) => s && s.codec_type);
          // Основной видеопоток: обложки (attached_pic) отсекаются внутри —
          // иначе UI показывал «png 1280×720» для видео 360×640, а декодер
          // ffmpeg уходил на обложку вместо фильма.
          const video = pickMainVideoStream(streams);
          const rate = parseRate(video.avg_frame_rate || video.r_frame_rate);
          resolve({
            width: video.width || 0,
            height: video.height || 0,
            fps: rateFps(rate),
            fpsNum: rate.num,
            fpsDen: rate.den,
            duration: Number(parsed.format?.duration) || 0,
            hasAudio: streams.some((s) => s.codec_type === "audio"),
            hasSubs: streams.some((s) => s.codec_type === "subtitle"),
            codec: video.codec_name || "",
          });
        } catch {
          resolve(empty);
        }
      },
    );
  });
}

// ================== ПОТОКОВЫЙ ПАЙПЛИН ==================

/** Ошибка с хвостом stderr: по ней понятно, на чём споткнулся ffmpeg. */
function procError(tool: string, code: number | null, tail: string): Error {
  return new Error(`${tool} exit ${code}: ${tail.slice(-300)}`);
}

/**
 * Потоковая обработка: decode → processFrame → encode.
 *
 * Ключевой момент — backpressure: как только кадр попал в очередь обработки,
 * чтение из stdout ставится на паузу и возобновляется только после записи
 * результата в encoder. Иначе ffmpeg распаковал бы всё видео в память.
 */
export function runVideoPipeline(opts: VideoPipelineOptions): Promise<void> {
  const { probe } = opts;
  if (!(probe.width > 0) || !(probe.height > 0)) {
    return Promise.reject(new Error("probe_failed"));
  }
  const inFrame = frameBytes(probe.width, probe.height);
  // Частота кадров из probe — дробью, если ffprobe её дал (иначе из округлённой).
  const srcRate = effectiveRate(probe.fpsNum, probe.fpsDen, probe.fps);
  const pipeRate = effectiveRate(opts.pipeRateNum, opts.pipeRateDen, rateFps(srcRate));
  const outPerIn = Math.max(1, Math.round(opts.outPerIn || 1));
  // Выходная частота: явная (интерполяция в фильтрах энкодера) или pipeRate × mult.
  const encRate =
    opts.outRateNum && opts.outRateDen
      ? effectiveRate(opts.outRateNum, opts.outRateDen, 0)
      : outRate(pipeRate.num, pipeRate.den, outPerIn);
  const total = frameLimitOrInf(probe.duration, rateFps(pipeRate), opts.frameLimit);
  // Прогресс считаем по кадрам, которые реально попадут в энкодер. У нашей
  // интерполяции каждый исходный кадр даёт outPerIn кадров (лимит превью задан в
  // исходных кадрах), у ffmpeg-стороны число кадров уже задаёт фильтр.
  const srcTotal = frameLimitOrInf(probe.duration, rateFps(srcRate), opts.frameLimit);
  const outTotal = opts.interpolate
    ? planOutFrames(srcTotal, outPerIn)
    : planOutFrames(total, outPerIn);
  const encFps = rateFps(encRate) || rateFps(pipeRate) || probe.fps;
  const interpolate = outPerIn > 1 ? opts.interpolate : undefined;
  /**
   * Вставки до апскейла: интерполятор работает по исходным кадрам, а апскейлер
   * получает уже умноженный поток. Порядок выходного потока тот же, поэтому звук
   * и субтитры остаются на месте; меняется только цена: интерполяция дешевле
   * (меньше пикселей), апскейл — дороже (кадров в mult раз больше).
   */
  const interpBefore = !!interpolate && opts.interpSide === "decode";
  // Пачка имеет смысл только с processFrames: иначе кадры и так идут по одному.
  const batch = opts.processFrames ? Math.max(1, Math.round(opts.batchFrames || 1)) : 1;
  /**
   * Сколько пачек держим в памяти одновременно: одна считается, следующая
   * набирается из декодера (двойная буферизация). Движок передаёт сюда
   * `QUEUE_BATCHES` из upscale.ts, а бюджеты памяти считает с тем же множителем.
   */
  const queueBatches = opts.processFrames ? Math.max(1, Math.round(opts.queueBatches || 1)) : 1;
  /** Лимит кадров превью (0 — весь файл). */
  const limit = Math.max(0, Math.round(opts.frameLimit || 0));

  return new Promise<void>((resolve, reject) => {
    let failed = false;
    let decEnded = false;
    // Разбудить читателя, ждущего место в очереди (см. queueMax ниже). Заглушка до
    // инициализации: `fail` может сработать раньше, чем очередь заведена.
    let releaseSlots: () => void = () => {};
    let processed = 0;
    let outWritten = 0;
    let prevOut: ProcessedFrame | null = null;
    let outW = 0;
    let outH = 0;
    let outFrame = 0;
    let stderrTail = "";
    let lastTick = Date.now();
    let framesSinceTick = 0;
    let speed = 0;

    const dec: ChildProcessWithoutNullStreams = spawn(
      opts.ffmpeg,
      buildDecodeArgs(opts.inputPath, opts.decodeFilters, limit, opts.decodeHwaccel),
      {
        windowsHide: true,
      },
    );
    // Движок узнаёт о процессах: по «Стоп» он гасит их сразу, не дожидаясь нас.
    opts.onProc?.("decode", dec);
    dec.on("close", () => opts.onProc?.("decode", null));
    // Encoder стартует лениво — после первого кадра: до этого мы не знаем
    // выходные размеры (их задаёт апскейл).
    let enc: ChildProcessWithoutNullStreams | null = null;
    let encClosed = false;
    /** `stdin.end()` уже вызван: второй вызов — это «write after end». */
    let encFinishing = false;

    /**
     * Пауза: ждём снятия, ничего не читая и не считая.
     *
     * Процессы не гасим (это «Стоп»), модели не выгружаем: пользователь ждёт,
     * что после «Продолжить» обработка пойдёт с того же кадра. Стоп во время
     * паузы срабатывает сразу — проверяем его первым.
     */
    const waitResume = async (): Promise<void> => {
      if (!opts.isPaused?.()) return;
      if (opts.shouldStop?.()) throw new Error("stopped");
      opts.onPaused?.(true);
      try {
        while (!failed && opts.isPaused?.()) {
          if (opts.shouldStop?.()) throw new Error("stopped");
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        opts.onPaused?.(false);
      }
      if (opts.shouldStop?.()) throw new Error("stopped");
    };

    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      // Разбудить читателя, если он ждал место в очереди: иначе задача повисла бы
      // на await, уже не имея шанса дождаться обработки.
      releaseSlots();
      for (const p of [dec, enc]) {
        try {
          p?.kill();
        } catch {
          /* уже мёртв */
        }
      }
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    /** Дождаться сброса в pipe (encoder вернул false из write). */
    const writeFrame = (buf: Buffer): Promise<void> =>
      new Promise((res, rej) => {
        if (!enc || encClosed) return rej(new Error("encoder_closed"));
        const ok = enc.stdin.write(buf, (err) => (err ? rej(err) : undefined));
        if (ok) res();
        else enc.stdin.once("drain", () => res());
      });

    const startEncoder = (w: number, h: number) => {
      outW = w;
      outH = h;
      outFrame = frameBytes(w, h);
      const args = buildEncodeArgs({
        // Именно pipeRate: `-r` описывает входной rawvideo-поток. Выходную
        // частоту задаёт фильтр minterpolate (интерполяция «после апскейла»).
        fps: Math.round(rateFps(pipeRate)) || 25,
        fpsNum: pipeRate.num,
        fpsDen: pipeRate.den,
        outWidth: w,
        outHeight: h,
        inputPath: opts.inputPath,
        outFile: opts.outFile,
        encoder: opts.encoder,
        qualityArgs: opts.qualityArgs,
        audioAction: opts.audioAction,
        hasSubs: probe.hasSubs,
        filters: opts.filters,
        metadata: opts.metadata,
        slowMotion: opts.slowMotion,
      });
      enc = spawn(opts.ffmpeg, args, { windowsHide: true });
      opts.onProc?.("encode", enc);
      enc.stderr.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + String(d)).slice(-4000);
      });
      // Ошибка записи (в том числе «write after end» — энкодер закрыл stdin)
      // без хвоста stderr выглядит загадкой: настоящая причина отказа ffmpeg
      // остаётся в его выводе, поэтому приписываем его к сообщению.
      enc.stdin.on("error", (e) =>
        fail(new Error(`${(e as Error).message}; ${stderrTail.slice(-300)}`)),
      );
      enc.on("error", fail);
      enc.on("close", (code) => {
        encClosed = true;
        opts.onProc?.("encode", null);
        if (failed) return;
        if (code === 0) resolve();
        else fail(procError("upscale-encode", code, stderrTail));
      });
    };

    /** Один выходной кадр: проверка размера + запись в encoder. */
    const pushOut = async (data: Buffer): Promise<void> => {
      if (data.length !== outFrame) throw new Error("frame_size_changed");
      await writeFrame(data);
      outWritten++;
      framesSinceTick++;
    };

    /**
     * Готовый кадр после апскейла: вставки интерполяции идут МЕЖДУ уже
     * записанным prev и текущим кадром — так порядок выходного потока остаётся
     * up₀ → ins(up₀,up₁) → up₁ → … без буферизации.
     */
    const handleOut = async (out: ProcessedFrame): Promise<void> => {
      // Остановку проверяем и здесь: интерполяция идёт по кадрам пачки, и без
      // этой проверки «Стоп» ждал бы конца всей пачки (заметно на 4K и RIFE).
      if (opts.shouldStop?.()) throw new Error("stopped");
      if (!enc) startEncoder(out.width, out.height);
      if (out.width !== outW || out.height !== outH) throw new Error("frame_size_changed");
      if (prevOut && interpolate && !interpBefore) {
        const between = await interpolate(prevOut, out, processed);
        // Число вставок задаёт частоту результата: ошибка здесь = рассинхрон
        // звука на всю длительность, поэтому проверяем, а не «как получится».
        if (between.length !== insertsBefore(processed, outPerIn)) {
          throw new Error("interp_frame_count");
        }
        for (const b of between) await pushOut(b);
      }
      await pushOut(out.data);
      prevOut = out;
      processed++;

      const now = Date.now();
      if (now - lastTick >= 500) {
        speed = (framesSinceTick * 1000) / (now - lastTick);
        framesSinceTick = 0;
        lastTick = now;
      }
      const eta =
        speed > 0 && outTotal > 0 ? Math.max(0, Math.round((outTotal - outWritten) / speed)) : 0;
      opts.onProgress({
        framesDone: outWritten,
        framesTotal: outTotal,
        inFramesDone: processed,
        outFps: Math.round(encFps * 100) / 100,
        fps: speed,
        etaSec: eta,
      });
    };

    // ---- пачка кадров для ONNX: ждём batch штук и считаем их одним заходом ----
    let queue: Buffer[] = [];
    let queueStart = 0;
    /**
     * Кадры, уже отданные в ONNX, но ещё не записанные в энкодер. Нужны, чтобы
     * очередь работала с опережением (двойная буферизация): пока GPU считает одну
     * пачку, декодер набирает следующую — иначе он стоял на паузе, а видеокарта
     * простаивала между «залпами» (в мониторе — «лестница» с периодом в пачку).
     */
    let inFlight = 0;
    /** Сколько кадров держим в памяти: очередь + пачка в работе. */
    const queueMax = batch * queueBatches;
    let waiters: Array<() => void> = [];
    releaseSlots = (): void => {
      if (!waiters.length) return;
      const list = waiters;
      waiters = [];
      for (const wake of list) wake();
    };
    const waitSlot = (): Promise<void> =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      });

    /**
     * Вся пачка считается одним заходом: размер пришёл уже урезанным по памяти
     * (`batchFramesFor`/`autoBatchFrames`), а «Стоп» остаётся быстрым — флаг
     * проверяется между тайлами внутри инференса и перед каждым готовым кадром.
     */
    const flushQueueNow = async (force: boolean): Promise<void> => {
      const fn = opts.processFrames;
      if (!fn) return;
      while (queue.length >= batch || (force && queue.length)) {
        // Пауза перед пачкой: уже посчитанная пачка дописывается, новая не стартует.
        await waitResume();
        const take = Math.min(batch, queue.length);
        const chunk = queue.slice(0, take);
        queue = queue.slice(take);
        if (opts.shouldStop?.()) throw new Error("stopped");
        inFlight += chunk.length;
        try {
          const outs = await fn(chunk, queueStart);
          if (outs.length !== chunk.length) throw new Error("batch_size_mismatch");
          queueStart += chunk.length;
          for (const out of outs) await handleOut(out);
        } finally {
          // Место в очереди освобождается только после записи кадров: читатель,
          // ждущий слот, возобновляет декодер ровно тогда, когда пачка обработана.
          inFlight -= chunk.length;
          releaseSlots();
        }
      }
    };

    let flushing: Promise<void> = Promise.resolve();
    const flushQueue = (force: boolean): Promise<void> => {
      const next = flushing.then(
        () => flushQueueNow(force),
        (e: unknown) => {
          throw e;
        },
      );
      // Цепочка не должна «застрять» отвергнутой: ошибку ждёт вызывающий.
      flushing = next.catch(() => undefined);
      return next;
    };

    const ingest = async (rgb: Buffer): Promise<void> => {
      if (opts.processFrames) {
        // Лимит кадров считаем по исходнику: лишние кадры просто не берём.
        // При интерполяции ДО апскейла счёт идёт по исходным кадрам видео
        // (см. onFrame): в очереди там уже лежат вставки, и лимит по ним обрезал
        // бы половину ролика.
        if (!interpBefore && limit && queueStart + queue.length + inFlight >= limit) return;
        queue.push(rgb);
        // Пачку ставим в обработку, но НЕ ждём её: пока GPU считает её, декодер
        // набирает следующую (двойная буферизация). Ошибку ловит `fail` — иначе
        // fire-and-forget потерял бы её.
        if (queue.length >= batch) void flushQueue(false).catch(fail);
        // Backpressure по памяти: очередь + пачка в работе не больше queueMax кадров.
        while (!failed && queue.length + inFlight >= queueMax) await waitSlot();
        return;
      }
      // Без processFrame кадр уходит в энкодер как есть (режим «без апскейла»).
      const frame: ProcessedFrame = opts.processFrame
        ? await opts.processFrame(rgb, processed, probe.width, probe.height)
        : { data: rgb, width: probe.width, height: probe.height };
      await handleOut(frame);
    };

    /**
     * Кадр исходника перед апскейлом. В режиме «интерполяция до апскейла»
     * вставки считаем здесь: между prev и текущим исходным кадром, а затем
     * отправляем в обработку и вставки, и сам кадр — порядок тот же, что при
     * интерполяции после апскейла.
     */
    let prevIn: ProcessedFrame | null = null;
    let inSeen = 0;
    const ingestBefore = async (rgb: Buffer): Promise<void> => {
      const cur: ProcessedFrame = { data: rgb, width: probe.width, height: probe.height };
      if (prevIn && interpolate) {
        const between = await interpolate(prevIn, cur, inSeen);
        // Число вставок задаёт частоту результата: ошибка = рассинхрон звука.
        if (between.length !== insertsBefore(inSeen, outPerIn)) {
          throw new Error("interp_frame_count");
        }
        for (const b of between) await ingest(b);
      }
      prevIn = cur;
      inSeen++;
      await ingest(rgb);
    };

    const onFrame = async (rgb: Buffer): Promise<void> => {
      await waitResume();
      if (opts.shouldStop?.()) throw new Error("stopped");
      if (interpBefore) {
        // Превью ограничиваем по кадрам исходника — вставки считаются от них.
        if (limit && inSeen >= limit) return;
        await ingestBefore(rgb);
        return;
      }
      await ingest(rgb);
    };

    // ---- читатель кадров фиксированного размера из decoder.stdout ----
    // Тип Uint8Array (а не Buffer): у @types/node Buffer теперь generic, и
    // Buffer<ArrayBufferLike> из событий потока не совпадает с Buffer<ArrayBuffer>.
    let buf: Uint8Array = new Uint8Array(0);
    let paused = false;
    let running = false;
    let again = false;

    /**
     * Закрыть вход энкодера, когда работа действительно закончена.
     *
     * Проверять только «декодер закрылся и буфер пуст» нельзя: последний кадр
     * может ещё считаться в ONNX (`running`) или лежать в очереди пачки, и его
     * результат прилетит уже в закрытый stdin — задача падала с плавающей
     * ошибкой «write after end» (ловелось на быстрых концах файла).
     */
    const finishIfDone = () => {
      if (failed) return;
      if (!decEnded || buf.length >= inFrame) return;
      // Пачка в работе (`inFlight`) тоже часть незавершённой обработки: закрыть
      // stdin энкодера раньше нельзя, иначе последние кадры уйдут «write after end».
      if (running || queue.length > 0 || inFlight > 0) return;
      if (enc) {
        if (!encClosed && !encFinishing) {
          encFinishing = true;
          enc.stdin.end();
        }
      } else {
        // Кадров не было вовсе: пустой вход — это не «готово», а ошибка.
        fail(new Error("no_frames"));
      }
    };

    /**
     * Файл кончился: последняя пачка может быть неполной (меньше batch), а
     * `data`-событий больше не будет — её обязательно добираем здесь, иначе
     * задача висит вечно на ожидании кадров, которые уже не придут.
     */
    const drainTail = (): Promise<void> =>
      flushQueue(true).then(
        () => {
          finishIfDone();
        },
        (e: unknown) => {
          fail(e);
        },
      );

    const pump = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          while (buf.length >= inFrame) {
            const frame = Buffer.from(buf.subarray(0, inFrame));
            buf = buf.subarray(inFrame);
            if (!paused) {
              paused = true;
              dec.stdout.pause();
            }
            await onFrame(frame);
          }
          if (paused) {
            paused = false;
            dec.stdout.resume();
          }
        } while (again);
      } catch (e) {
        fail(e);
      } finally {
        running = false;
        // Остаток пачки (файл кончился) обрабатываем до закрытия энкодера:
        // иначе последние кадры пачки просто потерялись бы.
        if (!failed && decEnded) await drainTail();
        else finishIfDone();
      }
    };

    dec.stdout.on("data", (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      void pump();
    });
    dec.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + String(d)).slice(-4000);
    });
    dec.on("error", fail);
    dec.on("close", (code) => {
      if (code !== 0 && !failed) {
        return fail(procError("upscale-decode", code, stderrTail));
      }
      decEnded = true;
      // Пока очередь непустая, `pump` завершится сам и доберёт остаток; иначе
      // это единственное место, где остаток может быть обработан.
      if (!running) void drainTail();
      else finishIfDone();
    });
  });
}
