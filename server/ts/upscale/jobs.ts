import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import { detectFfmpeg } from "../convertEngine";
import { removeOlderThan, removePath } from "../fsUtil";
import { createQueue, trimJobs } from "../jobStore";
import {
  ffmpegCaps,
  isSceneCut,
  pickHwaccel,
  pickVideoEncoder,
  staticDuplicates,
  planInterp,
  probeMedia,
  runVideoPipeline,
  outFileName,
} from "../upscalePipeline";
import type { MediaProbe, ProcessedFrame, VideoCodec } from "../upscalePipeline";
import type { InterpSig, ManifestModel, RawUpParams, UpJob } from "./types";
import { findModel, interpMultMax, upscaleModels } from "./manifest";
import { providerOrder, runtimeAvailable } from "./runtime";
import { TRT_BATCH_MAX } from "./trt";
import { clearSessions, getSession } from "./session";
import {
  AUTO_BATCH,
  QUEUE_BATCHES,
  autoBatchFrames,
  batchFramesFor,
  buildFilters,
  gpuFreeMb,
  isImageFile,
  isNoUpscale,
  normalizeParams,
  photoOutName,
  ramBudgetMb,
} from "./params";
import {
  batchAllowed,
  batchCeiling,
  batchTries,
  batchUnsupported,
  decodeRgb,
  encodeRgb,
  interpTimesteps,
  interpolatePair,
  isBatchMismatch,
  modelBatchLimit,
  modelCanBatch,
  pickInterpModel,
  resolveInterpSig,
  toProcessed,
  upscaleRgb,
  upscaleRgbBatch,
} from "./inference";
import { recordThroughput, targetDims } from "./bench";
import {
  killJobProcs,
  setCurrentJobId,
  sweepJobProcs,
  trackProc,
} from "./procTracking";

const { DIRS } = config;

let activeJobs = 0;
// Заданий в очереди и выполняющихся: после последнего сессии больше не нужны.
let plannedJobs = 0;

/** Сколько заданий считает прямо сейчас (session.ts откладывает release, пока > 0). */
export function activeJobCount(): number {
  return activeJobs;
}

const jobs = new Map<string, UpJob>();
const JOB_LIMIT = 30;
const TTL_MS = 24 * 60 * 60 * 1000;

// Одно активное задание, остальные ждут (server/ts/jobStore.ts).
const queue = createQueue("upscale");

// TTL-чистка временных папок при загрузке модуля (server/ts/fsUtil.ts).
removeOlderThan({ dir: DIRS.upscaleIn, ttlMs: TTL_MS });
removeOlderThan({ dir: DIRS.upscaleOut, ttlMs: TTL_MS });

async function runPhoto(job: UpJob, ffmpeg: string, ffprobe: string): Promise<void> {
  job.stage = "analyze";
  const info = await probeMedia(ffprobe, job.inputPath);
  if (!(info.width > 0) || !(info.height > 0)) throw new Error("probe_failed");
  job.info = { width: info.width, height: info.height, codec: info.codec };
  const outFile = path.join(DIRS.upscaleOut, `${job.id}_${photoOutName(job.name, job.format)}`);
  job.outFile = outFile;
  job.outExt = job.format === "jpeg" ? "jpg" : job.format;

  job.stage = "upscale";
  const src = await decodeRgb(ffmpeg, job.inputPath, info.width, info.height, job.denoise);
  // «Без апскейла» для фото: перекодирование (и масштаб ffmpeg, если задан размер).
  const noUpscale = isNoUpscale(job.model);
  const r = noUpscale
    ? { data: src, width: info.width, height: info.height, provider: "" }
    : await upscaleRgb({
        src,
        w: info.width,
        h: info.height,
        p: job,
        onTile: (frac) => {
          job.progress = Math.min(92, 5 + Math.round(frac * 87));
        },
        // Фото тоже можно остановить: тайлов много, проверка дешёвая.
        shouldStop: () => job.stage === "stopped",
      });
  job.providerUsed = r.provider;

  job.stage = "encode";
  const want = targetDims(
    info.width,
    info.height,
    noUpscale ? 1 : job.scale,
    job.targetW,
    job.targetH,
  );
  job.outWidth = want.w;
  job.outHeight = want.h;
  const filters = buildFilters({
    srcW: info.width,
    srcH: info.height,
    nativeScale: r.width / info.width,
    scale: noUpscale ? 1 : job.scale,
    targetW: job.targetW,
    targetH: job.targetH,
    sharpen: job.sharpen,
  });
  await encodeRgb({
    ffmpeg,
    rgb: r.data,
    w: r.width,
    h: r.height,
    outPath: outFile,
    format: job.format,
    quality: job.quality,
    filters,
  });
}

