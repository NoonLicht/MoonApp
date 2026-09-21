/**
 * Апскейл фото и видео на встроенном рантайме ONNX (onnxruntime-node).
 *
 * Архитектура v1:
 *  - Инференс — НАШ код: onnxruntime-node (N-API) + ONNX-модели из
 *    storage/models/upscale (качаются по требованию, см. scripts/fetch-models.js
 *    и POST /api/upscale/models/download). Внешних CLI-апскейлеров нет.
 *  - Пиксельный I/O — через уже имеющийся в проекте ffmpeg
 *    (server/ts/convertEngine.ts → detectFfmpeg): decode в rgb24 raw, encode из
 *    rgb24 raw. Так мы не тащим вторую библиотеку декодирования картинок.
 *  - Тайлинг: картинка режется на тайлы с перекрытием (не упереться в VRAM),
 *    результат склеивается с плавным переходом в зоне перекрытия.
 *  - Пост-обработка (резкость/шум/целевой размер) — нативный ffmpeg-фильтр
 *    (-vf scale/unsharp/hqdn3d), а не JS-циклы по пикселям.
 *  - Очередь: одно активное задание, остальные ждут (server/ts/jobStore.ts),
 *    TTL-чистка временных папок 24 ч.
 *
 * Видео идёт через server/ts/upscalePipeline.ts: decode(rawvideo) → кадры по
 * одному в этот движок → encode с копией звука/субтитров.
 *
 * TS-исходник, как server/ts/compressor.ts: компилируется в server/upscale.js
 * командой `npm run compile:server`, поэтому require("./upscale") из
 * server/routes/upscale.js работает без сборки.
 */
