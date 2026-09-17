"use strict";

/**
 * Разделение говорящих (speaker diarization) через sherpa-onnx.
 *
 * Зачем: двухдорожечный режим знает только «эфир = лектор, микрофон = аудитория»,
 * а внутри дорожки говорящие не разделены — на семинаре не понять, кто из
 * студентов отвечал. Sherpa кластеризует голоса и даёт сегменты вида
 * «0.318 -- 6.865 speaker_00», которые мы привязываем к чанкам расшифровки.
 *
 * Состав пакета (всё качается в storage/diarize):
 *   • bin — oficial prebuilt Windows x64 (shared, БЕЗ TTS: 19 МБ вместо 90+).
 *     Внутри уже лежат onnxruntime.dll и onnxruntime_providers_shared.dll, поэтому
 *     exe запускается из своей папки без настройки PATH;
 *   • seg — pyannote segmentation 3.0 (нарезка речи на однородные участки);
 *   • emb — speaker embedding CAM++ (VoxCeleb) — «отпечаток» голоса (28 МБ).
 *
 * Провайдер счёта — CPU: сборка несёт CPU-вариант onnxruntime (для CUDA нужен
 * другой архив sherpa, ~570 МБ). Скорость достаточная: на живом прогоне
 * 57 секунд аудио обработались за 4.8 с (RTF 0.084) при 4 потоках.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import config from "./config";
import { stmts } from "./db";
import type { Row } from "./db";
import settings from "./settings";
import logger from "./logger";
import { downloadToFile } from "./download";
import { createSetupTask } from "./setupTask";
import type { SetupTaskState } from "./setupTask";

const { DIRS } = config;

/** Пакет диаризации: архив sherpa или одиночная .onnx-модель. */
interface PackageInfo {
  id: string;
  kind: "archive" | "file";
  sizeMb: number;
  url: string;
  file: string;
  dir: string;
}

/** Что нашли на диске: пути к бинарнику и моделям (null — пакет не установлен). */
interface Installed {
  bin: string | null;
  seg: string | null;
  emb: string | null;
  ready: boolean;
}

/** Настройки диаризации для панели (с границами ползунков). */
export interface DiarizeSettings {
  enabled: boolean;
  threshold: number;
  speakers: number;
  track: string;
  limits: { threshold: number[]; speakers: number[] };
  installed: Installed;
  task: SetupTaskState;
}

/** Патч настроек из UI: значения приходят какими угодно, приводим у себя. */
export interface DiarizePatch {
  enabled?: unknown;
  threshold?: unknown;
  speakers?: unknown;
  track?: unknown;
}

/** Сегмент sherpa: «0.318 -- 6.865 speaker_00» (секунды, номер кластера). */
export interface DiarizeSegment {
  start: number;
  end: number;
  speaker: number;
}

/** Состояние прогона диаризации одной сессии (опрашивается UI). */
export interface DiarizeRunState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
  tracks: string[];
  speakers: number;
  at: number;
}

/** Дорожка для прогона: имя (sys/mic) и найденный fail-safe WAV. */
interface DiarizeTrack {
  track: string;
  path: string;
}

/** Ответ панели: пакеты, готовность движка и текущая задача установки. */
export interface DiarizeSetupInfo {
  ready: boolean;
  engine: {
    bin: string | null;
    seg: string | null;
    emb: string | null;
    version: string;
    dir: string;
  };
  packages: { id: string; sizeMb: number; dir: string; installed: boolean }[];
  task: SetupTaskState;
  settings: DiarizeSettings;
}

/** Итог привязки говорящего к чанку: кто доминировал и с какой долей. */
interface SpeakerPick {
  speaker: number | null;
  ratio: number;
}

/** Что берём из настроек лектория (значения приводит сам модуль). */
interface LectureConfig {
  diarizeEnabled?: unknown;
  diarizeThreshold?: unknown;
  diarizeSpeakers?: unknown;
  diarizeTrack?: unknown;
  threads?: unknown;
}

/* ------------------------- Пути ------------------------- */

const SHERPA_DIR = path.join(DIRS.storage, "diarize");
const DL_DIR = path.join(SHERPA_DIR, "_dl");
const BIN_DIR = path.join(SHERPA_DIR, "bin");
const SEG_DIR = path.join(SHERPA_DIR, "seg");
const EMB_DIR = path.join(SHERPA_DIR, "emb");

