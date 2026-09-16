"use strict";

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

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { DIRS } = require("./config");
const { stmts } = require("./db");
const settings = require("./settings");
const logger = require("./logger");
const { VadBufferManager } = require("./vad");
const whisperEngine = require("./whisperEngine");
// Провайдеры чата (DeepSeek/OpenAI/…): конспект собирается через тот же ключ и
// модель, что и AI-чат, поэтому отдельная интеграция с Ollama больше не нужна.
const { getProvider, PROVIDERS } = require("./providers");
// Разделение говорящих (sherpa-onnx): модуль не зависит от lecture.js, поэтому
// циклов в require нет.
const diarize = require("./diarize");
const { getSecret } = require("./security");
const { runWithPage } = require("./middleware/perPageProxy");

// Прогреваем детект GPU в фоне: engineSummary() отдаёт предупреждения вида
// «CUDA-сборка выбрана, но NVIDIA не найдена», а первый nvidia-smi занимает
// ~50 мс — не хотим ждать его в запросе статуса.
void whisperEngine.detectGpu().catch(() => { /* детект не критичен */ });

/** Типовые галлюцинации Whisper на тишине/шуме — вырезаем из результата. */
const HALLUCINATION_RE = [
  /^спасибо за просмотр[!.]?$/i,
  /^подпиш(ись|итесь)[!.]?$/i,
  /^amara\.org$/i,
  /^продолжение следует/i,
  /^до новых встреч[!.]?$/i,
  // ВАЖНО: именно пропуски/пунктуация/символы БЕЗ букв. Обычный \W — это
  // [^A-Za-z0-9_], а кириллица для него тоже «не-слово», поэтому прежний
  // /^\W*$/ отбрасывал ЛЮБУЮ русскую расшифровку как «пустую».
  /^[\p{P}\p{S}\s]*$/u,
];
const HALLUCINATION_CONTAINS = ["subtitles by", "amara.org", "спасибо за просмотр", "подписывайтесь на канал"];

/* ------------------------- WAV ------------------------- */

function writeWavHeader(dataLen, sampleRate, channels) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate (16 bit)
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return header;
}

function toWav(pcmInt16, sampleRate, channels = 1) {
  const header = writeWavHeader(pcmInt16.length * 2, sampleRate, channels);
  return Buffer.concat([header, Buffer.from(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.byteLength)]);
}

/* ------------------------- Состояние ------------------------- */

/** Активные сессии записи: id → { vads, rawFd, rawFile, queue, ... } */
const sessions = new Map();

function cfg() { return settings.get("lecture"); }

function sessionDir(id) { return path.join(DIRS.lectures, String(id)); }

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

function createSession(title, sampleRate, channels) {
  const lc = cfg();
  const sr = 16000; // фронт всегда отдаёт PCM 16 кГц моно (даунсэмпл на клиенте)
  const ch = channels === 2 ? 2 : 1;
  const info = stmts.lectureInsert.run((title || "Лекция").slice(0, 200), sr, ch);
  const id = Number(info.lastInsertRowid);
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const s = {
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
function ensureTrack(s, src) {
  const key = src === "sys" ? "sys" : "mic";
  const existing = s.tracks.get(key);
  if (existing) return existing;
  const file = path.join(sessionDir(s.id), key === "sys" ? "raw_sys.wav" : "raw.wav");
  fs.writeFileSync(file, writeWavHeader(0, s.sampleRate, 1));
  const track = {
    src: key, file, fd: fs.openSync(file, "r+"), writePos: 44,
    sampleRate: s.sampleRate, pcmWritten: 0,
    vad: new VadBufferManager(vadOptions(cfg(), s.sampleRate)),
  };
  s.tracks.set(key, track);
  return track;
}

/** Дорожка с наибольшим количеством аудио (основная для длительности и статуса). */
function primaryTrack(s) {
  const list = Array.from(s.tracks.values());
  return list.sort((a, b) => b.pcmWritten - a.pcmWritten)[0] || null;
}

function vadConfig(c) {
  return {
    silenceMs: c.vadSilenceMs, minChunkMs: c.vadMinChunkMs,
    maxChunkMs: c.vadMaxChunkMs, forceSplitMs: c.vadForceSplitMs, padMs: c.vadPadMs,
  };
}

/**
 * Опции VAD из настроек. Порог, адаптация и анти-шум вынесены в settings.lecture
 * (панель «Аудио»), потому что «тихий микрофон» и «шум системного звука» —
 * разные болезни с разными лекарствами: гейн/выбор устройства против порога.
 */
function vadOptions(c, sampleRate) {
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
function ingest(id, buf, track = "mic") {
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
    stmts.chunkInsertSkipped.run(id, nextIdx(id), Math.round(skip.startMs), Math.round(skip.endMs), { ...skip, source: src });
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
function nextIdx(id) {
  const chunks = stmts.chunkFor.all(id);
  return (chunks.length ? Math.max(...chunks.map((c) => Number(c.idx) || 0)) : 0) + 1;
}

function enqueueChunk(id, chunk, source = "mic") {
  const s = sessions.get(id);
  if (!s) return;
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
  s.queue.push({ chunkId: Number(info.lastInsertRowid), file: base, startMs: chunk.startMs, endMs: chunk.endMs, source });
  pumpQueue(id);
}


/* ------------------------- Транскрипция (whisper.cpp) ------------------------- */

function pumpQueue(id) {
  const s = sessions.get(id);
  if (!s || s.transcribing) return;
  const item = s.queue[0];
  if (!item) {
    // Очередь пуста: если запись уже остановлена — только теперь освобождаем
    // состояние сессии. Раньше stopSession удаляла его сразу, и последние
    // чанки лекции оставались «pending» навсегда (некому было их читать).
    if (s.stopping) {
      sessions.delete(id);
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
      if (item.chunkId) stmts.chunkUpdate.run(item.chunkId, { status: "error", error: String(e.message || e).slice(0, 500) });
      s.lastError = String(e.message || e);
      logger.error("lecture.transcribe", { id, error: s.lastError });
    })
    .finally(() => {
      s.queue.shift();
      s.transcribing = false;
      if (s.queue.length) pumpQueue(id);
      else if (s.stopping) {
        sessions.delete(id);
        // Последний чанк дочитан — тот же «умный» авто-конспект, что и выше.
        maybeAutoConspectus(id);
        maybeAutoDiarize(id);
      }
    });
}

function transcribeChunk(id, item) {
  return new Promise((resolve, reject) => {
    const bin = whisperEngine.findBin();
    const model = whisperEngine.findModel();
    if (!bin || !model) {
      const err = new Error(bin ? "whisper_model_missing" : "whisper_not_installed");
      if (item.chunkId) stmts.chunkUpdate.run(item.chunkId, { status: "error", error: err.message });
      return reject(err);
    }
    const wavPath = path.join(sessionDir(id), item.file);
    const outBase = wavPath.replace(/\.wav$/i, "");
    // Аргументы собирает whisperEngine.transcribeArgs — там же флаги GPU
    // (-ng для CPU-сборки/выключенной видеокарты, -dev N для выбора устройства).
    const args = whisperEngine.transcribeArgs(model, wavPath, outBase);
    const proc = spawn(bin, args, { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } reject(new Error("whisper_timeout")); }, 120000);
    proc.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) return reject(new Error(`whisper_exit_${code}: ${stderr.slice(-300)}`));
      // whisper-cli с -osrt пишет <outBase>.srt; текст берём оттуда (с сегментами).
      let text = "";
      let segments = [];
      try {
        const srtPath = outBase + ".srt";
        if (fs.existsSync(srtPath)) {
          segments = parseSrt(fs.readFileSync(srtPath, "utf8"));
          text = segments.map((x) => x.text).join(" ").trim();
        }
      } catch { /* ignore */ }
      if (!text) text = stdout.replace(/\s+/g, " ").trim();
      text = sanitizeText(text);
      segments = segments.map((x) => ({ ...x, text: sanitizeText(x.text) })).filter((x) => x.text);
      if (item.chunkId) {
        // ВАЖНО: причина разделена. "empty" — это ответ Whisper (он не нашёл
        // речи), а не решение VAD. Раньше UI подписывал всё как «отброшено
        // VAD», и понять, что происходит с записью, было невозможно.
        stmts.chunkUpdate.run(item.chunkId, {
          text,
          status: text ? "done" : "empty",
          reason: text ? "" : "whisper_empty",
          error: "",
        });
      }
      logger.info("lecture.chunk.done", { id, file: item.file, chars: text.length });
      resolve({ text, segments });
    });
  });
}