async function runVideo(job: UpJob, ffmpeg: string, ffprobe: string): Promise<void> {
  job.stage = "analyze";
  const mp = await probeMedia(ffprobe, job.inputPath);
  if (!(mp.width > 0) || !(mp.height > 0)) throw new Error("probe_failed");
  job.info = {
    width: mp.width,
    height: mp.height,
    codec: mp.codec,
    fps: mp.fps,
    duration: mp.duration,
  };

  const outFile = path.join(DIRS.upscaleOut, `${job.id}_${outFileName(job.name, mp.hasSubs)}`);
  job.outFile = outFile;
  job.outExt = mp.hasSubs ? "mkv" : "mp4";

  // «Без апскейла»: кадры идут в энкодер как есть, ONNX-апскейлер не запускаем.
  const noUpscale = isNoUpscale(job.model);

  const want = targetDims(mp.width, mp.height, noUpscale ? 1 : job.scale, job.targetW, job.targetH);
  job.outWidth = want.w;
  job.outHeight = want.h;
  // Для видео размер выхода ONNX заранее неизвестен (его задаёт модель), поэтому
  // фильтр scale ставим всегда: при совпадении размеров ffmpeg просто скопирует.
  // Без апскейла размеры уже совпадают с исходником — фильтр не нужен вовсе.
  const filters: string[] =
    !noUpscale || want.w !== mp.width || want.h !== mp.height
      ? [`scale=${want.w}:${want.h}:flags=lanczos`]
      : [];
  if (job.sharpen > 0) {
    filters.push(`unsharp=5:5:${((job.sharpen / 100) * 1.5).toFixed(2)}:5:5:0`);
  }

  // --- Плавность (ffmpeg minterpolate) ---
  // Фильтр вставляет промежуточные кадры сам, поэтому конвейер остаётся 1:1:
  // outPerIn=1, а «больше кадров» получается на входе энкодера.
  //
  // Для ONNX-модели множитель ограничен её схемой: RIFE/IFRNet принимают момент
  // времени (×2/×3/×4 без каскадов), CAIN считает только середину пары — ему
  // больше ×2 не дать.
  const interpModelObj = job.interpMode === "model" ? pickInterpModel(job.interpModel) : null;
  const interpMult = Math.min(job.interpMult, interpMultMax(interpModelObj));
  const plan = planInterp({
    probe: mp,
    mode: job.interpMode,
    mult: interpMult,
    minterpolateMode: job.minterpolateMode,
    side: job.minterpolateSide,
    scdThreshold: job.sceneCutThreshold,
    filters,
  });
  job.fpsOut = plan.outFps;
  job.framesTotal = plan.framesTotal;

  // --- Плавность моделью (ONNX): вставки считает наш движок ---
  let interpJob: { model: ManifestModel; sig: InterpSig; ts: number[] } | null = null;
  if (plan.kind === "model") {
    const model = interpModelObj;
    // Отдельная ошибка с переводом: «скачайте интерполятор в Pro-настройках»,
    // а не техническое model_missing из создания сессии.
    if (!model || !fs.existsSync(path.join(DIRS.upscaleModels, model.file))) {
      throw new Error("interp_model_missing");
    }
    const ready = await getSession(model.id, job.provider, job.threads);
    const sig = resolveInterpSig(model, ready.session.inputNames);
    if (!sig) {
      logger.warn("upscale.interp_sig_unknown", {
        model: model.id,
        inputs: ready.session.inputNames.join(","),
      });
      throw new Error("model_signature_unknown");
    }
    // CAIN считает только середину пары: ×3/×4 урезаем до ×2 и говорим об этом.
    if (interpMult !== job.interpMult) {
      logger.info("upscale.interp_mult_clamped", {
        model: model.id,
        requested: job.interpMult,
        used: interpMult,
      });
    }
    interpJob = { model, sig, ts: interpTimesteps(plan.outPerIn) };
    // Вторая «пачка» — сколько ТАЙЛОВ пары считать одним run. Как и у апскейла,
    // смысл есть только у графа с динамическим batch: у моделей с batch=1 движок
    // получает 1 и считает тайлы по одному.
    const ceiling = batchCeiling(model);
    const canBatchTiles = modelCanBatch(model) && ceiling > 1;
    const want = job.interpBatch === AUTO_BATCH ? Math.min(4, ceiling) : job.interpBatch;
    job.interpBatchUsed = canBatchTiles ? Math.max(1, Math.min(want, ceiling)) : 0;
    logger.info("upscale.interp_batch", { model: model.id, used: job.interpBatchUsed, ceiling });
    logger.info("upscale.interp_model", { model: model.id, sig, mult: plan.outPerIn });
  }

  job.stage = "upscale";
  // --- Пачка кадров: один session.run на несколько кадров (если модель умеет) ---
  // Смешивание двух моделей идёт своим путём (два прохода + mixPlanes), поэтому
  // в пачке не участвует; для моделей с фиксированным batch=1 первый же вызов
  // упадёт — тогда откатываемся на покадровую обработку и запоминаем это.
  //
  // Запрос пользователя урезаем по памяти результата: масштаб задаёт модель,
  // и пачка 128 на 4K-кадре — это гигабайты буферов (падение с OOM).
  //
  // Значение 0 — «Авто»: считаем, сколько кадров влезает в свободную видеопамять
  // и в память под кадры, чтобы получить максимум скорости без нехватки памяти.
  const scaleOf = (id: string): number => upscaleModels().find((m) => m.id === id)?.scale ?? 4;
  const sizeOf = (id: string): number => upscaleModels().find((m) => m.id === id)?.sizeMb ?? 0;
  const modelScale = noUpscale
    ? 1
    : Math.max(scaleOf(job.model), job.model2 ? scaleOf(job.model2) : 1);
  const modelMb = noUpscale ? 0 : Math.max(sizeOf(job.model), job.model2 ? sizeOf(job.model2) : 0);
  const tileSide =
    noUpscale || job.tile
      ? job.tile
      : upscaleModels().find((m) => m.id === job.model)?.rec?.tile || 0;
  // Свободная видеопамять нужна обеим ветками: «Авто» считает по ней весь бюджет,
  // ручное значение она же урезает, если запросили больше, чем влезает.
  // На CPU видеопамять не нужна — считаем только по памяти под кадры.
  const freeMb = noUpscale || job.provider === "cpu" ? 0 : await gpuFreeMb();
  const ramMb = ramBudgetMb();
  // --- Умеет ли модель пачку вообще ---
  // У большинства Real-ESRGAN в графе жёстко batch=1: пачка не просто бесполезна,
  // она вредна — очередь держала бы десятки полных кадров в RAM, а GPU простаивал
  // между «залпами» (в мониторе это «лестница» с периодом в размер пачки).
  // Факт берём из каталога (`batch: 1`), а если он неизвестен — помним отказ,
  // пойманный при первой попытке (batchUnsupported).
  const modelForBatch = noUpscale ? null : findModel(job.model);
  const canBatch =
    !!modelForBatch && modelCanBatch(modelForBatch) && !(job.model2 && job.blendAmount > 0);
  const maxBatch = canBatch ? batchCeiling(modelForBatch) : 1;
  let batchFrames = 1;
  if (noUpscale) {
    // Пачка существует ради ONNX-заходов: без апскейла кадры просто идут в энкодер.
    job.batchUsed = 0;
    job.batchReason = "nomodel";
  } else if (!canBatch) {
    // Один кадр за проход: очередь не копим вовсе — кадры идут потоком.
    batchFrames = 1;
    job.batchUsed = 0;
    // Смешивание двух моделей пачку не использует по устройству (два прохода).
    job.batchReason = job.model2 && job.blendAmount > 0 ? "mixed" : "unsupported";
    logger.info("upscale.batch_single", {
      model: job.model,
      limit: modelBatchLimit(modelForBatch),
      mixed: !!(job.model2 && job.blendAmount > 0),
    });
  } else if (job.batchFrames === AUTO_BATCH) {
    // Реальный провайдер (не просто предпочтение пользователя) — от него
    // зависит потолок «Авто»-пачки: см. autoBatchCeilingFor.
    const batchProvider = providerOrder(job.provider, modelForBatch)[0];
    batchFrames = autoBatchFrames({
      w: mp.width,
      h: mp.height,
      scale: modelScale,
      tile: tileSide,
      freeMb,
      modelMb,
      ramBudgetMb: ramMb,
      maxBatch,
      queueBatches: QUEUE_BATCHES,
      provider: batchProvider,
    });
    job.batchUsed = batchFrames;
    logger.info("upscale.batch_auto", {
      used: batchFrames,
      maxBatch,
      freeMb,
      ramMb,
      w: mp.width,
      h: mp.height,
      scale: modelScale,
      provider: batchProvider,
    });
  } else {
    batchFrames = batchFramesFor(job.batchFrames, mp.width, mp.height, modelScale, {
      freeMb,
      modelMb,
      tile: tileSide,
      ramBudgetMb: ramMb,
      maxBatch,
      queueBatches: QUEUE_BATCHES,
    });
    job.batchUsed = batchFrames;
    if (batchFrames !== job.batchFrames) {
      logger.info("upscale.batch_clamped", {
        requested: job.batchFrames,
        used: batchFrames,
        maxBatch,
        freeMb,
        ramMb,
        w: mp.width,
        h: mp.height,
        scale: modelScale,
      });
    }
  }

  // Профиль TensorRT держит пачку в диапазоне 1..TRT_BATCH_MAX: больше — движок
  // придётся пересобирать (это минуты), поэтому пачку подрезаем и говорим об этом.
  if (providerOrder(job.provider, modelForBatch)[0] === "tensorrt" && batchFrames > TRT_BATCH_MAX) {
    logger.info("upscale.batch_trt_clamped", { requested: batchFrames, used: TRT_BATCH_MAX });
    batchFrames = TRT_BATCH_MAX;
    job.batchUsed = batchFrames;
  }

  const wantBatch = batchFrames > 1 && canBatch;
  const stopped = () => job.stage === "stopped";
  /**
   * Пачка кадров. Падение пачки — не всегда «модель не умеет пачку»: движок
   * различает отказ графа (`isBatchMismatch`) и прочие сбои (нехватка памяти,
   * выгрузка сессии, сбой драйвера). Раньше любая ошибка залипала в
   * `batchUnsupported` на весь процесс — и после одного прерывания модель
   * начинала считаться по одному кадру навсегда. Теперь: чужую ошибку сначала
   * перепроверяем пачкой вдвое меньше, и только реальный отказ графа выключает
   * пачку — с причиной в задании, а не «молча».
   */
  const processFrames = async (frames: Buffer[], _start: number): Promise<ProcessedFrame[]> => {
    const byOne = async (): Promise<ProcessedFrame[]> => {
      const out: ProcessedFrame[] = [];
      for (const f of frames) {
        const r = await upscaleRgb({
          src: f,
          w: mp.width,
          h: mp.height,
          p: job,
          shouldStop: stopped,
        });
        // Провайдер нужен UI даже когда модель не умеет пачку и считает по кадрам.
        job.providerUsed = r.provider;
        out.push(toProcessed(r));
      }
      return out;
    };

    if (frames.length > 1 && batchAllowed(job.model)) {
      // Пробуем запрошенный размер, при «непонятной» ошибке — вдвое меньше.
      for (const size of batchTries(frames.length)) {
        try {
          const rs = await upscaleRgbBatch({
            frames: size === frames.length ? frames : frames.slice(0, size),
            w: mp.width,
            h: mp.height,
            p: job,
            shouldStop: stopped,
          });
          job.providerUsed = rs[0]?.provider || job.providerUsed;
          // Пачка «съела» только часть кадров (попытка меньшего размера) —
          // остальные считаем по одному, порядок кадров сохраняется.
          if (size === frames.length) return rs.map(toProcessed);
          const out = rs.map(toProcessed);
          for (const f of frames.slice(size)) {
            const r = await upscaleRgb({
              src: f,
              w: mp.width,
              h: mp.height,
              p: job,
              shouldStop: stopped,
            });
            job.providerUsed = r.provider;
            out.push(toProcessed(r));
          }
          return out;
        } catch (e) {
          // Стоп во время пачки — это не «модель не умеет пачку»: пробрасываем
          // дальше с причиной, чтобы задание честно завершилось как остановленное.
          if (stopped()) throw new Error("stopped", { cause: e });
          const mismatch = isBatchMismatch(e);
          logger.warn(mismatch ? "upscale.batch_unsupported" : "upscale.batch_error", {
            model: job.model,
            batch: size,
            error: String((e as Error)?.message || e).slice(0, 160),
          });
          if (!mismatch) break;
          // Граф ждёт ровно один кадр: дальше пачка бессмысленна.
          batchUnsupported.add(job.model);
          job.batchUsed = 0;
          job.batchReason = "unsupported";
          break;
        }
      }
    }
    return byOne();
  };

  // --- Кодировщик и аппаратное ускорение ---
  // Кодировщик выбираем по возможностям конкретной сборки ffmpeg: жёстко
  // прописанный libsvtav1 падал там, где SVT-AV1 нет (gyan «essentials»), и
  // «AV1 просто не работал». Видеокарта берётся, только если сборка её умеет.
  const codec: VideoCodec = job.vcodec === "x265" ? "x265" : job.vcodec === "av1" ? "av1" : "x264";
  const caps = await ffmpegCaps(ffmpeg);
  const enc = pickVideoEncoder({ codec, crf: job.vcrf, caps, hw: job.hwAccel });
  if (!enc.encoder) throw new Error("vcodec_unavailable");
  job.encoderUsed = enc.label;
  const decodeHwaccel = job.hwAccel ? pickHwaccel(caps) : "";
  logger.info("upscale.encode", {
    codec,
    encoder: enc.encoder,
    hardware: enc.hardware,
    decode: decodeHwaccel,
  });

  await runVideoPipeline({
    ffmpeg,
    ffprobe,
    inputPath: job.inputPath,
    outFile,
    probe: mp,
    encoder: enc.encoder,
    qualityArgs: enc.qualityArgs,
    decodeHwaccel,
    audioAction: job.audioAction === "aac" ? "aac" : "copy",
    filters: plan.encodeFilters,
    decodeFilters: plan.decodeFilters,
    pipeRateNum: plan.pipeRate.num,
    pipeRateDen: plan.pipeRate.den,
    outRateNum: plan.outRate.num,
    outRateDen: plan.outRate.den,
    // Вставки между кадрами: сцен-кат отдаём дублями (иначе «двойники»), в
    // остальных случаях — интерполятор; на последнем кадре вставок нет.
    outPerIn: plan.outPerIn,
    // Где считать вставки: до апскейла (дешевле интерполяция, апскейл считает
    // в mult раз больше кадров) или после (как в прежнем поведении).
    interpSide: plan.interpSide,
    interpolate: interpJob
      ? async (prev, cur) => {
          // Пачка тайлов могла отвалиться на первой же паре (граф с фиксированным
          // batch): тогда движок уже перестроился на одиночные тайлы — показываем
          // в UI фактическое положение дел.
          if (job.interpBatchUsed && !modelCanBatch(interpJob.model)) job.interpBatchUsed = 0;
          if (isSceneCut(prev.data, cur.data, prev.width, prev.height, job.sceneCutThreshold)) {
            return staticDuplicates(prev.data, plan.outPerIn - 1);
          }
          return interpolatePair({
            prev: prev.data,
            cur: cur.data,
            w: prev.width,
            h: prev.height,
            p: job,
            model: interpJob.model,
            sig: interpJob.sig,
            ts: interpJob.ts,
            // 0 в job.interpBatchUsed значит «модель принимает один тайл» — тогда
            // считаем по тайлу (1), а не пытаемся собрать пачку.
            tileBatch: job.interpBatchUsed || 1,
            shouldStop: stopped,
          });
        }
      : undefined,
    frameLimit: job.frameLimit,
    slowMotion: job.slowMotion,
    // Именно урезанный размер пачки: он учитывает память результата.
    batchFrames,
    // Двойная буферизация: пока считается пачка, читается следующая.
    queueBatches: QUEUE_BATCHES,
    processFrames: wantBatch ? processFrames : undefined,
    metadata: true,
    shouldStop: () => job.stage === "stopped",
    // Пауза всей очереди: задание держит слот очереди, поэтому следующие не
    // стартуют, а обработка текущего продолжается с того же кадра.
    isPaused: () => job.paused,
    onPaused: (p) => logger.info("upscale.pause_state", { id: job.id, paused: p }),
    // Регистрируем ffmpeg-процессы: «Стоп» гасит их сразу, а не по проверке флага
    // внутри ONNX-захода (там как раз идёт основная работа).
    onProc: (kind, proc) => trackProc(job.id, kind, proc),
    // Без апскейла кадр идёт дальше как есть: пайплайн сам возьмёт его размеры.
    processFrame: noUpscale
      ? undefined
      : async (rgb, _i, w, h) => {
          const r = await upscaleRgb({ src: rgb, w, h, p: job, shouldStop: stopped });
          job.providerUsed = r.provider;
          return toProcessed(r);
        },
    onProgress: (p) => {
      job.framesDone = p.framesDone;
      if (p.framesTotal > 0) job.framesTotal = p.framesTotal;
      if (p.outFps > 0) job.fpsOut = Math.round(p.outFps * 100) / 100;
      job.fps = Math.round(p.fps * 10) / 10;
      job.etaSec = p.etaSec || null;
      job.progress =
        job.framesTotal > 0
          ? Math.min(97, 5 + Math.round((p.framesDone / job.framesTotal) * 92))
          : 50;
    },
  });
}

