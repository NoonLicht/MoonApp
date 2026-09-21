import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "../config";
import type { ProcessedFrame } from "../upscalePipeline";
import type {
  InterpSig,
  ManifestModel,
  OrtModule,
  OrtTensor,
  ReadySession,
  TileRect,
  UpParams,
} from "./types";
import { alignUp } from "./util";
import {
  blendTile,
  mixPlanes,
  modelAlign,
  normTile,
  normTilePad,
  tileRects,
} from "./tiling";
import { findModel, loadManifest, modelKind } from "./manifest";
import { loadOrt } from "./runtime";
import { trtProfileSize } from "./trt";
import { getSession, runGuarded } from "./session";
import { BATCH_MAX, MAX_OUT_PX, runCapture } from "./params";

const { DIRS } = config;

export async function decodeRgb(
  ffmpeg: string,
  file: string,
  w: number,
  h: number,
  denoise: number,
): Promise<Buffer> {
  const need = w * h * 3;
  const args = ["-hide_banner", "-loglevel", "error", "-i", file];
  if (denoise > 0) {
    const s = (denoise / 100) * 8;
    args.push(
      "-vf",
      `hqdn3d=${s.toFixed(1)}:${s.toFixed(1)}:${(s * 2).toFixed(1)}:${(s * 2).toFixed(1)}`,
    );
  }
  args.push("-f", "rawvideo", "-pix_fmt", "rgb24", "-");
  const buf = await runCapture(ffmpeg, args, need + 8 * 1024 * 1024);
  if (buf.length < need) throw new Error("decode_short");
  return buf.subarray(0, need);
}