/** Вырезание галлюцинаций и схлопывание зацикленных повторов. */
function sanitizeText(text) {
  let t = (text || "").replace(/\s+/g, " ").trim();
  for (const re of HALLUCINATION_RE) if (re.test(t)) return "";
  const low = t.toLowerCase();
  for (const h of HALLUCINATION_CONTAINS) if (low.includes(h)) return "";
  // Схлопывание циклов: "а б а б а б" → "а б" для окна любой длины (1..6).
  // ВАЖНО: после каждой правки скан перезапускается с n=1. Прежний вариант
  // прекращал работу, если самое короткое окно не дало совпадений, поэтому
  // повтор из двух и более слов («вот так вот так вот так») не находился.
  const words = t.split(" ");
  let changedAny = true;
  let guard = 0;
  while (changedAny && guard++ < 200) {
    changedAny = false;
    for (let n = 1; n <= 6 && !changedAny; n++) {
      for (let i = 0; i + 2 * n <= words.length; i++) {
        const a = words.slice(i, i + n).join(" ").toLowerCase();
        let j = i + n;
        while (j + n <= words.length && words.slice(j, j + n).join(" ").toLowerCase() === a) j += n;
        if (j > i + n) {
          words.splice(i + n, j - (i + n));
          changedAny = true;
          break;
        }
      }
    }
  }
  return words.join(" ").trim();
}

function parseSrt(srt) {
  const out = [];
  for (const block of String(srt).replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const m = lines.find((l) => l.includes("-->"));
    if (!m) continue;
    // Берём время ЦЕЛИКОМ (с миллисекундами после запятой): раньше
    // split(",")[0] отбрасывал доли секунды, и все сегменты «округлялись» до
    // целой секунды. Хвостовые настройки (position:…) отсекаются.
    const parts = m.split("-->").map((x) => x.trim().split(/\s+/)[0]);
    const a = parts[0], b = parts[1];
    const text = lines.slice(lines.indexOf(m) + 1).join(" ").trim();
    out.push({ start: srtTimeToSec(a), end: srtTimeToSec(b), text });
  }
  return out;
}

/** "00:00:02,500" / "00:00:02.500" → секунды (с миллисекундами). */
function srtTimeToSec(t) {
  const m = /(\d+):(\d+):(\d+)[,.](\d{1,3})/.exec(String(t));
  if (m) {
    const ms = Number(m[4].padEnd(3, "0"));
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
  }
  // Фолбэк для времени без долей секунды.
  const [h, min, s] = String(t).split(":").map((x) => parseFloat(x) || 0);
  return h * 3600 + min * 60 + s;
}


/* ------------------------- Статусы / правки ------------------------- */

function getStatus(id) {
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
    recordingSec: s && main
      ? Math.round(main.pcmWritten / main.sampleRate)
      : Math.round((lecture.duration_ms || 0) / 1000),
    vadStats: main ? main.vad.stats : null,
    // Живая диагностика: порог, шумовой пол и пропуски. Без неё «тишина/шум»
    // в транскрипте невозможно объяснить (см. панель «Аудио» на странице).
    vad: s ? vadLiveMetrics(s) : null,
    recheck: recheckState(id),
    lastError: s ? s.lastError : "",
    whisper: engineStatus(),
  };
}

/** Метрики VAD по всем дорожкам: mic / sys (если она есть). */
function vadLiveMetrics(s) {
  const out = {};
  for (const [key, t] of s.tracks) {
    out[key] = { ...t.vad.metrics(), recordingSec: Math.round(t.pcmWritten / t.sampleRate) };
  }
  return out;
}

/** Click-to-edit: правка текста чанка прямо из телепромтера. */
function updateChunkText(chunkId, text) {
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
function lectureNoteTitle(lec) {
  const base = String(lec?.title || "").trim() || "Лекция";
  const date = String(lec?.started_at || "").slice(0, 10);
  return date ? `Лекция: ${base} (${date})` : `Лекция: ${base}`;
}

function syncNotesFile(id) {
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
function syncNotesFileSafe(id, action) {
  try { syncNotesFile(id); }
  catch (e) { logger.warn("lecture.notesfile.error", { id, action, error: String(e?.message || e) }); }
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
    try { if (syncNotesFile(lec.id)) count++; }
    catch (e) { logger.warn("lecture.notesfile.error", { id: lec.id, action: "backfill", error: String(e?.message || e) }); }
  }
  if (count) logger.action("lecture.notesfile.backfill", { count });
  return count;
}

/** Удалить .md файл лекции (вместе с самой лекцией). */
function removeNotesFile(lec) {
  const noteId = Number(lec?.notes_note_id) || 0;
  if (!noteId) return;
  try { stmts.noteDelete.run(noteId); }
  catch (e) { logger.warn("lecture.notesfile.error", { id: lec?.id, action: "delete", error: String(e?.message || e) }); }
}

/** Сохранение заметок лекции (кнопка «Сохранить заметки» в конспекте). */
function setNotes(id, notes) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) throw new Error("session_not_found");
  stmts.lectureUpdate.run(id, { notes: String(notes || "").slice(0, 200000) });
  // Каждая правка сразу уходит в .md файл лекции (полная синхронизация).
  syncNotesFileSafe(id, "setNotes");
  return stmts.lectureGet.get(id);
}