/** Версия движка. Держать в синхроне с каталогом пакетов ниже. */
const TAG = "v1.13.8";
const REL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${TAG}`;

/** Имена тегов апстрима. «recongition» — опечатка в репозитории sherpa, не наша. */
const SEG_TAG = "speaker-segmentation-models";
const EMB_TAG = "speaker-recongition-models";
/**
 * Модель отпечатка голоса: CAM++ (обучена на VoxCeleb).
 *
 * Почему не 3D-Speaker (zh), которую рекомендует документация sherpa: на её
 * собственных тестовых файлах она сильно ДРОБИТ голоса. Измерения (число
 * кластеров при пороге 0.5; истина — 4 / 2 / 2 говорящих в трёх файлах):
 *   3D-Speaker zh: 7 | 2 | 4      CAM++: 4 | 2 | 3
 * при пороге 0.7:  5 | 2 | 4             3 | 2 | 3
 * Лишние кластеры = выдуманные люди в ленте («Аудитория 7»), поэтому CAM++ и
 * меньше (28 против 38 МБ), и честнее. Универсально «идеального» порога нет —
 * поэтому порог и точное число говорящих остаются в настройках панели.
 */
const EMB_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const EXE_NAME = "sherpa-onnx-offline-speaker-diarization.exe";

/**
 * Пакеты диаризации. archive — .tar.bz2 (распаковываем системным tar.exe),
 * file — одиночный .onnx. sizeMb — ориентир для UI (фактический вес после
 * установки показывает setupInfo).
 */
const PACKAGES: PackageInfo[] = [
  {
    id: "bin",
    kind: "archive",
    sizeMb: 19,
    url: `${REL}/sherpa-onnx-${TAG}-win-x64-shared-MD-Release-no-tts.tar.bz2`,
    file: "sherpa-bin.tar.bz2",
    dir: BIN_DIR,
  },
  {
    id: "seg",
    kind: "archive",
    sizeMb: 7,
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SEG_TAG}/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    file: "sherpa-seg.tar.bz2",
    dir: SEG_DIR,
  },
  {
    id: "emb",
    kind: "file",
    sizeMb: 28,
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${EMB_TAG}/${EMB_FILE}`,
    file: EMB_FILE,
    dir: EMB_DIR,
  },
];

function cfg(): LectureConfig {
  return settings.get("lecture") as LectureConfig;
}

/* ------------------------- Поиск установленного ------------------------- */

/** Рекурсивный поиск файла по имени (архив sherpa раскладывает exe глубоко). */
function findFile(dir: string, re: RegExp, depth = 4): string | null {
  if (depth < 0) return null;
  let list: fs.Dirent[];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, re, depth - 1);
      if (r) return r;
    } else if (re.test(e.name)) return p;
  }
  return null;
}

function binPath(): string | null {
  return findFile(BIN_DIR, new RegExp(`^${EXE_NAME}$`, "i"));
}
function segPath(): string | null {
  return findFile(SEG_DIR, /^model\.onnx$/i);
}
/** Отпечаток голоса: сначала ждём CAM++, иначе — любой .onnx в каталоге. */
function embPath(): string | null {
  return findFile(EMB_DIR, new RegExp(`^${EMB_FILE}$`, "i")) || findFile(EMB_DIR, /\.onnx$/i);
}

/** Что установлено и можно ли запускать диаризацию. */
function installed(): Installed {
  const bin = binPath(),
    seg = segPath(),
    emb = embPath();
  return { bin, seg, emb, ready: !!(bin && seg && emb) };
}
/* ------------------------- Задача установки (прогресс в UI) -------------------------
 * Одна задача за раз — машина состояния общая с движком распознавания
 * (server/ts/setupTask.ts), иначе два параллельных скачивания писали бы прогресс
 * в одно место и «дёргали» полоску.
 */
const setup = createSetupTask("diarize");
const task = setup.state;
const taskSnapshot = () => setup.snapshot();
const resetTask = (kind: string, id: string | null) => setup.reset(kind, id);
const failTask = (e: unknown) => setup.fail(e);
const doneTask = () => setup.done();
const cancelTask = () => setup.cancel();