async function runJob(job: UpJob): Promise<void> {
  activeJobs++;
  setCurrentJobId(job.id);
  try {
    // Отменённое в очереди задание не запускаем вовсе: stage уже «stopped».
    if (job.stage === "stopped") {
      job.stage = "error";
      job.error = "stopped";
      return;
    }
    job.startedAt = Date.now();
    const ff = await detectFfmpeg();
    if (!ff.found || !ff.ffmpeg || !ff.ffprobe) throw new Error("ffmpeg_missing");
    if (!runtimeAvailable()) throw new Error("runtime_missing");
    if (job.kind === "photo") await runPhoto(job, ff.ffmpeg, ff.ffprobe);
    else await runVideo(job, ff.ffmpeg, ff.ffprobe);

    if (job.stage === "stopped") {
      job.stage = "error";
      job.error = "stopped";
      return;
    }
    job.outSize = job.outFile && fs.existsSync(job.outFile) ? fs.statSync(job.outFile).size : 0;
    job.progress = 100;
    job.etaSec = 0;
    // Измеренная скорость — для оценки времени следующего задания (/estimate).
    if (job.outWidth && job.outHeight && job.startedAt && job.framesDone > 0) {
      recordThroughput(job.framesDone * job.outWidth * job.outHeight, Date.now() - job.startedAt);
    }
    job.stage = "done";
    job.done = true;
    logger.action("upscale.done", {
      id: job.id,
      kind: job.kind,
      outSize: job.outSize,
      provider: job.providerUsed,
      model: job.model,
    });
  } catch (e) {
    job.stage = "error";
    job.error = String((e as Error)?.message || e).slice(0, 400);
    job.done = false;
    logger.warn("upscale.error", { id: job.id, error: job.error });
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    plannedJobs = Math.max(0, plannedJobs - 1);
    // Остановка — стоп-кран: пользователь ждёт, что видеопамять освободится сразу,
    // а не после последнего задания очереди. Поэтому выгружаем модели и при
    // непустой очереди, и добиваем ffmpeg, если он ещё жив.
    const stopped = job.error === "stopped";
    if (stopped) {
      killJobProcs(job.id);
      // Сигнал мог не дойти (или процесс его пережил) — сторож добивает.
      sweepJobProcs(job.id);
    }
    setCurrentJobId("");
    // Апскейл закончился и очереди больше нет: модель держать незачем, иначе она
    // продолжает занимать видеопамять (в диспетчере задач это выглядит как утечка).
    if (plannedJobs === 0 || stopped) clearSessions();
    // Исходник этой задачи оставляем (можно запустить повторно с теми же
    // настройками), а входы предыдущих заданий убираем — папка in не пухнет.
    cleanInputs([job.inputPath]);
  }
}