/** Маркер «важного» (Ctrl+B / F2) — Obsidian-чекбокс с таймкодом в notes. */
function addMarker(id, atMs, label) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) return null;
  const ts = fmtTs(atMs || 0);
  const note = `${lec.notes ? lec.notes + "\n" : ""}- [ ] **[${ts}]** ${String(label || "Важное").slice(0, 300)}`;
  stmts.lectureUpdate.run(id, { notes: note });
  syncNotesFileSafe(id, "marker");
  return { atMs, timestamp: ts, label };
}

function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return getStatus(id);
  // Порядок важен: сначала помечаем сессию останавливаемой, потом финализируем
  // дорожки. pumpQueue дочитает очередь и удалит состояние сам (см. pumpQueue).
  s.stopping = true;
  // Финализируем КАЖДУЮ дорожку: микрофон и (если была) системный звук.
  for (const [key, t] of s.tracks) {
    for (const chunk of t.vad.flush()) enqueueChunk(id, chunk, key);
    for (const skip of t.vad.drainSkipped()) {
      stmts.chunkInsertSkipped.run(id, nextIdx(id), Math.round(skip.startMs), Math.round(skip.endMs), { ...skip, source: key });
    }
    try {
      // Чиним header дорожки (реальный размер данных).
      fs.writeSync(t.fd, writeWavHeader(t.pcmWritten * 2, t.sampleRate, 1), 0, 44, 0);
    } catch { /* файл всё равно играбелен большинством плееров */ }
    try { fs.closeSync(t.fd); } catch { /* ignore */ }
  }
  // Длительность = длина ЗАПИСАННОГО аудио (источник истины — то, что реально
  // лежит в fail-safe WAV), а не время «от старта до стопа»: клиент может
  // отдать PCM быстрее реального времени, и тогда wall-clock врёт в архиве,
  // в шапке экспорта и в статусе сессии.
  const main = primaryTrack(s);
  const wallMs = Math.max(0, Date.now() - s.startedAt);
  const audioMs = s.sampleRate > 0 ? Math.round(((main?.pcmWritten || 0) / s.sampleRate) * 1000) : 0;
  const durMs = audioMs > 0 ? audioMs : wallMs;
  // ВАЖНО: не удаляем состояние сессии здесь. В очереди могут ещё лежать
  // нераспознанные чанки (в т.ч. только что добавленные flush-ом). Раньше они
  // навсегда оставались «pending», потому что pumpQueue больше не находил
  // сессию. Теперь очередь дочитывается, а состояние удаляет сам pumpQueue.
  stmts.lectureUpdate.run(id, { status: "stopped", ended_at: new Date().toISOString().replace("T", " ").slice(0, 19), duration_ms: durMs });
  s.endedAt = Date.now();
  logger.action("lecture.session.stop", { id, durMs, wallMs, audioMs, queue: s.queue.length });
  // Если очередь пуста и транскрипция не идёт — освобождаем сразу.
  pumpQueue(id);
  return getStatus(id);
}

function deleteSession(id) {
  stopSession(id);
  // Заметку лекции (её .md зеркало) убираем вместе с самой лекцией: иначе в
  // storage/notes/ оставались бы «осиротевшие» файлы удалённых лекций. Снимок
  // строки делаем ДО delete — после него id заметки уже негде взять.
  const lec = stmts.lectureGet.get(id);
  removeNotesFile(lec);
  // Удаление — явный форс: очередь транскрибации нам больше не нужна,
  // поэтому состояние сессии снимаем принудительно (pumpQueue ждал бы её конца).
  sessions.delete(id);
  stmts.lectureDelete.run(id);
  try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
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
        try { fs.writeSync(fd, writeWavHeader(dataLen, sr, Number(lec.channels) || 1), 0, 44, 0); }
        finally { fs.closeSync(fd); }
      } catch { /* raw.wav мог не создаться — оставляем как есть */ }
      stmts.lectureUpdate.run(lec.id, {
        status: "interrupted",
        duration_ms: durMs,
        ended_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      });
      fixed++;
    }
  } catch (e) { logger.error("lecture.recover", { error: String(e.message || e) }); }
  if (fixed) logger.action("lecture.recover.interrupted", { count: fixed });
  return fixed;
}

/* ------------------------- Экспорт ------------------------- */

function fmtTs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map((x) => String(x).padStart(2, "0")).join(":");
}

function fmtSrtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const msPart = String(Math.round((sec % 1) * 1000)).padStart(3, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${msPart}`;
}

function fmtVttTime(sec) {
  return fmtSrtTime(sec).replace(",", ".");
}

/**
 * Подпись говорящего для строки расшифровки.
 *
 * Двухдорожечный режим уже даёт главное деление голосов БЕЗ отдельной модели:
 * системный звук (sys) — это эфир, т.е. лектор или запись курса; микрофон (mic) —
 * аудитория в комнате (студенты, вопросы). Разделение голосов ВНУТРИ дорожки
 * (кто именно из студентов) требует диаризации по отпечаткам голоса — сейчас её
 * нет: одна дорожка = один говорящий.
 *
 * labels приходят с клиента уже переведёнными: экспорт читает пользователь, а
 * сервер не знает язык интерфейса.
 */
function speakerOf(chunk, labels = {}) {
  if (!labels || labels.mode === "off") return "";
  const src = chunk.source === "sys" ? "sys" : "mic";
  // Диаризация (sherpa) даёт говорящего ВНУТРИ дорожки: «Лектор 2», «Аудитория 1».
  // Если разбора не было — остаётся подпись дорожки.
  const sp = String(chunk.speaker || "");
  const named = sp && labels.speakers ? labels.speakers[sp] : "";
  const who = named || (labels[src] ? String(labels[src]) : "");
  if (!who) return "";
  // «?» — в чанке звучали двое (доля доминирующего голоса ниже 55%). Приписать
  // реплику одному говорящему было бы враньём, поэтому помечаем сомнение.
  return Number(chunk.speakerRatio ?? 1) < 0.55 ? `${who}?` : who;
}

function buildMarkdown(id, labels = {}) {
  const st = getStatus(id);
  if (!st) return "";
  const lines = [`# ${st.lecture.title}`, "", `> Запись от ${st.lecture.started_at} · длительность ${fmtTs(st.recordingSec * 1000)}`, ""];
  if (st.lecture.notes) lines.push("## Важное (маркеры)", "", st.lecture.notes, "");
  lines.push("## Расшифровка", "");
  for (const c of st.chunks) {
    if (!c.text) continue;
    const who = speakerOf(c, labels);
    lines.push(`**[${fmtTs(c.start_ms)}]**${who ? ` **${who}:**` : ""} ${c.text}`, "");
  }
  return lines.join("\n");
}

