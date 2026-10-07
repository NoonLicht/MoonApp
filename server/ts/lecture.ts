/**
 * Движок Lecture Recorder: fail-safe WAV + VAD-чанки + whisper.cpp (Vulkan/CPU).
 *
 * Поток данных:
 *   фронт (getUserMedia → PCM Int16 16k) → POST /api/lecture/:id/ingest
 *     ├─ raw.wav — непрерывный нулевой fail-safe стрим прямо на диск
 *     └─ VadBufferManager → чанки 7..18 c (паддинг 150 мс) → очередь транскрипции
 *           → whisper-cli -m model -l ru --prompt "<академический словарь>"
 *
 * Zero Hallucination: в Whisper идут только чанки с речью (VAD отбраковывает
 * тишину/шум), инжектится академический initial prompt, а из результата
 * вырезаются типовые галлюцинации ("Спасибо за просмотр", "Subtitles by...").
 */
import config from "./config";
import * as whisperEngine from "./whisperEngine";
import settings from "./settings";
import path from "path";
import { stmts } from "./db";
import fs from "fs";
import logger from "./logger";
import { VadBufferManager } from "./vad";
import { maybeAutoConspectus, maybeAutoDiarize } from "./lectureConspectus";
import { transcribeFile } from "./lectureAsr";
import { recheckState } from "./lectureRecheck";
import { fmtTs } from "./lectureExport";
export { exportContent, contentDisposition } from "./lectureExport";
export {
  generateConspectus,
  conspectusState,
  conspectusSettings,
  setConspectusSettings,
  conspectusProviders,
  conspectusPresets,
  saveConspectusPreset,
  deleteConspectusPreset,
  providerModels,
  maybeAutoConspectus,
  transcriptWeight,
  conspectusStale,
  transcriptBlocks,
} from "./lectureConspectus";
export { startRecheck, recheckState } from "./lectureRecheck";
export {
  sanitizeText,
  parseSrt,
  transcribeFile,
  runWhisper,
  readChunkResult,
  transcribeViaServer,
  httpInference,
  resultFromSrtText,
} from "./lectureAsr";

const { DIRS } = config;

// Прогреваем детект GPU в фоне: engineSummary() отдаёт предупреждения вида
// «CUDA-сборка выбрана, но NVIDIA не найдена», а первый nvidia-smi занимает
// ~50 мс — не хотим ждать его в запросе статуса.
void whisperEngine.detectGpu().catch(() => {
  /* детект не критичен */
});

/* ------------------------- WAV ------------------------- */

function writeWavHeader(dataLen: any, sampleRate: any, channels: any) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate (16 bit)
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return header;
}

export function toWav(pcmInt16: any, sampleRate: any, channels = 1) {
  const header = writeWavHeader(pcmInt16.length * 2, sampleRate, channels);
  return Buffer.concat([
    header,
    Buffer.from(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.byteLength),
  ]);
}

/* ------------------------- Состояние ------------------------- */

/** Активные сессии записи: id → { vads, rawFd, rawFile, queue, ... } */
export const sessions = new Map();

export function cfg() {
  return settings.get("lecture");
}

export function sessionDir(id: any) {
  return path.join(DIRS.lectures, String(id));
}

/**
 * Поиск бинарника и модели живёт в whisperEngine: там же выбор сборки
 * (CPU/BLAS/CUDA), выбранная модель и флаги GPU. Здесь только обёртка статуса,
 * потому что engineStatus() уходит в UI вместе со статусом сессии.
 */
function engineStatus() {
  const summary = whisperEngine.engineSummary();
  // Наличие NVIDIA-устройства нужно для предупреждений в шапке; детект кэширован
  // в whisperEngine, поэтому вызов дешёвый (первый — ~50 мс на nvidia-smi).
  return {
    ...summary,
    activeSession: sessions.size > 0,
  };
}

/* ------------------------- Сессии ------------------------- */