/** Кодирование rgb24 в файл нужного формата (качество — по формату). */
export async function encodeRgb(o: {
  ffmpeg: string;
  rgb: Uint8Array;
  w: number;
  h: number;
  outPath: string;
  format: string;
  quality: number;
  filters: string[];
}): Promise<void> {
  // Пишем raw во временный файл, а не в stdin: execFile удобнее для ошибок,
  // а размер буфера всё равно известен заранее.
  const tmp = path.join(DIRS.tmp, `up_${crypto.randomBytes(8).toString("hex")}.rgb`);
  fs.writeFileSync(tmp, o.rgb);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${o.w}x${o.h}`,
    "-i",
    tmp,
    "-frames:v",
    "1",
  ];
  if (o.filters.length) args.push("-vf", o.filters.join(","));
  if (o.format === "jpeg") {
    args.push("-q:v", String(Math.max(2, Math.min(31, Math.round(31 - (o.quality / 100) * 29)))));
  } else if (o.format === "webp") {
    args.push("-q:v", String(o.quality));
  } else if (o.format === "avif") {
    args.push(
      "-c:v",
      "libaom-av1",
      "-crf",
      String(Math.max(1, Math.min(63, Math.round(63 - (o.quality / 100) * 60)))),
      "-still-picture",
      "1",
    );
  }
  args.push("-y", o.outPath);
  try {
    await runCapture(o.ffmpeg, args, 8 * 1024 * 1024);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* временный файл мог не создаться */
    }
  }
}

async function runSession(
  ort: OrtModule,
  ready: ReadySession,
  input: Float32Array,
  w: number,
  h: number,
): Promise<Float32Array> {
  const session = ready.session;
  const feeds: Record<string, OrtTensor> = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, h, w]);
  const res = await runGuarded(ready, () => session.run(feeds));
  return res[session.outputNames[0]].data;
}

/** Смешивание результатов двух моделей: w — вес второй (0..1). */
const SIG_BY_NAMES: Array<{ sig: InterpSig; names: string[] }> = [
  { sig: "rife-pair-timestep", names: ["img0", "img1", "timestep"] },
  { sig: "ifrnet-pair", names: ["frame0", "frame1"] },
  { sig: "cain-concat", names: ["input"] },
];

/**
 * Схема входов по именам входов модели. Пустая строка — модель незнакомая:
 * вызывающий покажет `model_signature_unknown` и список входов (он виден в
 * логе и подсказке), а не упадёт в середине прогона.
 */
export function detectInterpSig(inputNames: readonly string[]): InterpSig | "" {
  const names = (inputNames || []).map((n) => String(n).toLowerCase());
  if (!names.length) return "";
  for (const cand of SIG_BY_NAMES) {
    if (cand.names.every((n) => names.includes(n))) return cand.sig;
  }
  // Экспортёры часто добавляют префиксы/суффиксы (img0_1, frames[0]): тогда
  // достаточно характерных кусков имён.
  for (const cand of SIG_BY_NAMES) {
    if (cand.sig === "cain-concat") continue;
    if (cand.names.every((n) => names.some((x) => x.includes(n)))) return cand.sig;
  }
  return "";
}

/** Момент времени между кадрами: ×2 → [0.5]; ×3 → [1/3, 2/3]; ×4 → [0.25, 0.5, 0.75]. */
export function interpTimesteps(mult: number): number[] {
  const m = Math.max(2, Math.round(mult || 2));
  return Array.from({ length: m - 1 }, (_, i) => (i + 1) / m);
}

/**
 * Входы ONNX для пары рамок по схеме модели (тайл задаётся координатами):
 *   - rife-pair-timestep: img0/img1 (NCHW [1,3,h,w]) + timestep ([1]);
 *   - cain-concat: один вход [1,6,h,w] — две рамки подряд по каналам;
 *   - ifrnet-pair: frame0/frame1.
 * Имена входов берём у сессии: у разных экспортёров они свои.
 */
export function buildInterpFeeds(o: {
  ort: OrtModule;
  sig: InterpSig;
  session: { inputNames: readonly string[] };
  prev: Uint8Array;
  cur: Uint8Array;
  srcW: number;
  x: number;
  y: number;
  tw: number;
  th: number;
  /** Момент времени между кадрами (нужен схемам с явным timestep). */
  t: number;
  bgr: boolean;
}): Record<string, OrtTensor> {
  const { tw, th, x, y, srcW } = o;
  const a = normTile(o.prev, srcW, x, y, tw, th, o.bgr);
  const b = normTile(o.cur, srcW, x, y, tw, th, o.bgr);
  const names = o.session.inputNames;
  const feeds: Record<string, OrtTensor> = {};

  if (o.sig === "cain-concat") {
    // Сначала все три канала первой рамки, затем — второй.
    const cat = new Float32Array(tw * th * 6);
    cat.set(a, 0);
    cat.set(b, tw * th * 3);
    feeds[names[0]] = new o.ort.Tensor("float32", cat, [1, 6, th, tw]);
    return feeds;
  }

  feeds[names[0]] = new o.ort.Tensor("float32", a, [1, 3, th, tw]);
  feeds[names[1] || names[0]] = new o.ort.Tensor("float32", b, [1, 3, th, tw]);
  if (o.sig === "rife-pair-timestep") {
    feeds[names[2] || "timestep"] = new o.ort.Tensor("float32", new Float32Array([o.t]), [1]);
  }
  return feeds;
}
/**
 * Группы тайлов одного размера: пачка собирается в один тензор [n,3,h,w], поэтому
 * складывать в неё тайлы разной ширины нельзя (по краям кадра они меньше).
 * Чистая функция — проверяется тестами.
 */
export function tileGroups(rects: TileRect[], n: number): TileRect[][] {
  const limit = Math.max(1, Math.round(n) || 1);
  const out: TileRect[][] = [];
  let cur: TileRect[] = [];
  for (const r of rects) {
    const same = cur.length > 0 && cur[0].w === r.w && cur[0].h === r.h;
    if (cur.length > 0 && (!same || cur.length >= limit)) {
      out.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Входы ONNX для ПАЧКИ тайлов одной пары кадров: [n,3,th,tw] (для cain-concat —
 * [n,6,th,tw]). Тайлы должны быть одного размера (см. tileGroups). Такой вход
 * принимает только граф с динамическим batch (поле `batch` > 1 в каталоге):
 * у фиксированного batch=1 движок считает тайлы по одному.
 */
export function buildInterpBatchFeeds(o: {
  ort: OrtModule;
  sig: InterpSig;
  session: { inputNames: readonly string[] };
  prev: Uint8Array;
  cur: Uint8Array;
  srcW: number;
  /** Тайлы одного размера: их и складываем в пачку. */
  rects: TileRect[];
  /** Момент времени между кадрами (нужен схемам с явным timestep). */
  t: number;
  bgr: boolean;
}): Record<string, OrtTensor> {
  const n = o.rects.length;
  const tw = o.rects[0].w;
  const th = o.rects[0].h;
  const plane = tw * th;
  const names = o.session.inputNames;
  const feeds: Record<string, OrtTensor> = {};

  if (o.sig === "cain-concat") {
    // Две рамки подряд по каналам: [n,6,h,w].
    const cat = new Float32Array(n * plane * 6);
    o.rects.forEach((r, i) => {
      const base = i * plane * 6;
      cat.set(normTile(o.prev, o.srcW, r.x, r.y, tw, th, o.bgr), base);
      cat.set(normTile(o.cur, o.srcW, r.x, r.y, tw, th, o.bgr), base + plane * 3);
    });
    feeds[names[0]] = new o.ort.Tensor("float32", cat, [n, 6, th, tw]);
    return feeds;
  }

  const a = new Float32Array(n * plane * 3);
  const b = new Float32Array(n * plane * 3);
  o.rects.forEach((r, i) => {
    const base = i * plane * 3;
    a.set(normTile(o.prev, o.srcW, r.x, r.y, tw, th, o.bgr), base);
    b.set(normTile(o.cur, o.srcW, r.x, r.y, tw, th, o.bgr), base);
  });
  feeds[names[0]] = new o.ort.Tensor("float32", a, [n, 3, th, tw]);
  feeds[names[1] || names[0]] = new o.ort.Tensor("float32", b, [n, 3, th, tw]);
  if (o.sig === "rife-pair-timestep") {
    // Момент времени — по одному на элемент пачки.
    feeds[names[2] || "timestep"] = new o.ort.Tensor("float32", new Float32Array(n).fill(o.t), [n]);
  }
  return feeds;
}

/**
 * Вставки между двумя УЖЕ УВЕЛИЧЕННЫМИ кадрами: по буферу на каждый момент
 * времени из `ts`. Тайлинг переиспользует tileRects, вход/выход — те же
 * normTile/blendTile с масштабом 1 (интерполятор не меняет разрешение).
 *
 * `tileBatch` — вторая «пачка» (настройка «пачка тайлов интерполятора»): сколько
 * тайлов пары считать одним run. Работает у моделей с batch>1, иначе приходит 1.
 */
export async function interpolatePair(o: {
  prev: Buffer;
  cur: Buffer;
  w: number;
  h: number;
  p: UpParams;
  model: ManifestModel;
  sig: InterpSig;
  ts: number[];
  /** Сколько тайлов пары за один session.run (1 — по тайлу; см. tileGroups). */
  tileBatch?: number;
  /** Запрошена остановка: проверяем между тайлами (4K-кадры считаются долго). */
  shouldStop?: () => boolean;
  /**
   * Готовая сессия и ort-модуль. В проде не передаются (берём из кэша/рантайма),
   * а тесты подставляют сюда заглушку: тайлинг и порядок вставок проверяются
   * без нативной библиотеки и файла модели.
   */
  deps?: { ort: OrtModule; ready: ReadySession };
}): Promise<Buffer[]> {
  const ort = o.deps?.ort || loadOrt();
  if (!ort) throw new Error("runtime_missing");
  const ready = o.deps?.ready || (await getSession(o.model.id, o.p.provider, o.p.threads));
  const tile = o.p.tile || o.model.tile || 0;
  // Перекрытие интерполятора больше дефолтного: оптический поток «сшивает»
  // разные оценки движения по разные стороны шва — это видно как рывок.
  const overlap = o.p.overlap > 0 ? o.p.overlap : o.model.overlap || 32;
  const rects = tileRects(o.w, o.h, tile, overlap);
  const outName = ready.session.outputNames[0];
  const frames: Buffer[] = o.ts.map(() => Buffer.alloc(o.w * o.h * 3));

  /** Один тайл пары в один run — путь для графов с фиксированным batch=1. */
  const runSingle = async (r: TileRect, k: number): Promise<void> => {
    const feeds = buildInterpFeeds({
      ort,
      sig: o.sig,
      session: ready.session,
      prev: o.prev,
      cur: o.cur,
      srcW: o.w,
      x: r.x,
      y: r.y,
      tw: r.w,
      th: r.h,
      t: o.ts[k],
      bgr: ready.bgr,
    });
    const res = await runGuarded(ready, () => ready.session.run(feeds));
    const out = res[outName];
    if (!out) throw new Error("interp_output_missing");
    blendTile(frames[k], o.w, o.h, out.data, r.w, r.h, 1, r.x, r.y, overlap, ready.bgr);
  };

  /**
   * Обработать тайлы начиная с `idx` группами по `batchSize`. Если граф не
   * принимает пачку (наши экспорты: dynamic_axes заданы лишь по h/w), движок
   * запоминает факт и пересчитывает эту же позицию по одному тайлу — иначе одна
   * незакрытая галочка в каталоге рушила бы всё задание.
   */
  let idx = 0;
  const runGroups = async (batchSize: number): Promise<void> => {
    for (const group of tileGroups(rects.slice(idx), batchSize)) {
      if (o.shouldStop?.()) throw new Error("stopped");
      for (let k = 0; k < o.ts.length; k++) {
        if (group.length === 1) {
          await runSingle(group[0], k);
          continue;
        }
        // Пачка тайлов одного размера: один run на всю группу.
        try {
          const feeds = buildInterpBatchFeeds({
            ort,
            sig: o.sig,
            session: ready.session,
            prev: o.prev,
            cur: o.cur,
            srcW: o.w,
            rects: group,
            t: o.ts[k],
            bgr: ready.bgr,
          });
          const res = await runGuarded(ready, () => ready.session.run(feeds));
          const out = res[outName];
          if (!out) throw new Error("interp_output_missing");
          const plane = group[0].w * group[0].h;
          group.forEach((r, i) => {
            const slice = out.data.subarray(i * plane * 3, (i + 1) * plane * 3);
            blendTile(frames[k], o.w, o.h, slice, r.w, r.h, 1, r.x, r.y, overlap, ready.bgr);
          });
        } catch (e) {
          if (String((e as Error)?.message) === "stopped" || !isBatchMismatch(e)) throw e;
          markBatchUnsupported(o.model.id);
          return runGroups(1);
        }
      }
      idx += group.length;
    }
  };

  await runGroups(Math.max(1, Math.round(o.tileBatch || 1) || 1));
  return frames;
}

/** Интерполятор задания: явный id, иначе первый скачанный из манифеста. */
export function pickInterpModel(id: string): ManifestModel | null {
  if (id) {
    const m = findModel(id);
    return m && modelKind(m) === "interp" ? m : null;
  }
  const list = loadManifest().filter((m) => modelKind(m) === "interp");
  return list.find((m) => fs.existsSync(path.join(DIRS.upscaleModels, m.file))) || list[0] || null;
}

/** Схема входов: из манифеста, иначе — по именам входов ONNX-сессии. */
export function resolveInterpSig(
  model: ManifestModel,
  inputNames: readonly string[],
): InterpSig | "" {
  const declared = String(model.inputSig || "");
  if (declared) return declared as InterpSig;
  return detectInterpSig(inputNames);
}

/**
 * Апскейл целого кадра/картинки: тайлы → ONNX → склейка. Возвращает rgb24
 * НАТИВНОГО множителя модели; приведение к запрошенному размеру делает ffmpeg
 * на этапе кодирования (buildFilters), поэтому один прогон модели не зависит
 * от «косметического» масштаба из UI.
 */
/**
 * Апскейл одного кадра. Экспортируется ради проверки моделей: тесты и
 * scripts-проверки гоняют реальный ONNX через этот же путь.
 */
export async function upscaleRgb(o: {
  src: Buffer | Uint8Array;
  w: number;
  h: number;
  p: UpParams;
  onTile?: (frac: number) => void;
  /** Запрошена остановка: проверяем между тайлами — один тайл по времени короткий. */
  shouldStop?: () => boolean;
  /** Готовая сессия вместо реальной: проверка моделей и тесты. */
  deps?: { ort: OrtModule; ready: ReadySession; model?: ManifestModel };
}): Promise<{ data: Uint8Array; width: number; height: number; provider: string }> {
  const ort = o.deps?.ort || loadOrt();
  if (!ort) throw new Error("runtime_missing");
  // `deps.model` — проверка модели, которой ещё нет в каталоге (verify-model.js).
  const model = o.deps?.model || findModel(o.p.model);
  if (!model) throw new Error("model_unknown");

  const ready = o.deps?.ready || (await getSession(o.p.model, o.p.provider, o.p.threads, o.p.tile));
  const scale = ready.scale || model.scale || 4;
  const outW = o.w * scale;
  const outH = o.h * scale;
  if (outW * outH > MAX_OUT_PX) throw new Error("too_large");

  let second: ReadySession | null = null;
  if (o.p.model2 && o.p.blendAmount > 0) {
    second = await getSession(o.p.model2, o.p.provider, o.p.threads, o.p.tile);
  }

  const dst = new Uint8Array(outW * outH * 3);
  // TensorRT держит вход в жёстком профиле: тайл фиксируем, а крайние тайлы
  // добираем повтором края (normTilePad) и обрезаем при вклейке (blendTile).
  const trtSize = ready.provider === "tensorrt" ? trtProfileSize(model, o.p.tile) : 0;
  const rects = tileRects(o.w, o.h, trtSize || o.p.tile || model.tile || 0, o.p.overlap);
  const align = modelAlign(model);
  let done = 0;

  for (const r of rects) {
    if (o.shouldStop?.()) throw new Error("stopped");
    // Часть графов принимает только выровненный размер (CUGAN: чётные стороны).
    const aw = trtSize || alignUp(r.w, align);
    const ah = trtSize || alignUp(r.h, align);
    const input = normTilePad(o.src, o.w, r.x, r.y, r.w, r.h, aw, ah, ready.bgr);
    let data = await runSession(ort, ready, input, aw, ah);
    if (second) {
      const inputB = normTilePad(o.src, o.w, r.x, r.y, r.w, r.h, aw, ah, second.bgr);
      const dataB = await runSession(ort, second, inputB, aw, ah);
      data = mixPlanes(data, dataB, o.p.blendAmount / 100, aw * scale * ah * scale * 3);
    }
    blendTile(
      dst,
      outW,
      outH,
      data,
      r.w,
      r.h,
      scale,
      r.x * scale,
      r.y * scale,
      o.p.overlap,
      ready.bgr,
      aw * scale,
    );
    done++;
    o.onTile?.(done / rects.length);
  }

  return { data: dst, width: outW, height: outH, provider: ready.provider };
}

/**
 * Модели, у которых пачка не заработала (фиксированный batch=1 в графе):
 * помним это на процесс, чтобы не тратить время на повторные попытки.
 */
export const batchUnsupported = new Set<string>();

/** Сколько кадров модель принимает за один run: 1 — жёстко один, 0 — неизвестно. */
export function modelBatchLimit(m: ManifestModel | null | undefined): number {
  const v = Math.round(Number(m?.batch ?? 0));
  return Number.isFinite(v) && v >= 1 ? v : 0;
}

/**
 * Есть ли смысл вообще копить пачку для этой модели.
 *
 * `false` — модель считает по одному кадру за проход (факт из каталога `batch: 1`
 * или пойманный ранее отказ): пачка только держала бы кадры в памяти, а GPU ждал
 * бы между «залпами» — кадры должны идти потоком по одному.
 */
export function modelCanBatch(m: ManifestModel | null | undefined): boolean {
  if (!m) return false;
  if (modelBatchLimit(m) === 1) return false;
  return !batchUnsupported.has(m.id);
}

/** Есть ли смысл пробовать пачку для этой модели (по id — для совместимости). */
export function batchAllowed(modelId: string): boolean {
  const m = findModel(modelId);
  if (m) return modelCanBatch(m);
  return !batchUnsupported.has(modelId);
}

/**
 * Запомнить, что модель пачку не принимает: факт на процесс, чтобы не тратить
 * время на повторные «залпы». Так же и для интерполятора: он падает на пачке
 * тайлов с той же ошибкой графа («Got: N Expected: 1»).
 */
export function markBatchUnsupported(modelId: string): void {
  if (modelId) batchUnsupported.add(modelId);
}

/**
 * Размеры для повторной попытки пачки: сначала запрошенный, затем вдвое меньше.
 *
 * Нужно, чтобы отличать «граф не принимает пачку» (тогда пачка выключается до
 * перезапуска приложения) от разового сбоя — нехватки памяти или гонки с
 * выгрузкой сессии: такая ошибка лечится пачкой поменьше, а не откатом на
 * покадровую обработку до конца процесса.
 */
export function batchTries(n: number): number[] {
  const first = Math.max(2, Math.round(n));
  const second = Math.floor(first / 2);
  return second >= 2 ? [first, second] : [first];
}

/** Ошибка ONNX «граф ждёт фиксированный batch»: по ней включаем покадровый путь. */
export function isBatchMismatch(e: unknown): boolean {
  return /Expected: ?1\b|index: 0.*Expected/i.test(String((e as Error)?.message || e));
}

/**
 * Верхний предел пачки: и заявленный моделью, и общий (BATCH_MAX).
 *
 * 0 — «неизвестно» → берём общий предел: движок попробует пачку и откатится,
 * если граф её не примет (см. runVideo).
 */
export function batchCeiling(m: ManifestModel | null | undefined): number {
  const limit = modelBatchLimit(m);
  return limit > 1 ? Math.min(limit, BATCH_MAX) : BATCH_MAX;
}

/**
 * Апскейл ПАЧКИ кадров: один session.run на тайл для всех кадров пачки.
 *
 * Вход собирается как [n,3,th,tw] — плоскости кадров идут друг за другом, — а
 * выход [n,3,oh,ow] разрезается по кадрам и вклеивается теми же blendTile.
 * Экономия — на накладных расходах вызова ONNX (заметно на мелком тайлинге).
 * Если граф модели ждёт фиксированный batch=1, вызов упадёт — вызывающий
 * поймает ошибку и обработает кадры по одному (см. runVideo).
 */
export async function upscaleRgbBatch(o: {
  frames: Uint8Array[];
  w: number;
  h: number;
  p: UpParams;
  onTile?: (frac: number) => void;
  /** Запрошена остановка: проверяем между тайлами, не дожидаясь конца пачки. */
  shouldStop?: () => boolean;
  /** Готовая сессия вместо реальной — тесты проверяют раскладку пачки. */
  deps?: { ort: OrtModule; ready: ReadySession; model?: ManifestModel };
}): Promise<{ data: Uint8Array; width: number; height: number; provider: string }[]> {
  const ort = o.deps?.ort || loadOrt();
  if (!ort) throw new Error("runtime_missing");
  const model = o.deps?.model || findModel(o.p.model);
  if (!model) throw new Error("model_unknown");
  const n = o.frames.length;
  if (n < 2) throw new Error("batch_too_small");

  const ready = o.deps?.ready || (await getSession(o.p.model, o.p.provider, o.p.threads, o.p.tile));
  const scale = ready.scale || model.scale || 4;
  const outW = o.w * scale;
  const outH = o.h * scale;
  if (outW * outH > MAX_OUT_PX) throw new Error("too_large");

  const outPlane = outW * outH;
  const outs = o.frames.map(() => new Uint8Array(outPlane * 3));
  // Та же логика, что и для одиночного кадра: у TensorRT вход фиксирован профилем.
  const trtSize = ready.provider === "tensorrt" ? trtProfileSize(model, o.p.tile) : 0;
  const rects = tileRects(o.w, o.h, trtSize || o.p.tile || model.tile || 0, o.p.overlap);
  const align = modelAlign(model);
  let done = 0;

  for (const r of rects) {
    if (o.shouldStop?.()) throw new Error("stopped");
    const aw = trtSize || alignUp(r.w, align);
    const ah = trtSize || alignUp(r.h, align);
    const inPlane = aw * ah;
    const stack = new Float32Array(n * 3 * inPlane);
    for (let k = 0; k < n; k++) {
      stack.set(
        normTilePad(o.frames[k], o.w, r.x, r.y, r.w, r.h, aw, ah, ready.bgr),
        k * 3 * inPlane,
      );
    }
    const feeds: Record<string, OrtTensor> = {
      [ready.session.inputNames[0]]: new ort.Tensor("float32", stack, [n, 3, ah, aw]),
    };
    const res = await runGuarded(ready, () => ready.session.run(feeds));
    const out = res[ready.session.outputNames[0]];
    if (!out) throw new Error("model_output_missing");
    // Плоскость кадра в выходе: может быть выравненной (aw×ah), поэтому stride
    // считаем по паспортным размерам модели, а не по bbox тайла.
    const outPlaneTile = aw * scale * ah * scale;
    for (let k = 0; k < n; k++) {
      // Раскладка 16 кадров по буферам занимает заметное время: остановку
      // проверяем и здесь, чтобы «Стоп» срабатывал, не дожидаясь всей пачки.
      if (o.shouldStop?.()) throw new Error("stopped");
      // Кадр k занимает в выходе плоскости [k*3, k*3+3) — blendTile читает их
      // как R/G/B, поэтому отдаём подмассив без копии.
      const slice = out.data.subarray(k * 3 * outPlaneTile, (k + 1) * 3 * outPlaneTile);
      blendTile(
        outs[k],
        outW,
        outH,
        slice,
        r.w,
        r.h,
        scale,
        r.x * scale,
        r.y * scale,
        o.p.overlap,
        ready.bgr,
        aw * scale,
      );
    }
    done++;
    o.onTile?.(done / rects.length);
  }

  return outs.map((d) => ({ data: d, width: outW, height: outH, provider: ready.provider }));
}

/** Кадр после ONNX → Buffer без копии пиксельных данных. */
export function toProcessed(r: { data: Uint8Array; width: number; height: number }): ProcessedFrame {
  return {
    data: Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength),
    width: r.width,
    height: r.height,
  };
}

// ================== ОЦЕНКА ЗАДАНИЯ ==================
// Скорость храним в «выходных мегапикселях в секунду»: стоимость ONNX растёт
// примерно пропорционально пикселям результата, поэтому одна цифра подходит и
// для ×2, и для ×4, и для разных моделей. Это скользящее среднее по реально
// выполненным заданиям на этой машине, а не выдуманный коэффициент — если
// заданий ещё не было, оценка времени честно пустая (null).

/** Запомнить измеренную скорость: выходные пиксели и время их обработки. */