function buildSrt(id, labels = {}) {
  const st = getStatus(id);
  if (!st) return "";
  let idx = 0;
  const out = [];
  for (const c of st.chunks) {
    if (!c.text) continue;
    const start = c.start_ms / 1000;
    const end = Math.max(c.end_ms / 1000, start + 1);
    const who = speakerOf(c, labels);
    out.push(`${++idx}`, `${fmtSrtTime(start)} --> ${fmtSrtTime(end)}`, `${who ? `— ${who}: ` : ""}${c.text}`, "");
  }
  return out.join("\n");
}

function buildVtt(id, labels = {}) {
  const st = getStatus(id);
  if (!st) return "";
  const out = ["WEBVTT", ""];
  for (const c of st.chunks) {
    if (!c.text) continue;
    const start = c.start_ms / 1000;
    const end = Math.max(c.end_ms / 1000, start + 1);
    const who = speakerOf(c, labels);
    // Голос — блоком <v>: плееры (VLC и др.) читают это как имя говорящего.
    out.push(`${fmtVttTime(start)} --> ${fmtVttTime(end)}`, who ? `<v ${who}>${c.text}` : c.text, "");
  }
  return out.join("\n");
}

/** Экспорт расшифровки: labels — подписи говорящих с клиента (переведённые). */
function exportContent(id, format, labels = {}) {
  // Подписи говорящих по диаризации (если она запускалась): sys_0 → «Лектор»,
  // sys_1 → «Лектор 2». Считаем один раз на экспорт, а не на каждый чанк.
  const withSpeakers = labels && labels.mode !== "off"
    ? { ...labels, speakers: diarize.speakerNames(id, labels) }
    : labels;
  if (format === "srt") return { mime: "application/x-subrip", body: buildSrt(id, withSpeakers), name: `lecture_${id}.srt` };
  if (format === "vtt") return { mime: "text/vtt", body: buildVtt(id, withSpeakers), name: `lecture_${id}.vtt` };
  return { mime: "text/markdown", body: buildMarkdown(id, withSpeakers), name: `${safeName(getStatus(id)?.lecture.title || "lecture")}.md` };
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "lecture";
}

/**
 * Заголовок Content-Disposition с именем файла.
 *
 * Почему не просто filename="…": в имя MD-файла попадает НАЗВАНИЕ лекции, а оно
 * почти всегда на русском. Node запрещает символы вне ASCII в заголовках и
 * отвечает 400 «Invalid character in header content» — именно поэтому падала
 * выгрузка .md (а srt/vtt выживали: у них имя lecture_<id>). Здесь ASCII-копию
 * чистим без потери читаемости, а настоящее имя отдаём в filename*=UTF-8''
 * (RFC 5987): браузер и Electron понимают его и сохраняют файл по-русски.
 */
function contentDisposition(name) {
  const full = String(name || "lecture");
  const ext = (path.extname(full).match(/^\.[A-Za-z0-9]{1,8}$/) || [""])[0];
  // Кириллицу выкидываем целиком. Проверяем ИМЯ без расширения: у «.md» есть
  // буква, поэтому проверка по всему имени пропускала бы «filename=".md"».
  const base = full.slice(0, full.length - ext.length);
  let asciiBase = base.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "").trim();
  if (!/[A-Za-z0-9]/.test(asciiBase)) asciiBase = "lecture";
  return `attachment; filename="${asciiBase}${ext}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}


/* ------------------------- AI-конспект (провайдер чата, чанками) ------------------------- */

/**
 * Конспект строится ЧАНКАМИ и в два прохода.
 *
 * Почему переписано: старая версия отправляла в локальный Ollama только последние
 * 14 000 символов расшифровки. Для часовой лекции это означало, что конспект
 * строится по её концу, а начало просто не существует. Плюс требовался
 * запущенный Ollama, хотя в приложении уже есть провайдеры чата (DeepSeek и др.)
 * с сохранёнными ключами.
 *
 * Схема: расшифровка делится на блоки по ~conspectusChunkChars символов, каждый
 * блок превращается в ЧЕРНОВЫЕ ЗАМЕТКИ (первый проход), затем заметки сводятся в
 * один структурированный конспект (второй проход). «Шов» (хвост предыдущего
 * блока) передаётся в следующий запрос, поэтому фразы на границе блоков не
 * теряются, а метки времени удерживают хронологию лекции.
 */

const CHUNK_PROMPT = `Ты — академический ассистент. Ниже ФРАГМЕНТ расшифровки университетской лекции.
Выпиши по нему ЧЕРНОВЫЕ ЗАМЕТКИ на русском (без вступлений и выводов):
- определения всех терминов, которые встречаются в тексте;
- теоремы, формулы (в LaTeX $...$), правила и условия их применимости;
- примеры и задачи вместе с решением;
- числовые факты, даты, имена;
- 2-3 вопроса по этому фрагменту, которые могут спросить на экзамене.

Пиши только то, что есть в тексте. Ничего не выдумывай. Если фрагмент —
продолжение предыдущей мысли, так и укажи («продолжение: ...»).
=== ФРАГМЕНТ ===
`;

const MERGE_PROMPT = `Ты — академический ассистент. Ниже ЧЕРНОВЫЕ ЗАМЕТКИ по всей лекции,
собранные по фрагментам в хронологическом порядке.
Собери из них один аккуратный конспект на русском в Markdown ровно в таком виде:

## Обзор
(2-4 абзаца: о чём лекция, логика изложения)

## Ключевые термины
| Термин | Определение |
|---|---|

## Основные теоремы и формулы
(нумерованный список; формулы в LaTeX-нотации $...$)

## Вопросы для подготовки к экзамену
1. (вопрос) — (краткий ожидаемый ответ)