/** Проба загруженного файла для UI: тип, размеры, fps, длительность (без задания). */
export async function probeUpload(
  inputPath: string,
  name: string,
): Promise<MediaProbe & { kind: "photo" | "video" }> {
  const ff = await detectFfmpeg();
  if (!ff.found || !ff.ffprobe) throw new Error("ffmpeg_missing");
  const mp = await probeMedia(ff.ffprobe, inputPath);
  return { ...mp, kind: isImageFile(name) ? "photo" : "video" };
}

/**
 * Очистка папки загрузок апскейла (`storage/upscale/in`).
 *
 * Исходники нужны только на время задачи: видео занимают гигабайты, и копить их
 * по десять штук за сессию незачем. Файлы незавершённых заданий (очередь включена)
 * и всё, что перечислено в `keep`, не трогаем — иначе задача упадёт на чтении.
 *
 * `keep` нужен для «повтора»: файл только что законченной задачи сохраняем, пока
 * пользователь не начал новый (клиент зовёт очистку при выборе файла).
 */
export function cleanInputs(keep: string[] = []): { removed: number } {
  const busy = new Set<string>();
  for (const j of jobs.values()) {
    if (!j.done && j.stage !== "error") busy.add(path.resolve(j.inputPath));
  }
  for (const k of keep) if (k) busy.add(path.resolve(k));
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(DIRS.upscaleIn, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(DIRS.upscaleIn, e.name);
    if (busy.has(path.resolve(full))) continue;
    try {
      removePath(full);
      removed++;
    } catch {
      /* файл занят другим процессом — уберётся следующей уборкой по TTL */
    }
  }
  if (removed) logger.action("upscale.inputs_clean", { removed });
  return { removed };
}