/** Скачивание с прогрессом (общий модуль server/ts/download.ts). */
async function downloadTo(
  url: string,
  destFile: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<number> {
  return downloadToFile(url, destFile, {
    userAgent: "MoonApp/1.0 (+sherpa-onnx diarization)",
    timeoutMs,
    shouldCancel: () => setup.shouldCancel(),
    onProgress: ({ total, received }) => setup.setDownloadProgress(received, total),
  });
}

/**
 * Распаковка .tar.bz2 системным tar.exe (bsdtar входит в Windows 10+).
 * Отдельная зависимость не нужна, а adm-zip работать с bz2 не умеет.
 */
function extractTarBz2(archive: string, destDir: string): Promise<boolean> {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise<boolean>((resolve, reject) => {
    const proc = spawn("tar.exe", ["-xjf", archive, "-C", destDir], { windowsHide: true });
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d;
    });
    proc.on("error", () => reject(new Error("tar_missing")));
    proc.on("close", (code) => {
      // bsdtar пишет в stderr и при успехе (предупреждения о путях) — важен код.
      if (code === 0) resolve(true);
      else reject(new Error(`extract_failed_${code}: ${String(err).slice(-300)}`));
    });
  });
}

/** Установить один пакет: скачать → распаковать (если архив) → убрать архив. */
async function installPackage(pkg: PackageInfo): Promise<void> {
  const archive = pkg.kind === "archive";
  const dest = path.join(DL_DIR, pkg.file);
  resetTask("package", pkg.id);
  try {
    await downloadTo(pkg.url, dest);
    if (archive) {
      task.phase = "extract";
      // Старое дерево убираем: иначе после обновления версии рядом лежала бы
      // вторая копия exe, и «какую запускаем» зависело бы от порядка обхода.
      fs.rmSync(pkg.dir, { recursive: true, force: true });
      await extractTarBz2(dest, pkg.dir);
      fs.rmSync(dest, { force: true });
    } else {
      fs.mkdirSync(pkg.dir, { recursive: true });
      fs.rmSync(path.join(pkg.dir, pkg.file), { force: true });
      fs.renameSync(dest, path.join(pkg.dir, pkg.file));
    }
    doneTask();
    logger.action("diarize.install", { id: pkg.id, sizeMb: pkg.sizeMb });
  } catch (e) {
    failTask(e);
    throw e;
  }
} /* ------------------------- Настройки и состояние ------------------------- */

/** Настройки диаризации для панели (с границами, чтобы UI не выдумывал их сам). */
function diarizeSettings(): DiarizeSettings {
  const c = cfg();
  return {
    enabled: c.diarizeEnabled === true,
    threshold: Number(c.diarizeThreshold ?? 0.5),
    speakers: Number(c.diarizeSpeakers ?? -1),
    track: ["auto", "sys", "mic"].includes(String(c.diarizeTrack))
      ? String(c.diarizeTrack)
      : "auto",
    limits: { threshold: [0.3, 0.9], speakers: [-1, 12] },
    installed: installed(),
    task: taskSnapshot(),
  };
}

/** Сохранить настройки диаризации (частично). */
function setDiarizeSettings(patch: DiarizePatch = {}): DiarizeSettings {
  const next: Record<string, unknown> = {};
  const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const c = cfg();
  if (patch.enabled !== undefined) next.diarizeEnabled = !!patch.enabled;
  if (patch.threshold !== undefined)
    next.diarizeThreshold = num(patch.threshold, 0.3, 0.9, Number(c.diarizeThreshold ?? 0.5));
  if (patch.speakers !== undefined)
    next.diarizeSpeakers = Math.round(num(patch.speakers, -1, 12, -1));
  if (patch.track !== undefined) {
    const t = String(patch.track || "auto");
    if (!["auto", "sys", "mic"].includes(t)) throw new Error("diarize_track_unknown: " + t);
    next.diarizeTrack = t;
  }
  if (Object.keys(next).length) settings.set({ lecture: next });
  logger.action("diarize.settings", next);
  return diarizeSettings();
}

/** Пакеты + установленное + текущая задача (один ответ на все действия панели). */
function setupInfo(): DiarizeSetupInfo {
  const inst = installed();
  return {
    ready: inst.ready,
    engine: { bin: inst.bin, seg: inst.seg, emb: inst.emb, version: TAG, dir: SHERPA_DIR },
    packages: PACKAGES.map((p) => ({
      id: p.id,
      sizeMb: p.sizeMb,
      dir: p.dir,
      installed: p.id === "bin" ? !!inst.bin : p.id === "seg" ? !!inst.seg : !!inst.emb,
    })),
    task: taskSnapshot(),
    settings: diarizeSettings(),
  };
}