Убери повторы и «черновые» пометки, сохрани порядок разделов лекции.
Не добавляй факты, которых нет в заметках.
=== ЗАМЕТКИ ===
`;

/** Настройки конспекта: провайдер и модель берём из настроек чата, если не заданы. */
function conspectusCfg() {
  const c = cfg();
  const chat = settings.get("chat") || {};
  const trigger = ["smart", "auto", "manual"].includes(String(c.conspectusTrigger))
    ? String(c.conspectusTrigger)
    : "smart";
  return {
    // "" — «как в чате»: провайдер берётся из настроек AI-чата (chat.provider).
    providerId: String(c.conspectusProvider || chat.provider || "deepseek"),
    providerFromChat: !c.conspectusProvider,
    model: String(c.conspectusModel || ""),
    // Режим запуска: smart (авто с проверками) | auto (авто всегда) | manual (кнопка).
    trigger,
    autoMinChars: Math.max(0, Math.min(200000, Number(c.conspectusAutoMinChars) || 0)),
    chunkChars: Math.max(1500, Math.min(20000, Number(c.conspectusChunkChars) || 6000)),
    overlapChars: Math.max(0, Math.min(2000, Number(c.conspectusOverlapChars) || 600)),
    maxChunks: Math.max(1, Math.min(300, Number(c.conspectusMaxChunks) || 60)),
    temperature: 0.3,
  };
}

/**
 * Провайдер + ключ + модель для конспекта.
 * Модель: явная настройка → список провайдера → первая «chat»-модель из /models.
 * (У DeepSeek в API есть deepseek-chat и deepseek-reasoner; имени «flash» нет,
 * поэтому неизвестное имя не подставляем молча, а сверяемся со списком сервиса.)
 */
async function conspectusTarget(appPage) {
  const c = conspectusCfg();
  let provider;
  try {
    provider = getProvider(c.providerId);
  } catch {
    throw new Error("conspectus_provider_unknown: " + c.providerId);
  }
  const secret = getSecret(provider.id);
  if (!secret) throw new Error("conspectus_not_configured: " + provider.id);
  let model = c.model;
  if (!model) {
    let list = [];
    try {
      list = await runWithPage(appPage, () => provider.listModels(secret));
    } catch { /* нет сети — берём каталог провайдера */ }
    if (!Array.isArray(list) || !list.length) list = provider.models || [];
    // reasoner медленнее и хуже держит длинный контекст — предпочитаем chat-модель.
    model = list.find((m) => /chat|turbo|flash|mini|small|lite/i.test(m)) || list[0] || "";
  }
  if (!model) throw new Error("conspectus_model_missing: " + provider.id);
  return { provider, secret, model, cfg: c };
}

/* --- Настройки конспекта и выбор провайдера (панель «ИИ-конспект») --- */

/**
 * Провайдеры для панели: ярлык, каталог моделей и ЕСТЬ ЛИ КЛЮЧ.
 * Без этого списка пользователь выбирал «OpenAI», не понимая, что ключа нет,
 * и получал conspectus_not_configured уже во время сборки конспекта.
 */
function conspectusProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    models: Array.isArray(p.models) ? p.models : [],
    hasKey: !!getSecret(p.id),
  }));
}

/** Настройки конспекта одним ответом: провайдер, модель, режим запуска + список. */
function conspectusSettings() {
  const c = conspectusCfg();
  const chat = settings.get("chat") || {};
  return {
    providerId: c.providerId,
    providerFromChat: c.providerFromChat, // true — провайдер наследуется от чата
    chatProvider: String(chat.provider || ""),
    hasKey: !!getSecret(c.providerId),
    model: c.model,
    trigger: c.trigger,
    autoMinChars: c.autoMinChars,
    chunkChars: c.chunkChars,
    overlapChars: c.overlapChars,
    maxChunks: c.maxChunks,
    triggerOptions: ["smart", "auto", "manual"],
    providers: conspectusProviders(),
  };
}

/** Сохранить настройки конспекта (частично: только переданные поля). */
function setConspectusSettings(patch = {}) {
  const c = cfg();
  const next = {};
  const num = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  if (patch.providerId !== undefined) {
    const id = String(patch.providerId || "");
    // "" — «как в чате» (chat.provider); иначе провайдер обязан существовать.
    if (id && !PROVIDERS.some((p) => p.id === id)) throw new Error("conspectus_provider_unknown: " + id);
    next.conspectusProvider = id;
  }
  if (patch.model !== undefined) next.conspectusModel = String(patch.model || "").slice(0, 200);
  if (patch.trigger !== undefined) {
    const tr = String(patch.trigger || "");
    if (!["smart", "auto", "manual"].includes(tr)) throw new Error("conspectus_trigger_unknown: " + tr);
    next.conspectusTrigger = tr;
  }
  if (patch.autoMinChars !== undefined) {
    next.conspectusAutoMinChars = Math.round(num(patch.autoMinChars, 0, 200000, Number(c.conspectusAutoMinChars) || 0));
  }
  if (patch.chunkChars !== undefined) next.conspectusChunkChars = Math.round(num(patch.chunkChars, 1500, 20000, 6000));
  if (patch.overlapChars !== undefined) next.conspectusOverlapChars = Math.round(num(patch.overlapChars, 0, 2000, 0));
  if (patch.maxChunks !== undefined) next.conspectusMaxChunks = Math.round(num(patch.maxChunks, 1, 300, 60));
  if (Object.keys(next).length) settings.set({ lecture: next });
  logger.action("lecture.conspectus.settings", next);
  return conspectusSettings();
}

/** Модели провайдера для селекта (живой /models, при отсутствии сети — каталог). */
async function providerModels(id, appPage = null) {
  let provider;
  try {
    provider = getProvider(String(id || ""));
  } catch {
    throw new Error("conspectus_provider_unknown: " + String(id || ""));
  }
  const secret = getSecret(provider.id);
  if (!secret) throw new Error("conspectus_not_configured: " + provider.id);
  let list = [];
  try {
    list = await runWithPage(appPage, () => provider.listModels(secret));
  } catch { /* нет сети — отдаём каталог провайдера, чтобы селект был не пустой */ }
  if (!Array.isArray(list) || !list.length) list = provider.models || [];
  return { provider: provider.id, models: list.filter(Boolean).map(String) };
}

/** Символы и чанки с текстом — «масса» расшифровки для авто-режима. */
function transcriptWeight(id) {
  const chunks = stmts.chunkFor.all(id);
  let chars = 0;
  for (const c of chunks) chars += String(c.text || "").trim().length;
  return { chars, chunks };
}

/** «Текст вырос заметно с прошлой сборки» — общий критерий для stale/авто. */
function conspectusStale(lec, chars) {
  if (!lec?.conspectus_at) return false;
  const prev = Number(lec.conspectus_len) || 0;
  return chars > prev * 1.25 + 400;
}

/**
 * Умный авто-конспект: запускается сам после того, как расшифровка дочитана.
 *
 * Почему «умный», а не «всегда»: сборка длинной лекции — это десятки запросов
 * к модели (деньги и время). Поэтому в режиме smart пропускаем запуск, когда
 * (а) расшифровки меньше autoMinChars — конспектировать нечего;
 * (б) текст не изменился с прошлой сборки — повтор был бы платой за то же самое.
 * Режим auto собирает всегда, manual — только по кнопке.
 */
function maybeAutoConspectus(id) {
  let c;
  try { c = conspectusCfg(); } catch { return; }
  if (c.trigger === "manual") return;
  if (conspectusJobs.get(id)?.state === "working") return; // уже собирается
  const lec = stmts.lectureGet.get(id);
  if (!lec) return; // сессию успели удалить
  const w = transcriptWeight(id);
  if (!w.chars) return; // распознанных слов нет
  if (c.trigger === "smart") {
    if (w.chars < c.autoMinChars) {
      logger.action("lecture.conspectus.skip", { id, chars: w.chars, min: c.autoMinChars, why: "too_short" });
      return;
    }
    if (lec.conspectus_at && !conspectusStale(lec, w.chars)) {
      logger.action("lecture.conspectus.skip", { id, chars: w.chars, prev: Number(lec.conspectus_len) || 0, why: "nothing_new" });
      return;
    }
  }
  logger.action("lecture.conspectus.auto", { id, chars: w.chars, trigger: c.trigger });
  // Ошибку авто-сборки не «выбрасываем в никуда»: она остаётся в conspectusJobs
  // (state=error) и видна панели, а сама лекция уже сохранена в архиве.
  void generateConspectus(id).catch((e) => {
    logger.error("lecture.conspectus.auto.error", { id, error: String(e?.message || e) });
  });
}

/**
 * Авто-диаризация после остановки записи (настройка diarizeEnabled).
 *
 * По умолчанию ВЫКЛЮЧЕНА: разбор длинной лекции — это минуты процессора, и
 * запускать его молча после каждой записи нельзя. Когда включена — расчёт идёт
 * в фоне, а прогресс виден на странице (GET /api/lecture/:id/diarize).
 */
function maybeAutoDiarize(id) {
  let c;
  try { c = cfg(); } catch { return; }
  if (c.diarizeEnabled !== true) return;
  if (diarize.diarizeState(id).state === "working") return;
  // Пакет не скачан — молча ничего не делаем: о необходимости скачать сообщит
  // панель «Говорящие», а не ошибка в логе после каждой лекции.
  if (!diarize.installed().ready) return;
  const hasText = stmts.chunkFor.all(id).some((x) => String(x.text || "").trim());
  if (!hasText) return;
  try {
    diarize.startDiarize(id);
    logger.action("lecture.diarize.auto", { id });
  } catch (e) {
    logger.error("lecture.diarize.auto", { id, error: String(e?.message || e) });
  }
}

/** Разбить расшифровку на блоки с таймкодами, не разрывая предложения. */
function transcriptBlocks(chunks, chunkChars, overlapChars, maxChunks) {
  const segments = chunks
    .filter((c) => String(c.text || "").trim())
    .map((c) => ({ at: Number(c.start_ms) || 0, text: String(c.text).replace(/\s+/g, " ").trim() }))
    .sort((a, b) => a.at - b.at);
  const blocks = [];
  let cur = [];
  let size = 0;
  for (const s of segments) {
    const line = `[${fmtTs(s.at)}] ${s.text}`;
    if (size + line.length > chunkChars && cur.length) {
      // «Шов»: хвост предыдущего блока уходит в следующий запрос как контекст,
      // иначе фраза, разрезанная границей блока, теряет смысл.
      const tail = overlapChars > 0 ? String(cur[cur.length - 1]).slice(-overlapChars) : "";
      blocks.push(cur.join("\n"));
      cur = tail ? [`(...продолжение предыдущего фрагмента: ${tail})`] : [];
      size = cur.length ? cur[0].length : 0;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length) blocks.push(cur.join("\n"));
  // Предохранитель: многочасовая лекция не должна запускать сотни запросов.
  const truncated = blocks.length > maxChunks;
  return { blocks: blocks.slice(0, maxChunks), truncated, total: blocks.length };
}

/** Один вызов модели: собираем поток целиком (панель ждёт готовый конспект). */
async function askModel(target, prompt, appPage, maxTokens) {
  const text = await runWithPage(appPage, () => target.provider.chat({
    secret: target.secret,
    model: target.model,
    messages: [
      { role: "system", text: "Ты помогаешь студенту с конспектами лекций. Пиши по-русски, только по тексту." },
      { role: "user", text: prompt },
    ],
    temperature: target.cfg.temperature,
    maxTokens: maxTokens || 3000,
    stream: true,
  }));
  return String(text || "").trim();
}

/** Состояние сборки конспекта (для прогресса в UI). */
const conspectusJobs = new Map();
function conspectusState(id) {
  const job = conspectusJobs.get(id);
  const lec = stmts.lectureGet.get(id);
  const w = lec ? transcriptWeight(id) : { chars: 0, chunks: [] };
  let c = null;
  try { c = conspectusCfg(); } catch { /* настройки ещё не читаются — отдаём базовое */ }
  return {
    ...(job || {
      state: "idle", progress: 0, total: 0, phase: "", model: "", error: "", truncated: false, at: 0,
    }),
    // Режим и «устаревание» для панели: в ручном режиме авто-сборки не будет,
    // а stale честно говорит, что после сборки расшифровка заметно выросла.
    trigger: c?.trigger || "smart",
    providerId: c?.providerId || "",
    autoMinChars: c?.autoMinChars ?? 0,
    transcriptChars: w.chars,
    conspectusAt: lec?.conspectus_at || "",
    stale: conspectusStale(lec, w.chars),
  };
}

/**
 * Собрать конспект лекции: блоки → черновые заметки → общий конспект.
 * Прогресс доступен на GET /:id/conspectus, пока идёт сборка.
 */
async function generateConspectus(id, opts = {}) {
  const { appPage = null, target: injected = null } = opts;
  const st = getStatus(id);
  if (!st) throw new Error("session_not_found");
  if (!st.chunks.some((c) => String(c.text || "").trim())) throw new Error("no_transcript_yet");
  if (conspectusJobs.get(id)?.state === "working") throw new Error("conspectus_busy");

  const c = injected?.cfg ? { ...conspectusCfg(), ...injected.cfg } : conspectusCfg();
  const { blocks, truncated, total } = transcriptBlocks(st.chunks, c.chunkChars, c.overlapChars, c.maxChunks);
  const started = Date.now();
  const setJob = (patch) => conspectusJobs.set(id, { ...conspectusState(id), ...patch });
  setJob({
    state: "working", progress: 0, total: blocks.length, phase: "notes",
    model: "", error: "", truncated, at: started,
  });
  try {
    // target можно внедрить (тесты и локальные модели): тогда ключ/провайдер не нужны.
    const target = injected || await conspectusTarget(appPage);
    setJob({ model: target.model });

    // --- Первый проход: черновые заметки по каждому блоку ---
    const notes = [];
    for (let i = 0; i < blocks.length; i++) {
      const part = await askModel(target, CHUNK_PROMPT + blocks[i], appPage);
      if (part) notes.push(`### Фрагмент ${i + 1}\n${part}`);
      setJob({ progress: i + 1, phase: "notes" });
    }
    if (!notes.length) throw new Error("conspectus_empty_response");

    // --- Второй проход: свести заметки в один конспект ---
    setJob({ phase: "merge", progress: 0, total: 1 });
    const merged = notes.join("\n\n");
    let markdown;
    if (merged.length <= c.chunkChars * 2) {
      markdown = await askModel(target, MERGE_PROMPT + merged, appPage, 4000);
    } else {
      // Заметки не влезли в один запрос → сворачиваем группами, затем финал.
      const groups = [];
      let cur = "";
      for (const n of notes) {
        if (cur.length + n.length > c.chunkChars && cur) { groups.push(cur); cur = ""; }
        cur += (cur ? "\n\n" : "") + n;
      }
      if (cur) groups.push(cur);
      const condensed = [];
      for (let i = 0; i < groups.length; i++) {
        condensed.push(await askModel(
          target,
          `Сожми заметки по фрагментам лекции, сохранив все термины, формулы и вопросы.\n=== ЗАМЕТКИ ===\n${groups[i]}`,
          appPage, 3000,
        ));
        setJob({ progress: i + 1, total: groups.length });
      }
      markdown = await askModel(target, MERGE_PROMPT + condensed.join("\n\n"), appPage, 4000);
    }
    markdown = String(markdown || "").trim();
    if (!markdown) throw new Error("conspectus_empty_response");

    const lec = stmts.lectureGet.get(id);
    stmts.lectureUpdate.run(id, {
      notes: (lec?.notes ? lec.notes + "\n\n" : "") + markdown,
      // Метаданные авто-режима: когда собрали и по какой длине расшифровки.
      // Без них smart-режим не отличал бы «нового текста нет» от «лекция
      // дочитана» и платил бы за повторную сборку на каждый чанк.
      conspectus_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      conspectus_len: transcriptWeight(id).chars,
    });
    // Конспект сразу уходит в .md файл лекции: и при нажатии кнопки «ИИ-конспект»,
    // и в авто-режиме (maybeAutoConspectus → generateConspectus) — файл
    // перезаписывается тем же, а не заводится заново (см. syncNotesFile).
    syncNotesFileSafe(id, "conspectus");
    logger.action("lecture.conspectus", {
      id, provider: target.provider.id, model: target.model,
      blocks: blocks.length, chars: markdown.length, ms: Date.now() - started, truncated,
    });
    setJob({
      state: "done", progress: blocks.length, total: blocks.length, phase: "done",
      model: target.model, error: "",
    });
    return {
      markdown, model: `${target.provider.id}/${target.model}`,
      blocks: blocks.length, truncated, ofTotal: total,
    };
  } catch (e) {
    const msg = String(e?.message || e);
    setJob({ state: "error", phase: "", error: msg });
    logger.error("lecture.conspectus.error", { id, error: msg });
    throw e;
  }
}