function createSession(title: any, sampleRate: any, channels: any) {
  const lc = cfg();
  const sr = 16000; // фронт всегда отдаёт PCM 16 кГц моно (даунсэмпл на клиенте)
  const ch = channels === 2 ? 2 : 1;
  const info = stmts.lectureInsert.run((title || "Лекция").slice(0, 200), sr, ch);
  const id = Number(info.lastInsertRowid);
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const s: Record<string, any> = {
    id,
    // Дорожки записи. mic — микрофон/аудитория (raw.wav), sys — системный звук
    // онлайн-лекции (raw_sys.wav, создаётся при первом PCM с этой дорожки).
    // Две дорожки нужны, чтобы ТОЧНО знать, кто говорит: эфир = лектор,
    // микрофон = аудитория/студенты (см. двухдорожечный режим).
    tracks: new Map(),
    sampleRate: sr,
    channels: ch,
    ingestBytes: 0,
    queue: [],
    transcribing: false,
    // stopping — запись остановлена, но очередь транскрибации ещё дочитывается
    // (см. pumpQueue/stopSession). Состояние живёт, пока pending не разойдётся.
    stopping: false,
    lastError: "",
    startedAt: Date.now(),
  };
  sessions.set(id, s);
  ensureTrack(s, "mic");
  // Потоковая расшифровка (бета, см. pumpDraft): таймер живёт всегда, но при
  // выключенной настройке дальше первой проверки cfg().streaming не идёт —
  // никакого лишнего прогона Whisper, если фича не включена.
  s.draft = { mic: "", sys: "" };
  s.draftBusy = { mic: false, sys: false };
  s.draftTimer = setInterval(() => pumpDraft(id), DRAFT_INTERVAL_MS);
  const rawFile = path.join(dir, "raw.wav");
  stmts.lectureUpdate.run(id, { raw_file: path.basename(rawFile) });
  logger.action("lecture.session.start", { id, sampleRate: sr, channels: ch });
  return { id, sampleRate: sr, channels: ch, vad: vadConfig(lc), whisper: engineStatus() };
}

/**
 * Дорожка сессии: свой VAD и свой fail-safe WAV. Создаётся лениво — для
 * микрофонной записи второй файл не появляется, а для онлайн-лекции
 * «эфирная» дорожка возникает при первом PCM.
 *
 * ВАЖНО про позицию записи: fd открыт в позиции 0, поэтому fs.writeSync обязан
 * получать явный writePos — иначе первый же буфер затирает WAV-заголовок,
 * файл перестаёт быть WAV, и 22 мс аудио теряются навсегда.
 */
function ensureTrack(s: any, src: any) {
  const key = src === "sys" ? "sys" : "mic";
  const existing = s.tracks.get(key);
  if (existing) return existing;
  const file = path.join(sessionDir(s.id), key === "sys" ? "raw_sys.wav" : "raw.wav");
  fs.writeFileSync(file, writeWavHeader(0, s.sampleRate, 1));
  const track = {
    src: key,
    file,
    fd: fs.openSync(file, "r+"),
    writePos: 44,
    sampleRate: s.sampleRate,
    pcmWritten: 0,
    vad: new VadBufferManager(vadOptions(cfg(), s.sampleRate)),
  };
  s.tracks.set(key, track);
  return track;
}

/** Дорожка с наибольшим количеством аудио (основная для длительности и статуса). */
function primaryTrack(s: any) {
  const list = Array.from(s.tracks.values()) as any[];
  return list.sort((a, b) => b.pcmWritten - a.pcmWritten)[0] || null;
}

function vadConfig(c: any) {
  return {
    silenceMs: c.vadSilenceMs,
    minChunkMs: c.vadMinChunkMs,
    maxChunkMs: c.vadMaxChunkMs,
    forceSplitMs: c.vadForceSplitMs,
    padMs: c.vadPadMs,
  };
}

/**
 * Опции VAD из настроек. Порог, адаптация и анти-шум вынесены в settings.lecture
 * (панель «Аудио»), потому что «тихий микрофон» и «шум системного звука» —
 * разные болезни с разными лекарствами: гейн/выбор устройства против порога.
 */
export function vadOptions(c: any, sampleRate: any) {
  return {
    sampleRate,
    silenceMs: c.vadSilenceMs,
    minChunkMs: c.vadMinChunkMs,
    maxChunkMs: c.vadMaxChunkMs,
    forceSplitMs: c.vadForceSplitMs,
    padMs: c.vadPadMs,
    rmsThreshold: c.vadRmsThreshold,
    adaptive: c.vadAdaptive !== false,
    thresholdFactor: c.vadThresholdFactor,
    minSpeechRatio: c.vadMinSpeechRatio,
    zcrGate: c.vadZcrGate !== false,
  };
}