/* ------------------------- Разбор вывода sherpa -------------------------
 * Живой прогон (sherpa 1.13.8) печатает в stdout строки вида
 *   «0.318 -- 6.865 speaker_00»
 * а прогресс — в stderr («progress 96.10%»). Парсер терпим к ведущим пробелам
 * и к формату без секунд (тогда строка просто игнорируется).
 */

function parseSegments(text: unknown): DiarizeSegment[] {
  const out: DiarizeSegment[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = /^\s*([\d.]+)\s*--\s*([\d.]+)\s+speaker_(\d+)\s*$/.exec(raw);
    if (!m) continue;
    const start = Number(m[1]),
      end = Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start, end, speaker: Number(m[3]) });
  }
  return out;
}

/** Прогресс из stderr sherpa («progress 42.50%») — берём ПОСЛЕДНЮЮ строку:
    в буфере stderr их накапливается много, а актуален самый свежий процент. */
function parseProgress(text: unknown): number | null {
  const all = String(text || "").match(/progress\s+([\d.]+)%/g);
  if (!all || !all.length) return null;
  const m = /progress\s+([\d.]+)%/.exec(all[all.length - 1]);
  return m ? Math.max(0, Math.min(100, Math.round(Number(m[1])))) : null;
}

/**
 * Привязать сегменты диаризации к чанкам: у чанка выбирается говорящий,
 * который звучит в нём ДОЛЬШЕ всего (пересечение по времени).
 *
 * Почему по пересечению, а не «по началу»: чанк VAD — это 7..18 секунд, внутри
 * которых вопрос студента и ответ лектора могут стоять рядом; «по началу» отдал
 * бы весь чанк одному говорящему и потерял второго.
 */
function assignSpeakers(
  chunks: Row[] | null | undefined,
  segments: DiarizeSegment[] | null | undefined,
): Map<number, SpeakerPick> {
  const list = (chunks || []).map((c) => ({
    id: c.id,
    start: Number(c.start_ms) || 0,
    end: Number(c.end_ms) || 0,
  }));
  const stats = new Map<number, Map<number, number>>(); // chunkId → Map(speaker → ms)
  for (const c of list) {
    const per = new Map<number, number>();
    for (const s of segments || []) {
      const sMs = s.start * 1000,
        eMs = s.end * 1000;
      const overlap = Math.min(c.end, eMs) - Math.max(c.start, sMs);
      if (overlap <= 0) continue;
      per.set(s.speaker, (per.get(s.speaker) || 0) + overlap);
    }
    stats.set(c.id, per);
  }
  const result = new Map<number, SpeakerPick>();
  for (const [chunkId, per] of stats) {
    if (!per.size) continue;
    let best: number | null = null,
      bestMs = 0,
      total = 0;
    for (const [sp, ms] of per) {
      total += ms;
      if (ms > bestMs) {
        best = sp;
        bestMs = ms;
      }
    }
    // Уверенность: доля доминирующего говорящего. Ниже 55% — в чанке явно
    // звучали двое, и честнее показать «?», чем приписать реплику не тому.
    result.set(chunkId, { speaker: best, ratio: total ? bestMs / total : 0 });
  }
  return result;
} /* ------------------------- Прогон ------------------------- */

const runs = new Map<number, DiarizeRunState>(); // id → состояние прогона

function diarizeState(id: number): DiarizeRunState {
  return (
    runs.get(id) || {
      state: "idle",
      progress: 0,
      phase: "",
      error: "",
      tracks: [],
      speakers: 0,
      at: 0,
    }
  );
}

function sessionDir(id: number): string {
  return path.join(DIRS.lectures, String(id));
}

/** Путь к fail-safe WAV дорожки (sys — эфир, mic — микрофон). */
function rawTrackPath(lec: Row, track: string): string | null {
  const name = track === "sys" ? "raw_sys.wav" : lec.raw_file || "raw.wav";
  const p = path.join(sessionDir(lec.id), path.basename(name));
  return fs.existsSync(p) ? p : null;
}

/**
 * Запуск sherpa на одном WAV. Сегменты приходят в stdout, прогресс — в stderr,
 * поэтому читаем оба потока: «просто спиннер» на многочасовой лекции бесполезен.
 */