/* ------------------------- Проверка пропусков ------------------------- */

/**
 * «Проверить пропуски»: повторная расшифровка того, что VAD/Whisper потеряли.
 *
 * Зачем: при шумном входе чанки молча отбрасывались, и лекция оставалась с
 * дырами без объяснения. Здесь мы идём по raw.wav, находим участки, НЕ покрытые
 * удачными чанками, и прогоняем их чувствительным VAD + Whisper.
 */
const rechecks = new Map(); // id → состояние прогона

function recheckState(id) {
  return rechecks.get(id) || {
    state: "idle", progress: 0, total: 0, found: 0, restored: 0,
    error: "", at: 0, truncated: false,
  };
}

/** Интервалы удачных чанков (status=done) в миллисекундах. */
function transcribedSpans(id, padMs = 300) {
  return stmts.chunkFor.all(id)
    .filter((c) => c.status === "done")
    .map((c) => [Math.max(0, c.start_ms - padMs), c.end_ms + padMs])
    .sort((a, b) => a[0] - b[0]);
}

/** Вычитает покрытие из [0, totalMs] → список «дыр» (не короче 1.5 с). */
function gapsOf(totalMs, spans) {
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s > cursor) gaps.push([cursor, Math.min(s, totalMs)]);
    cursor = Math.max(cursor, e);
    if (cursor >= totalMs) break;
  }
  if (cursor < totalMs) gaps.push([cursor, totalMs]);
  return gaps.filter(([s, e]) => e - s >= 1500);
}