import { execFile, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import config from "./config";
import logger from "./logger";
import { detectFfmpeg } from "./convertEngine";
import { removeOlderThan, removePath } from "./fsUtil";
import { createQueue, trimJobs } from "./jobStore";
import {
  MAX_INTERP_MULT,
  crfMax,
  ffmpegCaps,
  frameLimitOrInf,
  isSceneCut,
  pickHwaccel,
  pickVideoEncoder,
  planOutFrames,
  staticDuplicates,
  planInterp,
  probeMedia,
  rateFps,
  runVideoPipeline,
  outFileName,
} from "./upscalePipeline";
import type { MediaProbe, ProcessedFrame, VideoCodec } from "./upscalePipeline";

// Потолок множителя плавности нужен и UI (валидация поля), и тестам — держим
// его экспортируемым из движка, а не только внутри пайплайна.
export { MAX_INTERP_MULT } from "./upscalePipeline";

const { DIRS } = config;

/**
 * Спец-значение модели: «без апскейла». Кадры идут в энкодер как есть (при
 * желании — только с интерполяцией), ONNX-апскейлер не запускается вовсе.
 */
export const NO_UPSCALE = "none";

/** Выбран режим «без апскейла» (только плавность/перекодирование). */
export function isNoUpscale(modelId: string): boolean {
  return String(modelId || "") === NO_UPSCALE;
}

/** Параметры задания: всё, что приходит из UI (multipart отдаёт строками). */
export interface UpParams {
  model: string;
  model2: string;
  blendAmount: number;
  scale: number;
  targetW: number;
  targetH: number;
  tile: number;
  overlap: number;
  threads: number;
  provider: string;
  format: string;
  quality: number;
  sharpen: number;
  denoise: number;
  vcodec: string;
  vcrf: number;
  audioAction: string;
  presetId: string;
  /** off | ffmpeg (minterpolate) | model (ONNX RIFE/CAIN — фаза 2). */
  interpMode: string;
  /** id ONNX-интерполятора из манифеста (kind="interp"); пусто — первый доступный. */
  interpModel: string;
  /** 2 | 3 | 4: во сколько раз больше кадров на выходе. */
  interpMult: number;
  /** mci (оценка движения) | blend (смешивание) | dup (дубли). */
  minterpolateMode: string;
  /**
   * Где считать вставки: decode (до апскейла) | encode (после апскейла).
   *
   * У ffmpeg-режима это сторона фильтра minterpolate, у ONNX-модели — где движок
   * считает промежуточные кадры: «до апскейла» интерполирует исходные кадры (и
   * апскейлер обрабатывает в mult раз больше кадров), «после» — увеличенные.
   */
  minterpolateSide: string;
  /** Порог смены сцены 0–100: выше — дубли вместо интерполяции (без «двойников»). */
  sceneCutThreshold: number;
  /**
   * Кадров за один session.run (0 — «Авто» | 1 | 2 | … | 128): пачка экономит
   * накладные расходы ONNX. Граф с жёстким batch=1 (большинство Real-ESRGAN)
   * пачку не принимает — движок тогда вообще не копит очередь (см. runVideo).
   */
  batchFrames: number;
  /**
   * Сколько ТАЙЛОВ интерполятора считать одним session.run (0 — «Авто», 1 — по
   * тайлу за раз). Вторая «пачка» — для интерполятора: он работает по паре кадров
   * и своим тайлингом, поэтому настраивается отдельно от апскейла. Как и у
   * апскейлера, значение имеет смысл только если граф принимает batch>1.
   */
  interpBatch: number;
  /** Обработать только первые N кадров видео (0 — весь файл): быстрая проба. */
  frameLimit: number;
  /** Замедление результата: 1 — как есть, 0.5 — вдвое медленнее, 0.25 — вчетверо. */
  slowMotion: number;
  /**
   * Считать кодирование и декодирование на видеокарте, если она есть (NVENC/QSV/
   * AMF + аппаратный декодер). Выключено — всё делает CPU (lib*-кодировщики).
   */
  hwAccel: boolean;
}

/** Сырые поля из тела запроса (до normalizeParams). */
export interface RawUpParams extends Partial<Record<keyof UpParams, unknown>> {
  inputPath?: unknown;
  name?: unknown;
  size?: unknown;
}

/** Задание апскейла: UI опрашивает его состояние. */
export interface UpJob extends UpParams {
  id: string;
  kind: "photo" | "video";
  createdAt: number;
  startedAt: number;
  inputPath: string;
  outFile: string | null;
  /** Расширение результата (png/jpg/webp/avif | mp4/mkv) — для имени при скачивании. */
  outExt: string;
  name: string;
  size: number;
  stage: string;
  progress: number;
  etaSec: number | null;
  done: boolean;
  error: string;
  outSize: number;
  outWidth: number;
  outHeight: number;
  engineUsed: string;
  providerUsed: string;
  /** Кодировщик результата: «NVENC» / «SVT-AV1» / «x264» (что реально сработало). */
  encoderUsed: string;
  /** Пачка кадров, с которой реально считали (для «Авто» — подобранная). */
  batchUsed: number;
  /**
   * Пачка ТАЙЛОВ интерполятора, с которой реально считали (0 — не считается:
   * интерполяция выключена или модель принимает только один тайл за run).
   */
  interpBatchUsed: number;
  /**
   * Почему пачка не используется, если она выключена: "" — используется или не
   * запрашивалась, "unsupported" — граф принимает один кадр, "mixed" — смешивание
   * двух моделей, "nomodel" — без апскейла. UI показывает это вместо «Авто (64)»,
   * когда фактически кадры идут по одному.
   */
  batchReason: string;
  /** Задание на паузе: кадры и процессы живут, но обработка стоит. */
  paused: boolean;
  framesDone: number;
  framesTotal: number;
  fps: number;
  /** Частота кадров результата (нужна для бейджа «25 → 50 fps»). */
  fpsOut: number;
  info: {
    width?: number;
    height?: number;
    codec?: string;
    fps?: number;
    duration?: number;
  };
  command: string;
}

/** Пресет апскейла: системные из SYSTEM_PRESETS + пользовательские из settings. */
export interface UpPreset {
  id: string;
  kind: "photo" | "video";
  model: string;
  scale: number;
  format?: string;
  quality?: number;
  tile?: number;
  overlap?: number;
  sharpen?: number;
  denoise?: number;
  provider?: string;
  targetW?: number;
  targetH?: number;
  vcodec?: string;
  vcrf?: number;
  audioAction?: string;
  /** Пресеты плавности: те же поля, что у UpParams (см. интерполяцию). */
  interpMode?: string;
  /** Какая модель-интерполятор (когда interpMode = "model"). */
  interpModel?: string;
  interpMult?: number;
  minterpolateMode?: string;
  minterpolateSide?: string;
  sceneCutThreshold?: number;
  batchFrames?: number;
  interpBatch?: number;
  frameLimit?: number;
  slowMotion?: number;
}

/** Модель для UI: каталог из манифеста + статус наличия файла. */
export interface UpModelInfo {
  id: string;
  label: string;
  /** upscale — апскейлер, interp — интерполятор кадров (разные списки в UI). */
  kind: "upscale" | "interp";
  /** Множитель апскейла либо во сколько раз интерполятор увеличивает число кадров. */
  scale: number;
  mult: number;
  /** Максимум множителя плавности: у CAIN 2, у RIFE/IFRNet — до MAX_INTERP_MULT. */
  multMax: number;
  arch: string;
  /** Схема входов интерполятора (пусто у апскейлеров). */
  inputSig: string;
  /**
   * Сколько кадров модель принимает за один run: 1 — жёстко один (пачка
   * невозможна), 0 — неизвестно (движок пробует и запоминает отказ), N>1 — предел.
   */
  batch: number;
  /** Кратность сторон входа (1 — требование не задано): панель и UI показывают как «×2». */
  align: number;
  /** Рекомендованный провайдер модели ("" — как в настройках). */
  provider: string;
  /**
   * Собранный движок TensorRT этой модели («512/…engine», пусто — не собран).
   * Имена файлов движков — хеши графа, поэтому связь «модель → движок» ведём
   * реестром (`.trt\registry.json`), а не по именам файлов.
   */
  trtEngine: string;
  file: string;
  sizeMb: number;
  license: string;
  url: string;
  path: string;
  available: boolean;
  /** Файл ONNX лежит на диске (false у «тензорных» моделей: ONNX убран, движок есть). */
  onnxOnDisk: boolean;
  /** Категории модели (photo/video/anime/fast/detail/restore/heavy/interp). */
  tags: string[];
  /** Рекомендуемые настройки этой модели: тайл, перекрытие, резкость, шум. */
  rec: {
    scale?: number;
    tile?: number;
    overlap?: number;
    sharpen?: number;
    denoise?: number;
    interpMult?: number;
    sceneCut?: number;
  };
  /** Измерено на реальном инференсе (мс и множитель) — для подсказки в панели. */
  measured: string;
  /** sha256 из манифеста: если задан, загрузка проверяется по хешу. */
  sha256: string;
  /** Что это за модель и для чего (короткое описание). */
  hint: string;
  /** Прогресс скачивания этой модели (0…100) или null, если не качается. */
  downloading: { gotMb: number; totalMb: number; percent: number } | null;
}

/** Запись манифеста server/models.manifest.json. */
interface ManifestModel {
  id: string;
  label: string;
  /** По умолчанию "upscale" (старые записи поле не содержат). */
  kind?: string;
  scale: number;
  /** У интерполяторов — сколько кадров даёт одна пара (обычно 2). */
  mult?: number;
  arch: string;
  inputSig?: string;
  file: string;
  sizeMb: number;
  license: string;
  bgr?: boolean;
  tile?: number;
  /** Перекрытие тайлов по умолчанию (у интерполяторов больше — швы в движении). */
  overlap?: number;
  /**
   * Кратность сторон входа (Real-CUGAN и родственные: внутри есть down/up-семплинг).
   * Движок добирает тайл повтором края и обрезает результат при вклейке.
   */
  align?: number;
  /**
   * Рекомендованный провайдер модели (`cpu` — если граф не работает на GPU,
   * например Anime4K на DirectML). Движок ставит его первым в списке попыток.
   */
  provider?: string;
  url: string;
  sha256: string;
  /** Категории для фильтра в панели моделей: photo/video/anime/fast/… */
  tags?: string[];
  /** Оптимальные настройки именно этой модели (кнопка «Применить» в панели). */
  rec?: {
    scale?: number;
    tile?: number;
    overlap?: number;
    sharpen?: number;
    denoise?: number;
    interpMult?: number;
    sceneCut?: number;
  };
  /** Как модель показала себя на реальном инференсе (для панели моделей). */
  _measured?: string;
  _hint?: string;
  /**
   * Сколько кадров модель принимает за ОДИН session.run.
   *
   *   1  — граф жёстко ждёт batch=1 (так у большинства Real-ESRGAN): пачка
   *        кадров не просто бесполезна, а вредна — очередь копила бы десятки
   *        полных кадров в RAM, а GPU простаивал между «залпами»;
   *   N>1 — динамическая ось, граф принимает до N кадров за раз;
   *   нет поля — неизвестно: движок пробует пачку и запоминает отказ
   *        (см. batchUnsupported), а точный факт пишет scripts/verify-model.js.
   *
   * У интерполяторов то же поле означает «сколько тайлов пары за один run».
   */
  batch?: number;
}

// ================== КАТАЛОГ МОДЕЛЕЙ (живой манифест) ==================
// Каталог НЕ должен приезжать только вместе с обновлением приложения: список
// моделей правится в репозитории на GitHub, а приложение забирает его кнопкой
// «Обновить каталог» (POST /api/upscale/models/sync). Источники по приоритету:
//
//   1) storage/models/models.manifest.json — скачанный каталог. Он ПЕРЕКРЫВАЕТ
//      встроенный целиком: добавили модель на GitHub — она появляется у
//      пользователя, убрали — исчезает (файл при этом с диска не удаляется);
//   2) server/models.manifest.json — вшитый в сборку (первый запуск, офлайн).
//
// Адресов по умолчанию два — сам GitHub (raw) и зеркало jsDelivr: если один
// недоступен, sync пробует следующий. Свой адрес (например, отдельный
// репозиторий только с каталогом) задаётся переменной MOONAPP_MANIFEST_URL.
const MANIFEST_REPO = "NoonLicht/MoonApp";
const MANIFEST_BRANCH = "master";
const MANIFEST_PATHS = [
  `https://raw.githubusercontent.com/${MANIFEST_REPO}/${MANIFEST_BRANCH}/server/models.manifest.json`,
  `https://cdn.jsdelivr.net/gh/${MANIFEST_REPO}@${MANIFEST_BRANCH}/server/models.manifest.json`,
];
/** Потолок приёма из сети: каталог — это JSON на десятки килобайт. */
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
/** Сколько ждём ответ GitHub, прежде чем пробовать зеркало. */
const MANIFEST_TIMEOUT_MS = 15000;

/** Скачанный каталог (важнее встроенного) — лежит в storage, не в сборке. */
function userManifestFile(): string {
  return path.join(DIRS.storage, "models", "models.manifest.json");
}
/** Вшитый в сборку каталог — запасной вариант (офлайн/первый запуск). */
function bundledManifestFile(): string {
  return path.join(__dirname, "models.manifest.json");
}

/** Адреса для «Обновить каталог»: MOONAPP_MANIFEST_URL перекрывает основной. */
export function manifestUrls(): string[] {
  const own = String(process.env.MOONAPP_MANIFEST_URL || "").trim();
  return own ? [own, ...MANIFEST_PATHS] : [...MANIFEST_PATHS];
}

/** Строка не длиннее n (манифест приходит из сети — режем всё лишнее). */
function clip(v: unknown, n: number): string {
  return typeof v === "string" ? v.slice(0, n) : "";
}
/** Число в диапазоне или значение по умолчанию. */
function num(v: unknown, min: number, max: number, def: number): number {
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
}
/** Число в диапазоне или undefined (необязательные поля). */
function numOpt(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : undefined;
}

const ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
// Имя файла — без разделителей пути: запись вида "../../secrets.json" увела бы
// загрузку модели из storage/models/upscale.
const FILE_RE = /^[a-zA-Z0-9._-]{1,90}\.onnx$/i;
const SHA_RE = /^[0-9a-f]{64}$/i;
const TAG_RE = /^[a-z0-9_-]{1,20}$/;
/** Провайдеры ONNX Runtime, которые имеет смысл просить у движка. */
const PROVIDER_RE = /^(cpu|cuda|dml|tensorrt|openvino|directml)$/i;

/** «Оптимальные настройки» модели — только известные числовые поля. */
function sanitizeRec(v: unknown): ManifestModel["rec"] {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  const put = (k: string, min: number, max: number): void => {
    const x = numOpt(r[k], min, max);
    if (x !== undefined) out[k] = x;
  };
  put("scale", 1, 8);
  put("tile", 0, 8192);
  put("overlap", 0, 1024);
  put("sharpen", 0, 100);
  put("denoise", 0, 100);
  put("interpMult", 2, MAX_INTERP_MULT);
  put("sceneCut", 0, 100);
  return Object.keys(out).length ? (out as ManifestModel["rec"]) : undefined;
}

/**
 * Проверка каталога перед использованием: манифест — «живой» файл из сети,
 * поэтому каждая запись проверяется и чистится (мусорные записи отбрасываются,
 * а не роняют страницу). Возвращаем то, чем можно безопасно работать.
 */
export function sanitizeManifest(raw: unknown): ManifestModel[] {
  const list = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  const out: ManifestModel[] = [];
  const seen = new Set<string>();
  // Потолок на случай, если по ссылке оказался «не тот» файл.
  for (const item of list.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const id = clip(m.id, 64).trim();
    const file = clip(m.file, 100).trim();
    if (!ID_RE.test(id) || !FILE_RE.test(file) || seen.has(id)) continue;
    seen.add(id);
    const url = clip(m.url, 500).trim();
    const sha256 = clip(m.sha256, 64).trim();
    const tags = Array.isArray(m.tags)
      ? m.tags.filter((x) => TAG_RE.test(String(x))).slice(0, 8)
      : [];
    out.push({
      id,
      file,
      label: clip(m.label, 120).trim() || id,
      kind: m.kind === "interp" ? "interp" : "upscale",
      scale: num(m.scale, 1, 8, 1),
      mult: numOpt(m.mult, 2, MAX_INTERP_MULT),
      arch: clip(m.arch, 40),
      // Пустая строка в манифесте — это «ещё не измеряли», а не «поля нет»:
      // сохраняем как есть, чтобы скачанный каталог не отличался от исходного.
      inputSig: typeof m.inputSig === "string" ? clip(m.inputSig, 60) : undefined,
      sizeMb: num(m.sizeMb, 0, 200000, 0),
      license: clip(m.license, 40),
      bgr: m.bgr === true,
      tile: numOpt(m.tile, 0, 8192),
      overlap: numOpt(m.overlap, 0, 1024),
      // Требование к кратности сторон входа (CUGAN): движок выравнивает тайл.
      align: numOpt(m.align, 2, 64),
      // Рекомендация провайдера: cpu/cuda/dml/… (иначе — общий список настроек).
      provider: PROVIDER_RE.test(String(m.provider ?? ""))
        ? String(m.provider).toLowerCase()
        : undefined,
      // Факт о пачке: 1 — граф ждёт ровно один вход, N>1 — предел. Поле должно
      // переживать sync каталога с GitHub, иначе настройка пачки «вернётся» к
      // моделям, которые её не принимают.
      batch: numOpt(m.batch, 1, BATCH_MAX),
      // Только http(s): file:// и data: в каталоге — это уже не модель с GitHub.
      url: /^https?:\/\//i.test(url) ? url : "",
      sha256: SHA_RE.test(sha256) ? sha256.toLowerCase() : "",
      tags: tags.map(String),
      rec: sanitizeRec(m.rec),
      _measured: typeof m._measured === "string" ? clip(m._measured, 400) : undefined,
      _hint: typeof m._hint === "string" ? clip(m._hint, 400) : undefined,
    });
  }
  return out;
}

interface ManifestCache {
  /**
   * Ключ «путь + время правки»: правку файла видно сразу, а смена источника
   * (после sync) сама инвалидирует кэш — путь в ключе другой.
   */
  key: string;
  /** Из какого файла прочитан каталог (для manifestInfo). */
  file: string;
  mtime: number;
  models: ManifestModel[];
}
let manifestCache: ManifestCache | null = null;

/** Читает каталог: сначала скачанный (storage), затем вшитый в сборку. */
function loadManifest(): ManifestModel[] {
  for (const file of [userManifestFile(), bundledManifestFile()]) {
    if (!fs.existsSync(file)) continue;
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const key = `${file}|${mtime}`;
      if (manifestCache?.key === key) return manifestCache.models;
      const models = sanitizeManifest(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!models.length) {
        // Пустой или испорченный каталог не должен оставить UI без моделей:
        // падаем на следующий источник (вшитый каталог).
        logger.warn("upscale.manifest_empty", { file });
        continue;
      }
      manifestCache = { key, file, mtime, models };
      return models;
    } catch (e) {
      // Битая правка манифеста не должна ломать страницу: пробуем следующий
      // источник, а если и его нет — отдаём последний удачный список.
      logger.warn("upscale.manifest", {
        file,
        error: String((e as Error).message).slice(0, 200),
      });
    }
  }
  if (!manifestCache) manifestCache = { key: "", file: "", mtime: 0, models: [] };
  return manifestCache.models;
}