function runSherpa(
  exe: string,
  wav: string,
  onProgress?: (p: number) => void,
): Promise<{ segments: DiarizeSegment[] }> {
  const c = cfg();
  const threads = Math.max(1, Math.min(16, Number(c.threads) || 4));
  const clusters = Number(c.diarizeSpeakers ?? -1);
  const args = [
    `--segmentation.pyannote-model=${segPath()}`,
    `--embedding.model=${embPath()}`,
    `--segmentation.num-threads=${threads}`,
    `--embedding.num-threads=${threads}`,
    // Если число говорящих известно — оно точнее порога; иначе кластеризация
    // по порогу (меньше порог → больше говорящих).
    clusters > 0
      ? `--clustering.num-clusters=${clusters}`
      : `--clustering.cluster-threshold=${Number(c.diarizeThreshold ?? 0.5)}`,
    wav,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true });
    let out = "",
      err = "";
    proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.stderr.on("data", (d) => {
      err += d;
      const p = parseProgress(err.slice(-400));
      if (p != null) onProgress?.(p);
    });
    proc.on("error", (e) => reject(new Error("diarize_spawn_failed: " + e.message)));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`diarize_failed_${code}: ${String(err).slice(-300)}`));
      else resolve({ segments: parseSegments(out) });
    });
  });
}

/**
 * Записать говорящих в чанки сессии.
 *
 * Идентификатор говорящего — «<дорожка>_<номер>» (sys_0, mic_1): без префикса
 * номера спикеров разных дорожек схлопнулись бы (лектор и студент оба «0»).
 * Рядом кладём долю доминирующего говорящего: если в чанке звучали двое, UI и
 * экспорт честно помечают это знаком «?», а не приписывают реплику не тому.
 */
function applySpeakers(id: number, perTrack: Record<string, DiarizeSegment[]>): number {
  const chunks = stmts.chunkFor.all(id);
  const names = new Set<string>();
  let updated = 0;
  for (const [track, segments] of Object.entries(perTrack)) {
    const key = track === "sys" ? "sys" : "mic";
    const mine = chunks.filter((c) => (c.source || "mic") === key);
    const map = assignSpeakers(mine, segments);
    // ВАЖНО: sherpa нумерует кластеры произвольно (на живом прогоне встречались
    // 0, 6, 11 при четырёх говорящих). Если писать его номера как есть, подписи
    // превращаются в «Аудитория 12». Поэтому перенумеровываем по первому
    // появлению во времени: 0..N−1 — как человек и ожидает читать ленту.
    const entries: { chunkId: number; at: number; raw: number | null; ratio: number }[] = [];
    for (const [chunkId, info] of map) {
      const chunk = mine.find((c) => c.id === chunkId);
      entries.push({
        chunkId,
        at: Number(chunk?.start_ms) || 0,
        raw: info.speaker,
        ratio: info.ratio,
      });
    }
    entries.sort((a, b) => a.at - b.at);
    const order = new Map<number | null, number>(); // сырой номер sherpa → порядковый номер по времени
    for (const e of entries) {
      if (!order.has(e.raw)) order.set(e.raw, order.size);
      const n = order.get(e.raw) ?? 0;
      stmts.chunkUpdate.run(e.chunkId, {
        speaker: `${key}_${n}`,
        speakerRatio: Math.round(e.ratio * 100) / 100,
      });
      names.add(`${key}_${n}`);
      updated++;
    }
  }
  stmts.lectureUpdate.run(id, {
    diarize_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    diarize_speakers: names.size,
    diarize_tracks: Object.keys(perTrack).join(","),
  });
  logger.action("diarize.apply", { id, speakers: names.size, chunks: updated });
  return names.size;
}

/**
 * Начать диаризацию сессии. Дорожки: sys (эфир лектора) и/или mic (аудитория) —
 * по настройке diarizeTrack (auto = обе, если обе записаны).
 */