/** PCM дорожки из raw-wav (без 44-байтного заголовка) + параметры файла. */
function readRawTrack(id, file) {
  const p = path.join(sessionDir(id), path.basename(file));
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  if (buf.length <= 44) return null;
  const sampleRate = buf.readUInt32LE(24) || 16000;
  const channels = buf.readUInt16LE(22) || 1;
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.floor((buf.length - 44) / 2));
  return { pcm, sampleRate, channels, path: p };
}

/**
 * Запустить проверку пропусков (асинхронно; прогресс — GET /:id/recheck).
 * Ограничения, чтобы не убить ноутбук: не больше 60 минут аудио и 300 чанков за
 * прогон — остальное помечается truncated, и проверку можно повторить.
 */
function startRecheck(id, opts = {}) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) throw new Error("session_not_found");
  if (sessions.has(id)) throw new Error("session_live");
  const running = rechecks.get(id);
  if (running && running.state === "working") throw new Error("recheck_busy");

  const raw = readRawTrack(id, lec.raw_file || "raw.wav");
  if (!raw) throw new Error("raw_audio_missing");
  const totalMs = Math.round((raw.pcm.length / raw.sampleRate) * 1000);
  const gaps = gapsOf(totalMs, transcribedSpans(id));
  const maxMs = Number(opts.maxMinutes ?? 60) * 60000;
  const maxChunks = Number(opts.maxChunks ?? 300);

  const st = {
    state: "working", progress: 0, total: gaps.length, found: 0, restored: 0,
    error: "", at: Date.now(), truncated: false,
  };
  rechecks.set(id, st);
  logger.action("lecture.recheck.start", { id, gaps: gaps.length, totalMs });

  void (async () => {
    // Чувствительные параметры: порог втрое ниже, автоподстройка выключена
    // (нужен низкий порог, а не «подстройка под шум»), ZCR-гейт остаётся —
    // иначе на шумной записи мы снова примем шум за речь.
    const c = cfg();
    const sensitive = new VadBufferManager({
      ...vadOptions(c, raw.sampleRate),
      rmsThreshold: Math.max(0.0012, Number(c.vadRmsThreshold ?? 0.008) / 3),
      adaptive: false,
      minSpeechRatio: 0.06,
      minChunkMs: 2000,
      silenceMs: 600,
      forceSplitMs: 15000,
    });
    let spentMs = 0;
    try {
      for (let gi = 0; gi < gaps.length; gi++) {
        if (st.state !== "working") break;
        const [gs, ge] = gaps[gi];
        if (spentMs >= maxMs || st.found >= maxChunks) { st.truncated = true; break; }
        const from = Math.floor((gs / 1000) * raw.sampleRate);
        const to = Math.min(raw.pcm.length, Math.ceil((ge / 1000) * raw.sampleRate));
        // pass() прогоняет отрезок с АБСОЛЮТНЫМ таймкодом: иначе все найденные
        // чанки получили бы время от нуля и «уехали» на таймлайне лекции.
        const produced = sensitive.pass(raw.pcm.subarray(from, to), gs);
        spentMs += ge - gs;
        for (const chunk of produced) {
          const idx = nextIdx(id);
          const file = `recheck_${String(idx).padStart(5, "0")}.wav`;
          fs.writeFileSync(path.join(sessionDir(id), file), toWav(chunk.samples, raw.sampleRate, 1));
          const info = stmts.chunkInsert.run(id, idx, chunk.startMs, chunk.endMs, file, {
            source: "recheck",
            reason: chunk.reason || "",
            rmsDb: chunk.rmsDb ?? -100,
            rmsPeakDb: chunk.rmsPeakDb ?? -100,
            speechRatio: chunk.speechRatio ?? 0,
            noiseFloorDb: chunk.noiseFloorDb ?? -100,
            thresholdDb: chunk.thresholdDb ?? -100,
            zcr: chunk.zcrMean ?? 0,
          });
          st.found++;
          const item = {
            chunkId: Number(info.lastInsertRowid), file,
            startMs: chunk.startMs, endMs: chunk.endMs, source: "recheck",
          };
          try {
            const r = await transcribeChunk(id, item);
            if (r.text) st.restored++;
          } catch (e) {
            stmts.chunkUpdate.run(item.chunkId, { status: "error", error: String(e.message || e).slice(0, 300) });
          }
        }
        st.progress = gaps.length ? Math.round(((gi + 1) / gaps.length) * 100) : 100;
      }
      st.state = "done";
      logger.action("lecture.recheck.done", { id, found: st.found, restored: st.restored, truncated: st.truncated });
      // Повторная проверка могла добыть новые куски текста: в smart-режиме это
      // законный повод пересобрать конспект (он помечается stale — см. conspectusStale).
      if (st.restored > 0) maybeAutoConspectus(id);
    } catch (e) {
      st.state = "error";
      st.error = String(e?.message || e);
      logger.error("lecture.recheck", { id, error: st.error });
    }
  })();

  return recheckState(id);
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
function setAudioSettings(patch = {}) {
  const c = cfg();
  const next = {};
  const num = (v, lo, hi, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  };
  if (patch.micDeviceId !== undefined) next.micDeviceId = String(patch.micDeviceId || "").slice(0, 200);
  if (patch.micGain !== undefined) next.micGain = num(patch.micGain, 0.5, 4, Number(c.micGain ?? 1));
  if (patch.micAgc !== undefined) next.micAgc = !!patch.micAgc;
  const v = patch.vad || {};
  if (v.rmsThreshold !== undefined) next.vadRmsThreshold = num(v.rmsThreshold, 0.0005, 0.2, Number(c.vadRmsThreshold));
  if (v.adaptive !== undefined) next.vadAdaptive = !!v.adaptive;
  if (v.thresholdFactor !== undefined) next.vadThresholdFactor = num(v.thresholdFactor, 1.5, 12, Number(c.vadThresholdFactor));
  if (v.minSpeechRatio !== undefined) next.vadMinSpeechRatio = num(v.minSpeechRatio, 0, 1, Number(c.vadMinSpeechRatio));
  if (v.zcrGate !== undefined) next.vadZcrGate = !!v.zcrGate;
  if (Object.keys(next).length) settings.set({ lecture: next });
  logger.action("lecture.audio.settings", next);
  return audioSettings();
}