/** Откуда взят каталог и когда обновлялся — для панели «Модели ONNX». */
export interface ManifestInfo {
  /** remote — каталог скачан кнопкой; bundled — вшитый в сборку. */
  source: "remote" | "bundled";
  /** Файл, из которого реально прочитан каталог. */
  path: string;
  /** Основной адрес обновления (кнопка «Обновить каталог»). */
  url: string;
  count: number;
  /** Когда каталог скачивали в последний раз (ISO) или "". */
  updatedAt: string;
}

export function manifestInfo(): ManifestInfo {
  const models = loadManifest();
  const src = manifestCache?.file || bundledManifestFile();
  let updatedAt = "";
  try {
    if (manifestCache?.mtime) updatedAt = new Date(manifestCache.mtime).toISOString();
  } catch {
    /* нет файла — нет даты */
  }
  return {
    source: src === userManifestFile() ? "remote" : "bundled",
    path: src,
    url: manifestUrls()[0],
    count: models.length,
    updatedAt,
  };
}

/** Скачать текст по адресу: таймаут и потолок размера (каталог, не медиа). */
async function fetchManifestText(url: string, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ac.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    if (Number(res.headers.get("content-length") || 0) > MANIFEST_MAX_BYTES) {
      throw new Error("manifest_too_big");
    }
    const text = await res.text();
    if (text.length > MANIFEST_MAX_BYTES) throw new Error("manifest_too_big");
    return text;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // Причина остаётся в cause: по ней в логе видно, сеть это или HTTP-код.
    if (/abort/i.test(msg)) throw new Error("timeout", { cause: e });
    throw new Error(msg, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

/** Результат «Обновить каталог»: что изменилось по сравнению с прежним списком. */
export interface ManifestSyncResult {
  ok: boolean;
  /** Работавший адрес (основной или зеркало). */
  url: string;
  source: "remote";
  path: string;
  count: number;
  /** Ид моделей, которых раньше не было / которые исчезли / изменились. */
  added: string[];
  removed: string[];
  changed: string[];
  updatedAt: string;
}

/**
 * «Обновить каталог»: тянем манифест из GitHub (или своего адреса), проверяем
 * каждую запись и кладём в storage. Каталог в приложении меняется сразу —
 * обновлять сборку приложения для новой модели не нужно.
 *
 * Ошибки переводимы и не разрушают текущий каталог: файл пишется только после
 * успешной проверки (через .tmp + rename), поэтому прерванная загрузка не
 * оставит «половину» манифеста.
 */
export async function syncManifest(
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<ManifestSyncResult> {
  const own = String(opts.url || "").trim();
  const urls = own ? [own] : manifestUrls();
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || MANIFEST_TIMEOUT_MS);
  const errors: string[] = [];
  let last: Error = new Error("manifest_fetch");
  for (const url of urls) {
    try {
      const text = await fetchManifestText(url, timeoutMs);
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("manifest_invalid");
      }
      const models = sanitizeManifest(doc);
      if (!models.length) throw new Error("manifest_empty");

      // «До» берём из текущего каталога: панель покажет, что изменилось.
      const before = new Map(loadManifest().map((m) => [m.id, m] as const));
      const dest = userManifestFile();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".tmp";
      const updatedAt = new Date().toISOString();
      // Ключи манифеста (_note, _verified) сохраняем, models — проверенные.
      const out = { ...doc, models, _source: url, _updatedAt: updatedAt };
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, dest);
      manifestCache = null; // каталог перечитается из нового файла

      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];
      const after = new Map(models.map((m) => [m.id, m] as const));
      for (const id of after.keys()) if (!before.has(id)) added.push(id);
      for (const [id, m] of before) {
        const n = after.get(id);
        if (!n) {
          removed.push(id);
          continue;
        }
        if (
          n.url !== m.url ||
          n.sha256 !== m.sha256 ||
          n.scale !== m.scale ||
          n.file !== m.file ||
          JSON.stringify(n.rec || {}) !== JSON.stringify(m.rec || {}) ||
          JSON.stringify(n.tags || []) !== JSON.stringify(m.tags || [])
        ) {
          changed.push(id);
        }
      }
      logger.action("upscale.manifest_synced", {
        url,
        count: models.length,
        added: added.length,
        removed: removed.length,
      });
      return {
        ok: true,
        url,
        source: "remote",
        path: dest,
        count: models.length,
        added,
        removed,
        changed,
        updatedAt,
      };
    } catch (e) {
      // Наши коды (manifest_*/http_*/timeout) отдаём как есть — UI их переводит,
      // а сетевые сбои (fetch failed, ENOTFOUND) сводим к одному переводу.
      let msg = String((e as Error)?.message || e);
      if (!/^(http_\d+|manifest_|timeout)/.test(msg)) msg = "manifest_fetch";
      last = new Error(msg);
      errors.push(`${url}: ${String((e as Error)?.message || e).slice(0, 120)}`);
    }
  }
  logger.warn("upscale.manifest_sync_failed", { errors: errors.join(" | ").slice(0, 400) });
  throw last;
}