function startDiarize(id: number, opts: { track?: unknown } = {}): DiarizeRunState {
  const lec = stmts.lectureGet.get(id);
  if (!lec) throw new Error("session_not_found");
  const inst = installed();
  // ready = все три пути найдены; проверяем и bin, чтобы дальше он был строкой.
  if (!inst.ready || !inst.bin) throw new Error("diarize_not_installed");
  // Локальная копия: сужение свойства не переживает выход в асинхронную IIFE ниже.
  const bin = inst.bin;
  if (diarizeState(id).state === "working") throw new Error("diarize_busy");

  const c = cfg();
  const want = opts.track
    ? [String(opts.track)]
    : c.diarizeTrack === "auto"
      ? ["sys", "mic"]
      : [String(c.diarizeTrack || "sys")];
  const tracks: DiarizeTrack[] = [];
  for (const t of want) {
    const p = rawTrackPath(lec, t);
    if (p) tracks.push({ track: t, path: p });
  }
  if (!tracks.length) throw new Error("raw_audio_missing");

  const st: DiarizeRunState = {
    state: "working",
    progress: 0,
    phase: "diarize",
    error: "",
    tracks: tracks.map((t) => t.track),
    speakers: 0,
    at: Date.now(),
  };
  runs.set(id, st);
  logger.action("diarize.start", { id, tracks: st.tracks });

  void (async () => {
    try {
      const perTrack: Record<string, DiarizeSegment[]> = {};
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        st.phase = t.track; // какая дорожка считается прямо сейчас
        const { segments } = await runSherpa(bin, t.path, (p) => {
          st.progress = Math.round(((i + p / 100) / tracks.length) * 100);
        });
        perTrack[t.track] = segments;
        st.progress = Math.round(((i + 1) / tracks.length) * 100);
      }
      st.speakers = applySpeakers(id, perTrack);
      st.state = "done";
      logger.action("diarize.done", { id, speakers: st.speakers, tracks: st.tracks });
    } catch (e) {
      st.state = "error";
      st.error = String((e as Error)?.message || e);
      logger.error("diarize.error", { id, error: st.error });
    }
  })();
  return diarizeState(id);
} /* ------------------------- Подписи говорящих ------------------------- */

/**
 * Человеческие подписи говорящих для UI и экспорта:
 *   sys_0 → «Лектор» (если лектор один) или «Лектор 1», «Лектор 2»;
 *   mic_1 → «Аудитория 1»…
 *
 * Базовые слова приходят с клиента (labels.sys / labels.mic): сервер не знает
 * языка интерфейса, а экспорт читает человек.
 */
function speakerNames(
  id: number,
  labels: { sys?: string; mic?: string } = {},
): Record<string, string> {
  const chunks = stmts.chunkFor.all(id);
  const counts = new Map<string, number>(); // track → сколько говорящих
  for (const c of chunks) {
    const sp = String(c.speaker || "");
    if (!sp) continue;
    const [track, num] = sp.split("_");
    counts.set(track, Math.max(counts.get(track) || 0, (Number(num) || 0) + 1));
  }
  const out: Record<string, string> = {};
  for (const [track, count] of counts) {
    const base = track === "sys" ? labels.sys || "Lecturer" : labels.mic || "Audience";
    for (let i = 0; i < count; i++) {
      out[`${track}_${i}`] = count > 1 ? `${base} ${i + 1}` : base;
    }
  }
  return out;
}

/* ------------------------- Установка ------------------------- */

/** Поставить один пакет в фоне (UI опрашивает setupInfo и показывает прогресс). */
function installPackageAsync(id: string): DiarizeSetupInfo {
  if (task.state === "working") throw new Error("busy");
  const pkg = PACKAGES.find((p) => p.id === id);
  if (!pkg) throw new Error("unknown_package");
  void installPackage(pkg).catch(() => {
    /* состояние уже в task */
  });
  return setupInfo();
}

/** Поставить всё, чего не хватает (обычно это первый запуск диаризации). */
function installAllAsync(): DiarizeSetupInfo {
  if (task.state === "working") throw new Error("busy");
  const inst = installed();
  const missing = PACKAGES.filter((p) =>
    p.id === "bin" ? !inst.bin : p.id === "seg" ? !inst.seg : !inst.emb,
  );
  if (!missing.length) return setupInfo();
  void (async () => {
    for (const pkg of missing) {
      try {
        await installPackage(pkg);
      } catch {
        return; /* task уже в error */
      }
    }
  })();
  return setupInfo();
}

/** Удалить установленное (панель → «Удалить»): освобождает ~64 МБ. */
function removePackage(id: string): DiarizeSetupInfo {
  const pkg = PACKAGES.find((p) => p.id === id);
  if (!pkg) throw new Error("unknown_package");
  fs.rmSync(pkg.dir, { recursive: true, force: true });
  logger.action("diarize.remove", { id });
  return setupInfo();
}

export {
  setupInfo,
  diarizeSettings,
  setDiarizeSettings,
  installPackageAsync,
  installAllAsync,
  removePackage,
  cancelTask,
  startDiarize,
  diarizeState,
  speakerNames,
  // Чистые функции — покрыты тестами без сети и без бинарника.
  parseSegments,
  parseProgress,
  assignSpeakers,
  applySpeakers, // проверяется отдельно: нормализация номеров кластеров sherpa
  installed,
  PACKAGES,
  SHERPA_DIR,
};