/** Приём PCM (Int16 LE, моно 16k). track: "mic" (микрофон/аудитория) | "sys" (эфир). */
function ingest(id: any, buf: any, track = "mic") {
  const s = sessions.get(id);
  if (!s) throw new Error("session_not_found");
  // Сессия уже останавливается: PCM не принимаем, иначе в WAV и VAD попадут
  // «хвосты» уже после финализации (файл закрыт, заголовок починен).
  if (s.stopping) throw new Error("session_stopped");
  const src = track === "sys" ? "sys" : "mic";
  s.ingestBytes += buf.length;
  // Fail-safe: непрерывный raw WAV на диск (защита от падения приложения).
  // Позиция явная (writePos) — иначе заголовок файла перезаписывался.
  const w = ensureTrack(s, src);
  fs.writeSync(w.fd, buf, 0, buf.length, w.writePos);
  w.writePos += buf.length;
  w.pcmWritten += buf.length / 2;
  // VAD-нарезка → очередь транскрипции.
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const closed = w.vad.push(pcm);
  for (const chunk of closed) enqueueChunk(id, chunk, src);
  // Пропуски VAD пишем строками с причиной и уровнем: так пользователь видит
  // «шум −44 dBFS при пороге −38», а не загадочное «отброшено VAD».
  for (const skip of w.vad.drainSkipped()) {
    stmts.chunkInsertSkipped.run(
      id,
      nextIdx(id),
      Math.round(skip.startMs),
      Math.round(skip.endMs),
      { ...skip, source: src },
    );
  }
  return {
    pending: s.queue.length,
    stats: w.vad.stats,
    vad: w.vad.metrics(),
    elapsedMs: Date.now() - s.startedAt,
    recordingSec: Math.round(w.pcmWritten / w.sampleRate),
  };
}

/** Следующий индекс чанка в сессии (учитывает и обычные чанки, и пропуски). */
export function nextIdx(id: any) {
  const chunks = stmts.chunkFor.all(id);
  return (chunks.length ? Math.max(...chunks.map((c) => Number(c.idx) || 0)) : 0) + 1;
}

/** Состояние сессии больше не нужно: снять и таймер чернового прогона, и саму запись. */
function endSession(id: any) {
  const s = sessions.get(id);
  if (s && s.draftTimer) clearInterval(s.draftTimer);
  sessions.delete(id);
}

function enqueueChunk(id: any, chunk: any, source = "mic") {
  const s = sessions.get(id);
  if (!s) return;
  // Сегмент реально закрылся — черновик по этому источнику устарел (его текст
  // «переехал» в обычный чанк ниже), стираем, чтобы UI не показывал дубль.
  if (s.draft) s.draft[source] = "";
  const dir = sessionDir(id);
  const w = s.tracks.get(source) || s.tracks.get("mic");
  const idx = nextIdx(id);
  const base = `${source === "sys" ? "sys" : "chunk"}_${String(idx).padStart(5, "0")}.wav`;
  fs.writeFileSync(path.join(dir, base), toWav(chunk.samples, w.sampleRate, 1));
  // Диагностика едет вместе с чанком: dBFS, доля речи, ZCR, порог — чтобы UI
  // мог объяснить пустой результат, не заставляя гадать о причинах.
  const info = stmts.chunkInsert.run(id, idx, chunk.startMs, chunk.endMs, base, {
    source,
    reason: chunk.reason || "",
    rmsDb: chunk.rmsDb ?? -100,
    rmsPeakDb: chunk.rmsPeakDb ?? -100,
    speechRatio: chunk.speechRatio ?? 0,
    noiseFloorDb: chunk.noiseFloorDb ?? -100,
    thresholdDb: chunk.thresholdDb ?? -100,
    zcr: chunk.zcrMean ?? 0,
  });
  s.queue.push({
    chunkId: Number(info.lastInsertRowid),
    file: base,
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    source,
  });
  pumpQueue(id);
}

/* ------------------------- Транскрипция (whisper.cpp) ------------------------- */