/** Старт задания: нормализуем параметры, кладём в Map и ставим в очередь. */
export function startJob(
  input: { inputPath: string; name?: string; size?: number } & RawUpParams,
): UpJob {
  const params = normalizeParams(input);
  const name = String(input.name || path.basename(input.inputPath) || "media").slice(0, 200);
  const job: UpJob = {
    ...params,
    id: crypto.randomUUID(),
    kind: isImageFile(name) ? "photo" : "video",
    createdAt: Date.now(),
    startedAt: 0,
    inputPath: input.inputPath,
    outFile: null,
    outExt: "",
    name,
    size: Number(input.size) || 0,
    stage: "queued",
    progress: 0,
    etaSec: null,
    done: false,
    error: "",
    outSize: 0,
    outWidth: 0,
    outHeight: 0,
    engineUsed: params.model,
    providerUsed: "",
    encoderUsed: "",
    batchUsed: 0,
    batchReason: "",
    paused: false,
    interpBatchUsed: 0,
    framesDone: 0,
    framesTotal: 0,
    fps: 0,
    fpsOut: 0,
    info: {},
    command: "",
  };
  jobs.set(job.id, job);
  trimJobs(jobs, JOB_LIMIT);
  plannedJobs++;
  queue.enqueue(() => runJob(job));
  logger.action("upscale.start", {
    id: job.id,
    kind: job.kind,
    name: job.name,
    size: job.size,
    model: job.model,
  });
  return job;
}