function findModel(id: string): ManifestModel | null {
  return loadManifest().find((m) => m.id === id) || null;
}

/** Каталог для UI: + путь на диске и признак «файл скачан». */
export function listModels(): UpModelInfo[] {
  return loadManifest().map((m) => {
    const p = path.join(DIRS.upscaleModels, m.file);
    const onnxOnDisk = fs.existsSync(p);
    return {
      id: m.id,
      label: m.label,
      kind: modelKind(m),
      scale: m.scale,
      mult: interpMult(m),
      // Предел множителя плавности: у CAIN он 2 (момент времени модель не
      // принимает), у RIFE/IFRNet — до MAX_INTERP_MULT.
      multMax: interpMultMax(m),
      arch: m.arch,
      inputSig: String(m.inputSig || ""),
      // Факт о пачке из каталога: 1 — граф ждёт ровно один кадр (пачка невозможна),
      // 0 — неизвестно, N>1 — предел. UI по нему прячет настройку пачки, а движок
      // для моделей с batch=1 вообще не копит очередь.
      batch: modelBatchLimit(m),
      align: modelAlign(m),
      provider: String(m.provider || ""),
      trtEngine: trtEngineFor(m.id),
      file: m.file,
      sizeMb: m.sizeMb,
      license: m.license,
      url: m.url,
      path: p,
      // «Готова к работе»: файл на диске или собранный движок TensorRT (ONNX
      // после сборки убирается, а граф движок докачает сам при первом запуске).
      available: onnxOnDisk || !!trtEngineFor(m.id),
      onnxOnDisk,
      tags: (m.tags || []).map(String),
      rec: m.rec || {},
      measured: String(m._measured || ""),
      sha256: String(m.sha256 || ""),
      hint: String(m._hint || ""),
      downloading: downloadProgress(m.id),
    };
  });
}

/** Прогресс текущей загрузки (null — модель не качается прямо сейчас). */
function downloadProgress(id: string): UpModelInfo["downloading"] {
  const st = downloads.get(id);
  if (!st || st.state !== "working") return null;
  return {
    gotMb: Math.round((st.got / 1048576) * 10) / 10,
    totalMb: st.total ? Math.round((st.total / 1048576) * 10) / 10 : 0,
    percent: st.total ? Math.min(99, Math.round((st.got / st.total) * 100)) : 0,
  };
}

/** Загрузки моделей: прогресс виден в UI (как у панели движка лекций). */
const downloads = new Map<string, { got: number; total: number; state: string; error: string }>();

/** Состояние загрузок для панели моделей. */
export function downloadStates(): Record<string, { state: string; error: string }> {
  const out: Record<string, { state: string; error: string }> = {};
  for (const [id, st] of downloads) out[id] = { state: st.state, error: st.error };
  return out;
}

/**
 * Удаление скачанной модели: файл уходит с диска, сессия — из кэша (иначе
 * ONNX держал бы дескриптор и файл не удалился на Windows).
 */
export function removeModel(id: string): { ok: boolean; removed: boolean } {
  const m = findModel(id);
  if (!m) throw new Error("model_unknown");
  const p = path.join(DIRS.upscaleModels, m.file);
  clearSessions();
  // Вместе с моделью уходят её движки: иначе они занимали бы место и попадали
  // в реестр как «движок есть» у удалённой модели.
  dropEngines(id);
  const removed = fs.existsSync(p);
  if (removed) fs.rmSync(p, { force: true });
  // Модель, установленная из архива (Qualcomm), состоит из нескольких файлов:
  // граф + внешние веса. Их список лежит рядом (индекс) — убираем и его.
  const index = p + ".files.json";
  try {
    if (fs.existsSync(index)) {
      const files = JSON.parse(fs.readFileSync(index, "utf8")) as unknown;
      if (Array.isArray(files)) {
        for (const f of files) {
          // Только имена в той же папке: индекс не должен никуда уводить.
          if (typeof f !== "string" || f === m.file || path.basename(f) !== f) continue;
          fs.rmSync(path.join(DIRS.upscaleModels, f), { force: true });
        }
      }
      fs.rmSync(index, { force: true });
    }
  } catch (e) {
    logger.warn("upscale.remove_files", { id, error: String((e as Error).message).slice(0, 160) });
  }
  logger.action("upscale.model_removed", { id, removed });
  return { ok: true, removed };
}

/** Вид модели: старое поле kind не задано — значит апскейлер. */
export function modelKind(m: ManifestModel): "upscale" | "interp" {
  return m.kind === "interp" ? "interp" : "upscale";
}

/** Во сколько раз интерполятор увеличивает число кадров (по умолчанию ×2). */
export function interpMult(m: ManifestModel): number {
  if (modelKind(m) !== "interp") return 1;
  const v = Math.round(Number(m.mult ?? 2));
  return Number.isFinite(v) && v > 1 ? Math.min(MAX_INTERP_MULT, v) : 2;
}

/** Только интерполяторы — для выпадающего списка «Модель плавности» в UI. */
export function interpModels(): UpModelInfo[] {
  return listModels().filter((m) => m.kind === "interp");
}

/**
 * Сколько кадров модель умеет выдать на каждый исходный.
 *
 * Схема с `timestep` (RIFE, IFRNet) считает ЛЮБОЙ момент времени, поэтому ×2/×3/×4
 * работают без каскадов; CAIN интерполирует ровно середину пары и момент не
 * принимает — для неё максимум ×2 (при ×3 движок вернул бы один и тот же средний
 * кадр дважды, то есть испортил бы результат, оставаясь «формально верным»).
 *
 * `rec.interpMult` в манифесте — это рекомендация, а не предел: у всех
 * интерполяторов она равна 2, хотя RIFE/IFRNet умеют больше.
 */
export function interpMultMax(model?: ManifestModel | null): number {
  if (!model) return MAX_INTERP_MULT;
  const sig = String(model.inputSig || "");
  if (sig === "cain-concat" || String(model.arch || "") === "cain") return 2;
  return MAX_INTERP_MULT;
}

/** Только апскейлеры — интерполятор нельзя выбрать как модель апскейла. */
export function upscaleModels(): UpModelInfo[] {
  return listModels().filter((m) => m.kind === "upscale");
}