function pumpQueue(id: any) {
  const s = sessions.get(id);
  if (!s || s.transcribing) return;
  const item = s.queue[0];
  if (!item) {
    // Очередь пуста: если запись уже остановлена — только теперь освобождаем
    // состояние сессии. Раньше stopSession удаляла его сразу, и последние
    // чанки лекции оставались «pending» навсегда (некому было их читать).
    if (s.stopping) {
      endSession(id);
      // Умный авто-конспект: расшифровка дочитана, и если режим запуска это
      // разрешает — собираем конспект без нажатия кнопки (см. maybeAutoConspectus).
      maybeAutoConspectus(id);
      // И авто-диаризация, если пользователь её включил (по умолчанию выключена).
      maybeAutoDiarize(id);
    }
    return;
  }
  s.transcribing = true;
  transcribeChunk(id, item)
    .catch((e) => {
      if (item.chunkId)
        stmts.chunkUpdate.run(item.chunkId, {
          status: "error",
          error: String(e.message || e).slice(0, 500),
        });
      s.lastError = String(e.message || e);
      logger.error("lecture.transcribe", { id, error: s.lastError });
    })
    .finally(() => {
      s.queue.shift();
      s.transcribing = false;
      if (s.queue.length) pumpQueue(id);
      else if (s.stopping) {
        endSession(id);
        // Последний чанк дочитан — тот же «умный» авто-конспект, что и выше.
        maybeAutoConspectus(id);
        maybeAutoDiarize(id);
      }
    });
}

export async function transcribeChunk(id: any, item: any) {
  const bin = whisperEngine.findBin();
  const model = whisperEngine.findModel();
  if (!bin || !model) {
    const err = new Error(bin ? "whisper_model_missing" : "whisper_not_installed");
    if (item.chunkId) stmts.chunkUpdate.run(item.chunkId, { status: "error", error: err.message });
    throw err;
  }
  const wavPath = path.join(sessionDir(id), item.file);
  const outBase = wavPath.replace(/\.wav$/i, "");
  const result = await transcribeFile(bin, model, wavPath, outBase, {
    id,
    file: item.file,
    source: item.source,
  });
  if (item.chunkId) {
    // ВАЖНО: причина разделена. "empty" — это ответ Whisper (он не нашёл
    // речи), а не решение VAD. Раньше UI подписывал всё как «отброшено
    // VAD», и понять, что происходит с записью, было невозможно.
    stmts.chunkUpdate.run(item.chunkId, {
      text: result.text,
      status: result.text ? "done" : "empty",
      reason: result.text ? "" : "whisper_empty",
      error: "",
    });
  }
  logger.info("lecture.chunk.done", { id, file: item.file, chars: result.text.length });
  return result;
}

/* ------------------------- Потоковая расшифровка (бета) ------------------------- */

const DRAFT_INTERVAL_MS = 2200; // как часто пробуем черновой прогон незакрытого сегмента

/**
 * Черновой прогон незакрытого сегмента речи (пока пользователь не сделал паузу).
 * Опционально: включается настройкой lecture.streaming (по умолчанию выключено,
 * см. server/ts/settings.ts) — при выключенной настройке дальше первой строки
 * (дешёвый cfg()) функция не идёт, лишнего whisper-прогона нет.
 *
 * Черновик НЕ пишется в БД — это чисто оперативная строка в статусе сессии
 * (getStatus → draft.mic/draft.sys), которую фронт рисует курсивом и стирает
 * сама, как только придёт финальный чанк (см. enqueueChunk — он чистит
 * s.draft[source] в момент закрытия сегмента).
 */
function pumpDraft(id: any) {
  const s = sessions.get(id);
  if (!s || s.stopping) return;
  if (cfg().streaming !== true) return;
  for (const [key, t] of s.tracks) {
    if (s.draftBusy[key]) continue; // прошлый черновой прогон этого источника ещё не завершился
    const peek = t.vad.peek();
    if (!peek) {
      // Открытого сегмента нет (тишина/пауза) — прежний черновик неактуален.
      if (s.draft[key]) s.draft[key] = "";
      continue;
    }
    s.draftBusy[key] = true;
    draftTranscribe(id, key, peek.samples, t.sampleRate)
      .then((text) => {
        const cur = sessions.get(id);
        if (cur) cur.draft[key] = text;
      })
      .catch(() => {
        /* черновик — best effort: ошибка здесь не должна ронять запись */
      })
      .finally(() => {
        const cur = sessions.get(id);
        if (cur) cur.draftBusy[key] = false;
      });
  }
}

/**
 * Один черновой прогон: тот же движок (резидент/CLI), что и финальные чанки —
 * transcribeFile сама выбирает путь и делает откат без --prompt при пустом
 * ответе. Разница только в том, что результат никуда не пишется в БД.
 */