/**
 * ffmpeg-процессы активных заданий (декодер и энкодер).
 *
 * «Стоп» должен быть стоп-краном: пользователь ждёт, что нагрузка на процессор и
 * видеопамять упадёт сразу, а не когда конвейер дойдёт до ближайшей проверки флага
 * (та может стоять в середине ONNX-захода). Поэтому процессы регистрируются в
 * движке и гасятся из `cancelJob` напрямую.
 */
export function pauseJobs(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.done || j.stage === "error" || j.stage === "stopped") continue;
    j.paused = true;
    n++;
  }
  if (n) logger.action("upscale.paused", { jobs: n });
  return n;
}

/** Снимает паузу — обработка продолжается с того же кадра. */
export function resumeJobs(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (!j.paused) continue;
    j.paused = false;
    n++;
  }
  if (n) logger.action("upscale.resumed", { jobs: n });
  return n;
}

export function pauseJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.done || j.paused) return false;
  j.paused = true;
  logger.action("upscale.paused", { id });
  return true;
}

export function resumeJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || !j.paused) return false;
  j.paused = false;
  logger.action("upscale.resumed", { id });
  return true;
}

/** Мягкая отмена: пайплайн проверяет stage между кадрами и останавливается сам. */
export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.done) return false;
  if (j.stage === "error" || j.stage === "stopped") return false;
  // Задание ещё в очереди (не началось) — отменяем сразу, не дожидаясь старта.
  if (!j.startedAt) {
    j.stage = "error";
    j.error = "stopped";
    j.done = true;
    j.paused = false;
    return true;
  }
  j.stage = "stopped";
  j.paused = false;
  // Стоп-кран: гасим ffmpeg немедленно. ONNX-заход прервать нельзя, но он
  // закончится на ближайшем тайле — сессии при этом выгружаются в runJob.
  killJobProcs(id);
  // Процесс мог пережить первый сигнал — добиваем после короткой паузы.
  sweepJobProcs(id);
  return true;
}