/* ------------------------- Аудио ------------------------- */

function chunkAudioPath(chunkId) {
  const c = stmts.chunkGet.get(chunkId);
  if (!c) return null;
  return path.join(sessionDir(c.lecture_id), c.file);
}

function rawAudioPath(id, track = "mic") {
  const lec = stmts.lectureGet.get(id);
  if (!lec) return null;
  const name = track === "sys" ? "raw_sys.wav" : (lec.raw_file || "raw.wav");
  const p = path.join(sessionDir(id), path.basename(name));
  return fs.existsSync(p) ? p : null;
}

module.exports = {
  createSession, ingest, getStatus, stopSession, deleteSession,
  updateChunkText, setNotes, addMarker, engineStatus,
  exportContent, generateConspectus, conspectusState, chunkAudioPath, rawAudioPath,
  audioSettings, setAudioSettings, startRecheck, recheckState,
  recoverInterrupted,
  // Заголовок выгрузки: кириллические имена файлов (см. contentDisposition).
  contentDisposition,
  // Настройки конспекта и выбор провайдера (панель «ИИ-конспект»).
  conspectusSettings, setConspectusSettings, conspectusProviders, providerModels,
  maybeAutoConspectus, transcriptWeight, conspectusStale, // переиспользуется в тестах
  // Зеркало заметок лекций в storage/notes (см. syncNotesFile). backfillNotesFiles
  // зовёт server/index.js при старте — он заводит .md для лекций, записанных до
  // появления синхронизации; экспорт — для тестов.
  backfillNotesFiles,
  sanitizeText, parseSrt, transcriptBlocks, // переиспользуется в тестах
};