async function draftTranscribe(id: any, track: any, samples: any, sampleRate: any) {
  const bin = whisperEngine.findBin();
  const model = whisperEngine.findModel();
  if (!bin || !model) return "";
  const file = `_draft_${track}.wav`;
  const wavPath = path.join(sessionDir(id), file);
  fs.writeFileSync(wavPath, toWav(samples, sampleRate, 1));
  const outBase = wavPath.replace(/\.wav$/i, "");
  const result = await transcribeFile(bin, model, wavPath, outBase, { id, file, source: track });
  return result.text || "";
}

/* ------------------------- Статусы / правки ------------------------- */

function getStatus(id: any) {
  const lecture = stmts.lectureGet.get(id);
  if (!lecture) return null;
  const s = sessions.get(id);
  const main = s ? primaryTrack(s) : null;
  return {
    lecture,
    chunks: stmts.chunkFor.all(id),
    live: !!s && !s.stopping,
    queue: s ? s.queue.length : 0,
    // Останавливается, но очередь ещё дочитывается: UI показывает «Сохранение…»
    // вместо «Не записывается», иначе последние фразы выглядели потерянными.
    stopping: !!(s && s.stopping),
    transcribing: s ? s.transcribing : false,
    recordingSec:
      s && main
        ? Math.round(main.pcmWritten / main.sampleRate)
        : Math.round((lecture.duration_ms || 0) / 1000),
    vadStats: main ? main.vad.stats : null,
    // Живая диагностика: порог, шумовой пол и пропуски. Без неё «тишина/шум»
    // в транскрипте невозможно объяснить (см. панель «Аудио» на странице).
    vad: s ? vadLiveMetrics(s) : null,
    recheck: recheckState(id),
    lastError: s ? s.lastError : "",
    // Потоковая расшифровка (бета): черновой текст незакрытого сегмента по
    // дорожкам (mic/sys). null, пока сессия не идёт; "" — сегмент закрыт/тишина.
    draft: s ? s.draft : null,
    whisper: engineStatus(),
  };
}

/** Метрики VAD по всем дорожкам: mic / sys (если она есть). */
function vadLiveMetrics(s: any) {
  const out: Record<string, any> = {};
  for (const [key, t] of s.tracks) {
    out[key] = { ...t.vad.metrics(), recordingSec: Math.round(t.pcmWritten / t.sampleRate) };
  }
  return out;
}

/** Click-to-edit: правка текста чанка прямо из телепромтера. */
function updateChunkText(chunkId: any, text: any) {
  stmts.chunkUpdate.run(chunkId, { text: String(text || "").slice(0, 20000) });
  return stmts.chunkGet.get(chunkId);
}

/**
 * Зеркало заметок лекции в storage/notes (markdown-файл на каждую лекцию).
 *
 * Заметки и ИИ-конспект живут в JSON-сторе (storage/data.json), поэтому до этого
 * были видны ТОЛЬКО внутри приложения. Теперь у каждой лекции есть зеркало —
 * обычный .md файл в той же папке, где лежат остальные заметки
 * (server/notes-fs.js → storage/notes/), и он обновляется при КАЖДОМ изменении:
 *   • PATCH /api/lecture/:id — кнопка «Сохранить заметки»;
 *   • маркер важного (Ctrl+B / F2);
 *   • сборка ИИ-конспекта — и ручная кнопкой, и автоматическая (smart/auto).
 *
 * Идемпотентность: связь «лекция → заметка» хранится в САМОЙ лекции
 * (notes_note_id). Повторные вызовы перезаписывают тот же файл, поэтому
 * конспект, дособранный после новой порции расшифровки, не плодит копии.
 * Если файл удалили с диска вручную, он будет создан заново с тем же id.
 */

/** Заголовок .md файла: название лекции + дата записи (когда она известна). */
function lectureNoteTitle(lec: any) {
  const base = String(lec?.title || "").trim() || "Лекция";
  const date = String(lec?.started_at || "").slice(0, 10);
  return date ? `Лекция: ${base} (${date})` : `Лекция: ${base}`;
}

function syncNotesFile(id: any) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) return null;
  const note = stmts.noteUpsert.run(Number(lec.notes_note_id) || 0, {
    title: lectureNoteTitle(lec),
    content: String(lec.notes || ""),
    // Метки намеренно нейтральные (ASCII): язык интерфейса серверу неизвестен,
    // а frontmatter читают сторонние редакторы и внешние инструменты.
    tags: "lecture",
    folder: "lectures",
  });
  // Первый вызов заводит заметку — запоминаем её id в лекции. Без этого
  // следующий вызов создал бы ВТОРОЙ файл вместо обновления первого.
  if (Number(lec.notes_note_id) !== Number(note.id)) {
    stmts.lectureUpdate.run(id, { notes_note_id: note.id });
  }
  return note;
}