export function getJob(id: string): UpJob | null {
  return jobs.get(id) || null;
}

/**
 * Распаковать записи zip-архива (без внешних зависимостей: читаем центральный
 * каталог, deflate — через zlib). Директории пропускаем, имена приводим к
 * basename: модели Qualcomm лежат в архиве в подпапке, а ONNX Runtime ищет
 * внешние веса (`*.data`) рядом с графом.
 */

export { jobs };

// --- Диспетчер фоновых задач (server/ts/taskRegistry.ts) ---
// Апскейл уже умеет всё, что нужно провайдеру (cancelJob/pauseJob/resumeJob),
// поэтому адаптер — только перевод формы UpJob в нормализованный TmTask.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const taskRegistry = require("../taskRegistry") as typeof import("../taskRegistry");
taskRegistry.registerProvider({
  engine: "upscale",
  list: () =>
    [...jobs.values()].map((j) => {
      // j.done бывает false и при stage "error"/"stopped" (см. cancelJob выше) —
      // для Task Manager это всё равно "задача больше не активна".
      const finished = j.done || j.stage === "error" || j.stage === "stopped";
      return {
        id: j.id,
        engine: "upscale",
        label: j.name,
        stage: j.paused ? "paused" : j.stage,
        progress: Math.round(j.progress || 0),
        createdAt: j.createdAt,
        done: finished,
        error: j.error || null,
        canCancel: !finished,
        canPause: !finished,
        paused: j.paused,
      };
    }),
  cancel: (id) => cancelJob(id),
  pause: (id) => pauseJob(id),
  resume: (id) => resumeJob(id),
});