// ================== ONNXRUNTIME-NODE ==================
// Загружаем динамически: пакет опциональный (нативная библиотека), и его
// отсутствие НЕ должно ронять сервер — просто все задания апскейла вернут
// понятную ошибку «runtime_missing», а UI подскажет поставить зависимости.
interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  /** Освобождение ресурсов: без него память (в т.ч. видеопамять) не отдаётся. */
  release?: () => Promise<void>;
  /**
   * Типы тензоров графа. Нужны, чтобы поддержать модели половинной точности
   * (fp16-экспорты Anime4K и подобные): у них вход/выход не float32, и без
   * конверсии ORT падает на «unexpected data type». У onnxruntime-node это
   * массив `{name, type, shape}`, у старых сборок — словарь по имени входа.
   */
  inputMetadata?: unknown;
  outputMetadata?: unknown;
}
interface OrtModule {
  InferenceSession: {
    create(p: string, o?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  env?: { versions?: { common?: string } };
  /** Какие провайдеры собраны в этот рантайм (cpu/dml/cuda/tensorrt/…). */
  listSupportedBackends?: () => { name?: string }[];
}

let ortCache: OrtModule | null | undefined;
/** Подменённый рантайм (тесты) — имеет приоритет над настоящим модулем. */
let ortForTests: OrtModule | null = null;
/** Причина отказа последней попытки и время попытки (чтобы не спамить require). */
let ortError = "";
let ortPath = "";
let ortTriedAt = 0;
/** Повторять неудачную попытку не чаще, чем раз в 5 секунд. */
const ORT_RETRY_MS = 5000;

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
function loadOrt(force = false): OrtModule | null {
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
function trtDir(size = 0, modelId = ""): string {
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
function registerTrtEngine(modelId: string, profile: number, dir: string): string {
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
        trt_max_workspace_size: 4 * 1024 * 1024 * 1024,
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

export interface TrtStatus {
  available: boolean;
  /** Что вообще есть в рантайме (для подсказки в UI). */
  backends: string[];
  dir: string;
  engines: { file: string; sizeMb: number; mtime: number }[];
}

/** Готовность TensorRT: есть ли провайдер в сборке и что уже собрано. */
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
export interface TrtBuildResult {
  ok: boolean;
  ms: number;
  /** Размер входа, под который собран движок (он же — размер тайла). */
  profile: number;
  /** Новые файлы движка: пусто — движок уже лежал в кэше и был просто загружен. */
  engines: { file: string; sizeMb: number }[];
  /** Движок не собирался заново, а взят из кэша (первый заход был мгновенным). */
  reused: boolean;
  /** Файл движка этой модели («512/модель/…engine») — для сообщения в панели. */
  engine: string;
  engineMb: number;
  /** Сколько движков собрано всего (по всем моделям и профилям). */
  total: number;
  /** Сколько МБ освободило удаление ONNX (0 — файл оставлен или уже удалён). */
  onnxFreedMb: number;
}

/**
 * Потолок размера ONNX, который убираем после сборки движка. Крупные модели
 * (CAIN, 164 МБ) оставляем: их докачка при следующем запуске была бы заметной.
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
function dropEngines(id: string): void {
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

interface ReadySession {
  session: OrtSession;
  provider: string;
  bgr: boolean;
  scale: number;
  /** Граф объявлен во float16: вход и выход конвертируются на границе ORT. */
  fp16?: boolean;
  /** Ключ в кэше: по нему убираем запись, когда сессию выгружаем. */
  key: string;
  /** Сколько session.run выполняется прямо сейчас (0 — сессия свободна). */
  runs?: number;
  /** Помечена на выгрузку: release() ждём до конца текущего run. */
  dead?: boolean;
}

// Кэш сессий: создание ONNX-сессии — дорогая операция (чтение файла, графы).
const sessions = new Map<string, Promise<ReadySession>>();
// Готовые сессии отдельно: их нужно освобождать вручную. Без release() память
// устройства (видеокарты) остаётся занятой до выхода из приложения.
const loaded = new Map<string, ReadySession>();
// Сколько заданий считает прямо сейчас: release во время инференса ломает сессию.
let activeJobs = 0;
// Заданий в очереди и выполняющихся: после последнего сессии больше не нужны.
let plannedJobs = 0;

/** Освободить сессию: release() отдаёт и видеопамять модели. */
function disposeSession(rs: ReadySession): void {
  // release() во время инференса рвёт сессию: тогда пачка, которая уже считается
  // в ONNX, падала бы с чужой ошибкой, а движок помечал бы модель «не умеет
  // пачку». Поэтому при активном run только помечаем сессию — release сделает
  // тот же run в finally (см. runGuarded).
  if ((rs.runs || 0) > 0) {
    rs.dead = true;
    logger.info("upscale.session_release_deferred", {
      session: rs.key,
      runs: rs.runs,
      provider: rs.provider,
    });
    return;
  }
  sessions.delete(rs.key);
  loaded.delete(rs.key);
  try {
    // release() асинхронный, но ждать его незачем: память освобождается в рантайме.
    void Promise.resolve(rs.session.release?.()).catch(() => {});
    logger.info("upscale.session_released", { session: rs.key, provider: rs.provider });
  } catch (e) {
    logger.warn("upscale.session_release_failed", {
      session: rs.key,
      error: String((e as Error).message).slice(0, 160),
    });
  }
}

/**
 * Один инференс под защитой от выгрузки: пока считаем, сессию не освобождают.
 *
 * Все session.run в движке идут через эту обёртку — иначе «Стоп» (он зовёт
 * clearSessions) мог выгрузить модель прямо во время захода ONNX.
 */
async function runGuarded<T>(rs: ReadySession, fn: () => Promise<T>): Promise<T> {
  rs.runs = (rs.runs || 0) + 1;
  try {
    return await fn();
  } finally {
    rs.runs = Math.max(0, (rs.runs || 1) - 1);
    if (rs.runs === 0 && rs.dead) disposeSession(rs);
  }
}

/**
 * Выгрузить модели из памяти (в т.ч. из видеопамяти). Раньше кэш просто
 * очищался, а сессии оставались жить: модель продолжала занимать GPU, пока
 * процесс не завершится. Если задание сейчас считает — выгрузку откладываем,
 * её выполнит runJob сразу после окончания работы.
 */
export function clearSessions(): void {
  if (activeJobs > 0) return;
  for (const rs of [...loaded.values()]) disposeSession(rs);
  // Сессии, которые ещё создаются, освободим, как только они появятся.
  for (const [key, task] of [...sessions.entries()]) {
    void task.then((rs) => disposeSession(rs)).catch(() => sessions.delete(key));
  }
}

/**
 * Конструктор Float16Array (Node 22+). Через `globalThis`, потому что lib
 * TypeScript в проекте может не знать этот тип, а рантайм его знает.
 */
type HalfArrayCtor = new (src: ArrayLike<number>) => ArrayLike<number>;
function halfCtor(): HalfArrayCtor | null {
  const c = (globalThis as unknown as { Float16Array?: HalfArrayCtor }).Float16Array;
  return typeof c === "function" ? c : null;
}

/**
 * Тип тензора из метаданных ORT: массив `{name,type}` (onnxruntime-node) или
 * словарь по имени. Пустая строка — «тип неизвестен», тогда считаем float32.
 */
export function tensorType(meta: unknown, name: string): string {
  if (Array.isArray(meta)) {
    const hit = (meta as { name?: string; type?: string }[]).find((m) => m && m.name === name);
    return String(hit?.type || "");
  }
  if (meta && typeof meta === "object") {
    const rec = meta as Record<string, { type?: string } | undefined>;
    return String(rec[name]?.type || "");
  }
  return "";
}

/**
 * Обёртка fp16-графа: ORT требует ровно тот тип тензора, что объявлен в модели.
 * Движок работает во float32, поэтому вход конвертируется в half, а выход —
 * обратно. Так fp16-экспорты (Anime4K и подобные) работают без правок вызывающего
 * кода, а сами вычисления идут в половинной точности на GPU.
 */
function wrapHalfSession(ort: OrtModule, session: OrtSession): OrtSession {
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    inputMetadata: session.inputMetadata,
    outputMetadata: session.outputMetadata,
    release: session.release ? () => session.release!() : undefined,
    async run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>> {
      const Ctor = halfCtor();
      if (!Ctor) throw new Error("float16_unsupported");
      const half: Record<string, OrtTensor> = {};
      for (const [name, t] of Object.entries(feeds)) {
        half[name] = new ort.Tensor("float16", new Ctor(t.data) as unknown as Float32Array, [
          ...t.dims,
        ]);
      }
      const res = await session.run(half);
      const out: Record<string, OrtTensor> = {};
      for (const [name, t] of Object.entries(res)) {
        out[name] = t.data instanceof Float32Array ? t : { ...t, data: new Float32Array(t.data) };
      }
      return out;
    },
  };
}

/** Размер профиля TensorRT для этого запроса (0 — первый провайдер не TensorRT). */
function trtProfileFor(pref: string, modelId: string, tile: number): number {
  const m = findModel(modelId);
  return providerOrder(pref, m)[0] === "tensorrt" ? trtProfileSize(m, tile) : 0;
}

function getSession(
  modelId: string,
  pref: string,
  threads: number,
  tile = 0,
): Promise<ReadySession> {
  // У TensorRT вход задан жёстким профилем, поэтому сессии с разными тайлами
  // несовместимы («Static dimension mismatch»): профиль — часть ключа кэша.
  const profile = trtProfileFor(pref, modelId, tile);
  const key = `${modelId}|${pref}|${threads}|${profile}`;
  const cached = sessions.get(key);
  if (cached) return cached;

  const task = (async (): Promise<ReadySession> => {
    const ort = loadOrt();
    if (!ort) throw new Error("runtime_missing");
    const m = findModel(modelId);
    if (!m) throw new Error("model_unknown");
    const file = path.join(DIRS.upscaleModels, m.file);
    if (!fs.existsSync(file)) {
      // Модель «тензорная»: ONNX убран после сборки движка (место), но граф нужен
      // ORT для старта сессии — качаем его сами, движок после этого берётся из кэша.
      if (!m.url) throw new Error("model_missing");
      logger.info("upscale.model_refetch", { model: modelId });
      await downloadModel(modelId, { force: true });
      if (!fs.existsSync(file)) throw new Error("model_missing");
    }

    let lastErr: unknown = null;
    for (const provider of providerOrder(pref, m)) {
      try {
        const session = await ort.InferenceSession.create(file, {
          executionProviders: [provider],
          graphOptimizationLevel: "all",
          // ORT иначе пишет в консоль свои INFO/WARNING (в том числе про
          // «nodes were not assigned to the preferred execution providers» —
          // это норма: shape-операции он всегда уводит на CPU). Оставляем
          // только ошибки, чтобы журнал сервера не тонул в чужом выводе.
          logSeverityLevel: 3,
          ...(threads > 0 ? { intraOpNumThreads: threads } : {}),
          // TensorRT собирает движок под GPU и кэширует его на диске: те же
          // опции, что и при сборке кнопкой, иначе кэш не переиспользуется.
          ...(provider === "tensorrt" ? trtOptions(m, tile, trtDir(profile, modelId)) : {}),
        });
        const ready: ReadySession = (() => {
          const inType = tensorType(session.inputMetadata, session.inputNames[0]);
          const outType = tensorType(session.outputMetadata, session.outputNames[0]);
          const fp16 = inType === "float16" || outType === "float16";
          if (fp16) logger.info("upscale.session_fp16", { model: modelId, provider });
          return {
            session: fp16 ? wrapHalfSession(ort, session) : session,
            provider,
            bgr: !!m.bgr,
            scale: m.scale,
            fp16,
            key,
          };
        })();
        loaded.set(key, ready);
        logger.info("upscale.session", { model: modelId, provider });
        // Движок мог появиться именно сейчас (первый прогон): отмечаем в реестре,
        // чтобы панель моделей показала «движок готов».
        if (provider === "tensorrt") registerTrtEngine(modelId, profile, trtDir(profile, modelId));
        return ready;
      } catch (e) {
        // Аппаратный провайдер может быть недоступен на этой машине — идём дальше.
        lastErr = e;
        logger.warn("upscale.session_fallback", {
          model: modelId,
          provider,
          error: String((e as Error).message).slice(0, 160),
        });
      }
    }
    throw new Error(
      `session_create_failed: ${String((lastErr as Error)?.message || lastErr).slice(0, 200)}`,
    );
  })();

  sessions.set(key, task);
  task.catch(() => sessions.delete(key));
  return task;
}

// ================== ТАЙЛИНГ (чистая математика, тестируется) ==================

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Прямоугольники тайлов с перекрытием. tile <= 0 или тайл больше картинки →
 * один тайл на всё изображение. Последний столбец/строка прижимаются к краю,
 * а дубликаты (когда шаг не делит размер) отбрасываются по ключу.
 */
export function tileRects(w: number, h: number, tile: number, overlap: number): TileRect[] {
  if (!(w > 0) || !(h > 0)) return [];
  if (!(tile > 0) || (tile >= w && tile >= h)) return [{ x: 0, y: 0, w, h }];
  const step = Math.max(1, Math.round(tile) - Math.max(0, Math.round(overlap)));
  const ys: number[] = [];
  for (let y = 0; y < h; y += step) ys.push(Math.min(y, Math.max(0, h - tile)));
  const xs: number[] = [];
  for (let x = 0; x < w; x += step) xs.push(Math.min(x, Math.max(0, w - tile)));

  const rects: TileRect[] = [];
  const seen = new Set<string>();
  for (const y of ys) {
    for (const x of xs) {
      const key = `${y}:${x}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rects.push({ x, y, w: Math.min(tile, w - x), h: Math.min(tile, h - y) });
    }
  }
  return rects;
}

// ================== НОРМАЛИЗАЦИЯ ПАРАМЕТРОВ ==================

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
  const ceiling = Math.min(
    AUTO_BATCH_MAX,
    o.maxBatch && o.maxBatch > 1 ? Math.min(o.maxBatch, BATCH_MAX) : AUTO_BATCH_MAX,
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

function clamp(n: number, a: number, b: number): number {
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : a;
}

/**
 * Флаг из multipart-поля: UI присылает «1»/«true»/true, а `undefined` значит
 * «пользователь ничего не выбирал» — тогда берём значение по умолчанию.
 */
function toBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  return v === true || v === 1 || v === "1" || v === "true" || v === "on";
}

/**
 * Что реально умеет текущая сборка ffmpeg: методы аппаратного декодирования и
 * выбранные кодировщики по кодекам. Нужно панели настроек, чтобы показать
 * «NVENC»/«SVT-AV1» вместо обещания ускорения, которого нет.
 */
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
function runCapture(cmd: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    trackProc(currentJobId, "capture", proc);
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
const MAX_OUT_PX = 240_000_000;

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
async function decodeRgb(
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
async function encodeRgb(o: {
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
function normTile(
  src: Uint8Array,
  srcW: number,
  x: number,
  y: number,
  tw: number,
  th: number,
  bgr: boolean,
): Float32Array {
  const out = new Float32Array(tw * th * 3);
  const plane = tw * th;
  const rOff = bgr ? 2 : 0;
  const bOff = bgr ? 0 : 2;
  for (let j = 0; j < th; j++) {
    const sRow = ((y + j) * srcW + x) * 3;
    const dRow = j * tw;
    for (let i = 0; i < tw; i++) {
      const s = sRow + i * 3;
      const d = dRow + i;
      out[d] = src[s + rOff] / 255;
      out[plane + d] = src[s + 1] / 255;
      out[plane * 2 + d] = src[s + bOff] / 255;
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Округлить размер вверх до кратного `a` (требование графа: CUGAN ждёт чётные). */
export function alignUp(v: number, a: number): number {
  const step = Math.max(1, Math.round(a) || 1);
  return step <= 1 ? v : Math.ceil(v / step) * step;
}

/** Выравнивание входа модели из каталога (`align`): 1 — требование не задано. */
export function modelAlign(m: ManifestModel | null | undefined): number {
  const v = Math.round(Number(m?.align ?? 0));
  return Number.isFinite(v) && v >= 2 && v <= 64 ? v : 1;
}

/**
 * Тайл во Float32-плоскость с выравниванием размера.
 *
 * Часть графов (Real-CUGAN: внутри UNet1 есть down/up-семплинг) принимает только
 * размеры, кратные двум. Пользовательский тайл и последний тайл кадра могут быть
 * любого размера, поэтому недостающие пиксели добираются повтором крайнего
 * столбца/строки, а при вклейке обрезаются (blendTile читает реальный размер).
 */
function normTilePad(
  src: Uint8Array,
  srcW: number,
  x: number,
  y: number,
  tw: number,
  th: number,
  aw: number,
  ah: number,
  bgr: boolean,
): Float32Array {
  if (aw === tw && ah === th) return normTile(src, srcW, x, y, tw, th, bgr);
  const out = new Float32Array(aw * ah * 3);
  const plane = aw * ah;
  const rOff = bgr ? 2 : 0;
  const bOff = bgr ? 0 : 2;
  for (let j = 0; j < ah; j++) {
    const sRow = ((y + (j < th ? j : th - 1)) * srcW + x) * 3;
    const dRow = j * aw;
    for (let i = 0; i < aw; i++) {
      const si = i < tw ? i : tw - 1;
      const s = sRow + si * 3;
      const d = dRow + i;
      out[d] = src[s + rOff] / 255;
      out[plane + d] = src[s + 1] / 255;
      out[plane * 2 + d] = src[s + bOff] / 255;
    }
  }
  return out;
}

/**
 * Вклейка обработанного тайла в общий буфер.
 *
 * Прозрачность (fade-in) включается только на левой/верхней кромке тайла, если
 * у него есть сосед слева/сверху: тайлы идут слева-направо, сверху-вниз, и
 * каждый следующий плавно «въезжает» на место предыдущего в зоне перекрытия.
 * Кромки всего изображения пишутся сразу на 100% — иначе были бы чёрные полосы.
 *
 * `srcStride` — ширина плоскости в буфере модели: если тайл выравнивался под
 * требование графа (`align`), данные лежат с другой шириной строки, а вклеиваем
 * мы только реальные `tw × th` пикселей.
 */
function blendTile(
  dst: Uint8Array,
  dstW: number,
  dstH: number,
  data: Float32Array,
  tw: number,
  th: number,
  scale: number,
  dstX: number,
  dstY: number,
  fadePx: number,
  bgr: boolean,
  srcStride?: number,
): void {
  const ow = tw * scale;
  const oh = th * scale;
  const stride = srcStride && srcStride > 0 ? srcStride : ow;
  const plane = stride * oh;
  const f = Math.max(0, Math.round(fadePx * scale));
  const rP = bgr ? 2 : 0;
  const bP = bgr ? 0 : 2;

  for (let j = 0; j < oh; j++) {
    const gy = dstY + j;
    if (gy < 0 || gy >= dstH) continue;
    const wy = dstY > 0 && f > 0 ? Math.min(1, j / f) : 1;
    for (let i = 0; i < ow; i++) {
      const gx = dstX + i;
      if (gx < 0 || gx >= dstW) continue;
      const wx = dstX > 0 && f > 0 ? Math.min(1, i / f) : 1;
      const a = wx * wy;
      if (a <= 0) continue; // пиксель уже записан предыдущим тайлом — не трогаем
      const s = j * stride + i;
      const d = (gy * dstW + gx) * 3;
      dst[d] = Math.round(dst[d] * (1 - a) + clamp01(data[rP * plane + s]) * 255 * a);
      dst[d + 1] = Math.round(dst[d + 1] * (1 - a) + clamp01(data[plane + s]) * 255 * a);
      dst[d + 2] = Math.round(dst[d + 2] * (1 - a) + clamp01(data[bP * plane + s]) * 255 * a);
    }
  }
}

/** Один прогон сессии: собрать feeds, вызвать run, отдать плоскость выхода. */
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
function mixPlanes(a: Float32Array, b: Float32Array, w: number, len: number): Float32Array {
  const out = new Float32Array(len);
  const k = clamp01(w);
  for (let i = 0; i < len; i++) out[i] = a[i] * (1 - k) + (b[i] || 0) * k;
  return out;
}

// ============ ИНТЕРПОЛЯЦИЯ КАДРОВ МОДЕЛЬЮ (RIFE / CAIN / IFRNet) ============
// Модели интерполяции отличаются схемой входов, а не смыслом: на вход две
// соседние рамки (у RIFE — ещё и момент времени между ними), на выходе — кадр
// между ними. Схему задаёт манифест (`inputSig`), иначе определяем по именам
// входов уже созданной ONNX-сессии.

export type InterpSig = "rife-pair-timestep" | "cain-concat" | "ifrnet-pair";

/** Известные схемы: набор характерных имён входов → сигнатура. */
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
const batchUnsupported = new Set<string>();

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
function toProcessed(r: { data: Uint8Array; width: number; height: number }): ProcessedFrame {
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

let mpxPerSec = 0;

/** Запомнить измеренную скорость: выходные пиксели и время их обработки. */
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

export interface BenchEntry {
  model: string;
  /** Провайдер, на котором реально считалось (cuda/tensorrt/dml/cpu). */
  provider: string;
  /** Тайл замера: один тайл — один вход графа. */
  tile: number;
  /** Пачка кадров замера (замер времени всегда одиночный = 1). */
  batch: number;
  /**
   * Сколько кадров модель принимает за один проход — проверено на этой машине:
   * 1 — граф ждёт ровно один кадр, 0 — проверить не удалось, больше 1 — предел
   * пачки. В каталоге этот факт есть не у всех моделей (там как раз «пачка ?»),
   * поэтому замер выясняет его сам.
   */
  batchMax: number;
  /** Лучшее время одного тайла, мс. */
  ms: number;
  /** Оценка полного эталонного кадра (все тайлы), мс. */
  frameMs: number;
  /** Кадров эталонного размера в секунду — по числу тайлов. */
  fps: number;
  /** Тайлов в эталонном кадре. */
  tiles: number;
  /** Сколько прогонов измерили (без прогрева). */
  runs: number;
  /** Движок TensorRT, если считалось на нём. */
  engine: string;
  /** Когда замер сделан (мс). */
  when: number;
}

/** Замеры этой машины: модель → список (свой на каждый провайдер и тайл). */
export type BenchResults = Record<string, BenchEntry[]>;

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

export interface UpEstimate {
  kind: "photo" | "video";
  /** Размеры результата (после приведения к выбранному множителю). */
  outWidth: number;
  outHeight: number;
  /** Кадров исходника, которое реально обработаем (с учётом лимита). */
  inFrames: number;
  /** Кадров на выходе: с интерполяцией их больше. */
  outFrames: number;
  /** Частота кадров результата (для плавности). */
  fpsOut: number;
  /** Длительность результата, секунды (замедление растягивает её). */
  durationSec: number;
  /** Итоговый множитель замедления (1 — без замедления). */
  slowMotion: number;
  /** Мегапиксели суммарной работы — по ним считается время. */
  totalMegapixels: number;
  /** Ожидаемое время обработки, секунды; null — ещё нет измерений на машине. */
  etaSec: number | null;
  /** Что помешает запуску или о чём стоит предупредить (ключи i18n up.est_*). */
  warnings: string[];
}

/**
 * Оценка будущего задания по параметрам и пробе файла: размеры, число кадров,
 * частота результата и время. Ничего не запускает и не трогает файлы —
 * поэтому безопасна для вызова на каждое изменение настроек в UI.
 */
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
  currentJobId = job.id;
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
    currentJobId = "";
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
interface TrackedProc {
  proc: ChildProcess;
  kind: string;
  pid: number;
  /** Процесс уже получал сигнал: повторный заход сторожа добивает принудительно. */
  killed: boolean;
}

/**
 * Регистрация процесса за заданием. Экспортируется, чтобы это можно было
 * проверить тестом (на реальном долгоживущем процессе): сам движок зовёт её из
 * пайплайна (`onProc`) и из фото-пути (`runCapture`).
 */
export function trackJobProc(jobId: string, kind: string, proc: ChildProcess | null): void {
  trackProc(jobId, kind, proc);
}

/**
 * Погасить процесс — по возможности вместе с потомками.
 *
 * `child.kill()` на Windows снимает только сам ffmpeg: если тот поднял дочерний
 * процесс (или запущен через shim-обёртку), потомок остаётся жить, и «Стоп»
 * выглядит сломанным. Поэтому сначала `taskkill /PID <pid> /T /F` (дерево
 * процессов), а обычный `kill()` — как страховка, если taskkill недоступен.
 */
function terminateProc(entry: TrackedProc): boolean {
  if (!entry.pid) return false;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(entry.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          entry.proc.kill();
        } catch {
          /* процесс уже мёртв */
        }
      });
    } catch {
      /* taskkill не найден — ниже обычный kill */
    }
  }
  try {
    if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
    return true;
  } catch {
    return false;
  }
}

const jobProcs = new Map<string, Map<number, TrackedProc>>();

/** Сторож остановки: через сколько миллисекунд проверяем, что процессы умерли. */
const STOP_SWEEP_MS = 1500;

/**
 * Задание, которое считается прямо сейчас.
 *
 * Очередь (`createQueue`) запускает по одному заданию, поэтому текущий id можно
 * держать в модуле: так его видят вспомогательные ffmpeg-процессы (фото-путь,
 * пробы), куда объект задания не передать.
 */
let currentJobId = "";

function trackProc(jobId: string, kind: string, proc: ChildProcess | null): void {
  // null приходит из пайплайна после закрытия: запись и так уйдёт по `close`.
  if (!proc || !jobId) return;
  let set = jobProcs.get(jobId);
  if (!set) {
    set = new Map();
    jobProcs.set(jobId, set);
  }
  const pid = proc.pid || 0;
  set.set(pid, { proc, kind, pid, killed: false });
  proc.once("close", () => {
    const cur = jobProcs.get(jobId);
    cur?.delete(pid);
    if (cur && cur.size === 0) jobProcs.delete(jobId);
  });
}

/** Погасить все ffmpeg-процессы задания. Возвращает, сколько процессов убито. */
export function killJobProcs(id: string): number {
  const set = jobProcs.get(id);
  if (!set) return 0;
  let killed = 0;
  for (const entry of [...set.values()]) {
    if (entry.proc.exitCode !== null) {
      set.delete(entry.pid);
      continue;
    }
    if (terminateProc(entry)) {
      entry.killed = true;
      killed++;
    }
  }
  if (killed) logger.action("upscale.procs_killed", { id, killed });
  if (set.size === 0) jobProcs.delete(id);
  return killed;
}

/** Сколько процессов задания ещё живо (для диагностики и сторожевого таймера). */
export function aliveJobProcs(id: string): number {
  const set = jobProcs.get(id);
  if (!set) return 0;
  let alive = 0;
  for (const entry of [...set.values()]) {
    if (entry.proc.exitCode === null) alive++;
    else set.delete(entry.pid);
  }
  if (set.size === 0) jobProcs.delete(id);
  return alive;
}

/**
 * Сторож остановки: если после «Стопа» процессы ещё живы, предупреждаем и
 * добиваем повторно.
 *
 * Без него «Стоп» иногда выглядел как «не всегда закрывает процессы»: сигнал
 * уходил, но процесс мог его пережить — или не получить вовсе (гонка с ленивым
 * стартом энкодера, shim вместо ffmpeg.exe, слишком поздняя проверка флага).
 */
export function sweepJobProcs(id: string, delayMs = STOP_SWEEP_MS): number {
  const left = aliveJobProcs(id);
  if (!left) return 0;
  if (delayMs <= 0) return killJobProcs(id);
  const timer = setTimeout(() => {
    const again = aliveJobProcs(id);
    if (!again) return;
    logger.warn("upscale.procs_alive", { id, alive: again, after: delayMs });
    killJobProcs(id);
  }, delayMs);
  timer.unref?.();
  return left;
}

/** Останавливает обработку всех незавершённых заданий (текущее — на месте). */
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
export function extractZipEntries(zip: Buffer): { name: string; data: Buffer }[] {
  // Концевая запись каталога (EOCD): ищем в хвосте — комментарий к архиву может
  // занимать до 64 КиБ.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 66000); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip_invalid");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("zip_invalid");
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const rawSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localAt = zip.readUInt32LE(p + 42);
    const full = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (full.endsWith("/")) continue; // директория
    // Имя — только basename: путь из архива не должен уводить запись наружу.
    const name = full.split(/[\\/]/).pop() || "";
    if (!name || name === "." || name === ".." || seen.has(name)) throw new Error("zip_invalid");
    if (compSize === 0xffffffff || localAt === 0xffffffff) throw new Error("zip_invalid");
    if (zip.readUInt32LE(localAt) !== 0x04034b50) throw new Error("zip_invalid");
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const data = zip.subarray(dataAt, dataAt + compSize);
    const raw = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!raw) throw new Error("zip_invalid");
    if (rawSize && raw.length !== rawSize) throw new Error("zip_invalid");
    seen.add(name);
    out.push({ name, data: raw });
  }
  return out;
}

/**
 * Достать ONNX-модель из zip-архива (так раздают модели Qualcomm). Если модель
 * идёт с внешними весами (`*.data`), для работы нужны и они — см. installModel.
 */
export function extractOnnxFromZip(zip: Buffer): Buffer {
  const onnx = extractZipEntries(zip).find((e) => /\.onnx$/i.test(e.name));
  if (!onnx) throw new Error("zip_no_onnx");
  return onnx.data;
}

/**
 * Загрузка модели из UI (POST /models/download): URLs берём из манифеста, файл
 * пишем в storage/models/upscale через .part и переименовываем после успеха.
 * Если ссылка ведёт на .zip (так раздаёт Qualcomm), внутри ищем `.onnx`, а
 * sha256 считаем по самой модели, а не по архиву.
 */
export async function downloadModel(
  id: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; path: string; sizeMb: number }> {
  const m = findModel(id);
  if (!m) throw new Error("model_unknown");
  if (!m.url) throw new Error("model_no_url");
  const dest = path.join(DIRS.upscaleModels, m.file);
  const running = downloads.get(id);
  if (running?.state === "working") throw new Error("download_busy");
  if (fs.existsSync(dest) && !opts.force) {
    return { ok: true, path: dest, sizeMb: Math.round(fs.statSync(dest).size / 1048576) };
  }
  const st = { got: 0, total: 0, state: "working", error: "" };
  downloads.set(id, st);
  try {
    const res = await fetch(m.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = res.body;
    if (!body) throw new Error("no_body");
    st.total = Number(res.headers.get("content-length") || 0);
    const part = dest + ".part";
    const out = fs.createWriteStream(part);
    // Ссылка на архив (Qualcomm) — внутри .onnx: хеш считаем по распакованной
    // модели, поэтому в потоке его не считаем.
    const zipped = /\.zip($|[?#])/i.test(m.url);
    // sha256 из манифеста: без проверки битый или подменённый файл выглядел бы
    // как «модель скачана» и падал бы позже, в середине задания.
    const hash = m.sha256 && !zipped ? crypto.createHash("sha256") : null;
    let got = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        st.got = got;
        if (hash) hash.update(value);
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((r) => out.once("drain", () => r()));
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    if (hash && hash.digest("hex") !== m.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error("sha256_mismatch");
    }
    if (zipped) {
      let entries: { name: string; data: Buffer }[];
      try {
        entries = extractZipEntries(fs.readFileSync(part));
      } catch (e) {
        fs.rmSync(part, { force: true });
        const msg = String((e as Error).message || e);
        throw new Error(msg === "zip_no_onnx" ? "zip_no_onnx" : "zip_invalid", { cause: e });
      }
      fs.rmSync(part, { force: true });
      const onnx = entries.find((e) => /\.onnx$/i.test(e.name));
      if (!onnx) throw new Error("zip_no_onnx");
      // Граф кладём под именем из манифеста, остальные файлы (внешние веса
      // `*.data`, метаданные) — рядом: ONNX Runtime ищет их по той же папке.
      // Прошлый набор файлов убираем: у другой версии модели могут быть свои веса.
      const oldIndex = dest + ".files.json";
      try {
        const old = fs.existsSync(oldIndex)
          ? (JSON.parse(fs.readFileSync(oldIndex, "utf8")) as unknown)
          : [];
        if (Array.isArray(old)) {
          for (const f of old) {
            if (typeof f === "string" && path.basename(f) === f) {
              fs.rmSync(path.join(DIRS.upscaleModels, f), { force: true });
            }
          }
        }
      } catch {
        /* испорченный индекс не мешает установке: он будет перезаписан */
      }
      const written: string[] = [];
      got = 0;
      for (const e of entries) {
        const name = /\.onnx$/i.test(e.name) ? m.file : e.name;
        if (written.includes(name)) continue;
        const target = path.join(DIRS.upscaleModels, name);
        fs.writeFileSync(target + ".tmp", e.data);
        fs.renameSync(target + ".tmp", target);
        written.push(name);
        got += e.data.length;
      }
      // Индекс файлов модели: по нему «Удалить» уберёт и веса, а не только граф.
      fs.writeFileSync(dest + ".files.json", JSON.stringify(written) + "\n", "utf8");
    } else {
      fs.renameSync(part, dest);
    }
    clearSessions(); // новая модель — старая сессия ни к чему
    st.state = "done";
    logger.action("upscale.model_downloaded", { id, sizeMb: +(got / 1048576).toFixed(1) });
    return { ok: true, path: dest, sizeMb: +(got / 1048576).toFixed(1) };
  } catch (e) {
    st.state = "error";
    st.error = String((e as Error).message || e).slice(0, 200);
    throw e;
  }
}

export { jobs };