/** Сбой записи .md не должен ломать запись лекции — только предупреждение. */
export function syncNotesFileSafe(id: any, action: any) {
  try {
    syncNotesFile(id);
  } catch (e: any) {
    logger.warn("lecture.notesfile.error", { id, action, error: String(e?.message || e) });
  }
}

/**
 * Разовая синхронизация при старте: у лекций, записанных ДО появления зеркала,
 * .md файла ещё нет. Заводим его сразу, чтобы старый конспект тоже лежал на
 * диске и не ждал следующей правки заметок. Лекции БЕЗ заметок пропускаем:
 * пустые .md в storage/notes только мусорили бы.
 *
 * @returns {number} сколько файлов реально завели
 */
function backfillNotesFiles() {
  let count = 0;
  for (const lec of stmts.lectureAll.all()) {
    // Заметок нет или .md уже заведён — трогать нечего.
    if (!lec.notes || Number(lec.notes_note_id)) continue;
    try {
      if (syncNotesFile(lec.id)) count++;
    } catch (e: any) {
      logger.warn("lecture.notesfile.error", {
        id: lec.id,
        action: "backfill",
        error: String(e?.message || e),
      });
    }
  }
  if (count) logger.action("lecture.notesfile.backfill", { count });
  return count;
}

/** Удалить .md файл лекции (вместе с самой лекцией). */
function removeNotesFile(lec: any) {
  const noteId = Number(lec?.notes_note_id) || 0;
  if (!noteId) return;
  try {
    stmts.noteDelete.run(noteId);
  } catch (e: any) {
    logger.warn("lecture.notesfile.error", {
      id: lec?.id,
      action: "delete",
      error: String(e?.message || e),
    });
  }
}

/** Сохранение заметок лекции (кнопка «Сохранить заметки» в конспекте). */
function setNotes(id: any, notes: any) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) throw new Error("session_not_found");
  stmts.lectureUpdate.run(id, { notes: String(notes || "").slice(0, 200000) });
  // Каждая правка сразу уходит в .md файл лекции (полная синхронизация).
  syncNotesFileSafe(id, "setNotes");
  return stmts.lectureGet.get(id);
}

/** Маркер «важного» (Ctrl+B / F2) — Obsidian-чекбокс с таймкодом в notes. */
function addMarker(id: any, atMs: any, label: any) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) return null;
  const ts = fmtTs(atMs || 0);
  const note = `${lec.notes ? lec.notes + "\n" : ""}- [ ] **[${ts}]** ${String(label || "Важное").slice(0, 300)}`;
  stmts.lectureUpdate.run(id, { notes: note });
  syncNotesFileSafe(id, "marker");
  return { atMs, timestamp: ts, label };
}

function stopSession(id: any) {
  const s = sessions.get(id);
  if (!s) return getStatus(id);
  // Порядок важен: сначала помечаем сессию останавливаемой, потом финализируем
  // дорожки. pumpQueue дочитает очередь и удалит состояние сам (см. pumpQueue).
  s.stopping = true;
  // Финализируем КАЖДУЮ дорожку: микрофон и (если была) системный звук.
  for (const [key, t] of s.tracks) {
    for (const chunk of t.vad.flush()) enqueueChunk(id, chunk, key);
    for (const skip of t.vad.drainSkipped()) {
      stmts.chunkInsertSkipped.run(
        id,
        nextIdx(id),
        Math.round(skip.startMs),
        Math.round(skip.endMs),
        { ...skip, source: key },
      );
    }
    try {
      // Чиним header дорожки (реальный размер данных).
      fs.writeSync(t.fd, writeWavHeader(t.pcmWritten * 2, t.sampleRate, 1), 0, 44, 0);
    } catch {
      /* файл всё равно играбелен большинством плееров */
    }
    try {
      fs.closeSync(t.fd);
    } catch {
      /* ignore */
    }
  }
  // Длительность = длина ЗАПИСАННОГО аудио (источник истины — то, что реально
  // лежит в fail-safe WAV), а не время «от старта до стопа»: клиент может
  // отдать PCM быстрее реального времени, и тогда wall-clock врёт в архиве,
  // в шапке экспорта и в статусе сессии.
  const main = primaryTrack(s);
  const wallMs = Math.max(0, Date.now() - s.startedAt);
  const audioMs =
    s.sampleRate > 0 ? Math.round(((main?.pcmWritten || 0) / s.sampleRate) * 1000) : 0;
  const durMs = audioMs > 0 ? audioMs : wallMs;
  // ВАЖНО: не удаляем состояние сессии здесь. В очереди могут ещё лежать
  // нераспознанные чанки (в т.ч. только что добавленные flush-ом). Раньше они
  // навсегда оставались «pending», потому что pumpQueue больше не находил
  // сессию. Теперь очередь дочитывается, а состояние удаляет сам pumpQueue.
  stmts.lectureUpdate.run(id, {
    status: "stopped",
    ended_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    duration_ms: durMs,
  });
  s.endedAt = Date.now();
  logger.action("lecture.session.stop", { id, durMs, wallMs, audioMs, queue: s.queue.length });
  // Если очередь пуста и транскрипция не идёт — освобождаем сразу.
  pumpQueue(id);
  return getStatus(id);
}

function deleteSession(id: any) {
  stopSession(id);
  // Заметку лекции (её .md зеркало) убираем вместе с самой лекцией: иначе в
  // storage/notes/ оставались бы «осиротевшие» файлы удалённых лекций. Снимок
  // строки делаем ДО delete — после него id заметки уже негде взять.
  const lec = stmts.lectureGet.get(id);
  removeNotesFile(lec);
  // Удаление — явный форс: очередь транскрибации нам больше не нужна,
  // поэтому состояние сессии снимаем принудительно (pumpQueue ждал бы её конца).
  endSession(id);
  stmts.lectureDelete.run(id);
  try {
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  logger.action("lecture.session.delete", { id });
  return true;
}

/**
 * Fail-safe восстановление после аварийного завершения приложения.
 * Сессии, оставшиеся в статусе "recording" (процесс упал/был убит, поэтому
 * stopSession не отработал), переводятся в "interrupted". Файл raw.wav при
 * этом цел — чиним его header по фактическому размеру, чтобы запись
 * открывалась плеером, и восстанавливаем длительность.
 */
function recoverInterrupted() {
  let fixed = 0;
  try {
    for (const lec of stmts.lectureAll.all()) {
      if (lec.status !== "recording") continue;
      if (sessions.has(lec.id)) continue; // живая сессия — не трогаем
      const file = path.join(sessionDir(lec.id), path.basename(lec.raw_file || "raw.wav"));
      let durMs = Number(lec.duration_ms) || 0;
      try {
        const dataLen = Math.max(0, fs.statSync(file).size - 44);
        const sr = Number(lec.sample_rate) || 16000;
        durMs = Math.round((dataLen / 2 / sr) * 1000);
        const fd = fs.openSync(file, "r+");
        try {
          fs.writeSync(fd, writeWavHeader(dataLen, sr, Number(lec.channels) || 1), 0, 44, 0);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* raw.wav мог не создаться — оставляем как есть */
      }
      stmts.lectureUpdate.run(lec.id, {
        status: "interrupted",
        duration_ms: durMs,
        ended_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      });
      fixed++;
    }
  } catch (e: any) {
    logger.error("lecture.recover", { error: String(e.message || e) });
  }
  if (fixed) logger.action("lecture.recover.interrupted", { count: fixed });
  return fixed;
}

/* ------------------------- Настройки аудиовхода ------------------------- */

/**
 * Настройки записи для панели «Аудио»: микрофон, гейн и VAD.
 * Отдаём вместе с границами, чтобы UI не придумывал валидные диапазоны сам:
 * иначе в settings.json попадут значения, которые vad.js потом молча зажмёт.
 */
function audioSettings() {
  const c = cfg();
  const thr = Math.max(0.0005, Number(c.vadRmsThreshold ?? 0.008));
  return {
    micDeviceId: String(c.micDeviceId || ""),
    micGain: Number(c.micGain ?? 1),
    micAgc: c.micAgc === true,
    // Потоковая расшифровка (бета): черновой текст по ходу фразы, до паузы (см. pumpDraft).
    streaming: c.streaming === true,
    vad: {
      rmsThreshold: thr,
      thresholdDb: Math.round(20 * Math.log10(thr) * 10) / 10,
      adaptive: c.vadAdaptive !== false,
      thresholdFactor: Number(c.vadThresholdFactor ?? 3),
      minSpeechRatio: Number(c.vadMinSpeechRatio ?? 0.15),
      zcrGate: c.vadZcrGate !== false,
      silenceMs: Number(c.vadSilenceMs),
      minChunkMs: Number(c.vadMinChunkMs),
      maxChunkMs: Number(c.vadMaxChunkMs),
      forceSplitMs: Number(c.vadForceSplitMs),
    },
    limits: {
      micGain: [0.5, 4],
      rmsThreshold: [0.0005, 0.2],
      thresholdFactor: [1.5, 12],
      minSpeechRatio: [0, 1],
    },
  };
}

/** Сохранить настройки аудиовхода (частично: только переданные поля). */
function setAudioSettings(patch: Record<string, any> = {}) {
  const c = cfg();
  const next: Record<string, any> = {};
  const num = (v: any, lo: any, hi: any, fallback: any) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  };
  if (patch.micDeviceId !== undefined)
    next.micDeviceId = String(patch.micDeviceId || "").slice(0, 200);
  if (patch.micGain !== undefined)
    next.micGain = num(patch.micGain, 0.5, 4, Number(c.micGain ?? 1));
  if (patch.micAgc !== undefined) next.micAgc = !!patch.micAgc;
  if (patch.streaming !== undefined) next.streaming = !!patch.streaming;
  const v = patch.vad || {};
  if (v.rmsThreshold !== undefined)
    next.vadRmsThreshold = num(v.rmsThreshold, 0.0005, 0.2, Number(c.vadRmsThreshold));
  if (v.adaptive !== undefined) next.vadAdaptive = !!v.adaptive;
  if (v.thresholdFactor !== undefined)
    next.vadThresholdFactor = num(v.thresholdFactor, 1.5, 12, Number(c.vadThresholdFactor));
  if (v.minSpeechRatio !== undefined)
    next.vadMinSpeechRatio = num(v.minSpeechRatio, 0, 1, Number(c.vadMinSpeechRatio));
  if (v.zcrGate !== undefined) next.vadZcrGate = !!v.zcrGate;
  if (Object.keys(next).length) settings.set({ lecture: next });
  logger.action("lecture.audio.settings", next);
  return audioSettings();
}

/* ------------------------- Аудио ------------------------- */

function chunkAudioPath(chunkId: any) {
  const c = stmts.chunkGet.get(chunkId);
  if (!c) return null;
  return path.join(sessionDir(c.lecture_id), c.file);
}

function rawAudioPath(id: any, track = "mic") {
  const lec = stmts.lectureGet.get(id);
  if (!lec) return null;
  const name = track === "sys" ? "raw_sys.wav" : lec.raw_file || "raw.wav";
  const p = path.join(sessionDir(id), path.basename(name));
  return fs.existsSync(p) ? p : null;
}

// --- Диспетчер фоновых задач (server/ts/taskRegistry.ts) ---
// Лекция — не Map-задание с прогрессом 0..100, а живая сессия записи (её
// пользователь останавливает сам, когда закончил говорить), поэтому прогресс
// здесь не показываем (-1 — "неизвестен"), но видимость в общем списке и
// возможность остановить (та же stopSession, что кнопка «Стоп» на странице)
// добавить стоило: раньше активная запись не была видна нигде, кроме своей
// вкладки, и не входила в централизованное завершение при закрытии приложения.
try {
  const taskRegistry = require("./taskRegistry") as typeof import("./taskRegistry");
  taskRegistry.registerProvider({
    engine: "lecture",
    list: () =>
      [...sessions.values()].map((s) => ({
        id: String(s.id),
        engine: "lecture",
        label: `Лекция #${s.id}`,
        stage: s.stopping ? "stopping" : "recording",
        progress: -1,
        createdAt: s.startedAt,
        done: false,
        error: s.lastError || null,
        canCancel: !s.stopping,
        canPause: false,
        paused: false,
      })),
    cancel: (id) => {
      const numId = Number(id);
      if (!sessions.has(numId)) return false;
      stopSession(numId);
      return true;
    },
  });
} catch {
  /* taskRegistry ещё не собран (dev до первой компиляции) — не критично */
}
export {
  createSession,
  ingest,
  getStatus,
  stopSession,
  deleteSession,
  updateChunkText,
  setNotes,
  addMarker,
  engineStatus,
  chunkAudioPath,
  rawAudioPath,
  audioSettings,
  setAudioSettings,
  recoverInterrupted,
  backfillNotesFiles,
};
