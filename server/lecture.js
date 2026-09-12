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
const http = require("http");
const { DIRS } = require("./config");
const { stmts } = require("./db");
const settings = require("./settings");
const logger = require("./logger");
const { VadBufferManager } = require("./vad");

/** Типовые галлюцинации Whisper на тишине/шуме — вырезаем из результата. */
const HALLUCINATION_RE = [
  /^спасибо за просмотр[!.]?$/i,
  /^подпиш(ись|итесь)[!.]?$/i,
  /^amara\.org$/i,
  /^продолжение следует/i,
  /^до новых встреч[!.]?$/i,
  /^\W*$/,
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

function findWhisperBin() {
  const c = cfg();
  if (c.whisperBin && fs.existsSync(c.whisperBin)) return c.whisperBin;
  const candidates = [
    path.join(DIRS.storage, "whisper", "whisper-cli.exe"),
    path.join(DIRS.storage, "whisper", "main.exe"),
    path.join(__dirname, "vendor", "whisper", "whisper-cli.exe"),
    path.join(__dirname, "vendor", "whisper", "main.exe"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function findModel() {
  const c = cfg();
  if (c.model && fs.existsSync(c.model)) return c.model;
  const dir = path.join(DIRS.storage, "whisper", "models");
  try {
    const models = fs.readdirSync(dir).filter((f) => /^ggml-.*\.bin$/i.test(f)).sort();
    // Приоритет: small → base → tiny (ноутбук Ryzen 5 / Radeon 740M iGPU).
    const pref = models.find((m) => /small/i.test(m)) || models.find((m) => /base/i.test(m)) || models[0];
    return pref ? path.join(dir, pref) : null;
  } catch { return null; }
}

/** Статус движка для UI (Vulkan-сборка whisper.cpp GPU берёт сама, без флагов). */
function engineStatus() {
  const bin = findWhisperBin();
  const model = findModel();
  return {
    ready: !!(bin && model),
    bin, model,
    backend: bin ? guessBackend(bin) : null, // vulkan | cpu(openblas/avx2)
    language: cfg().language,
    activeSession: sessions.size > 0,
  };
}

function guessBackend(bin) {
  try {
    const dir = path.dirname(bin);
    if (fs.existsSync(path.join(dir, "ggml-vulkan.dll"))) return "vulkan";
    if (fs.existsSync(path.join(dir, "whisper.dll"))) return "cpu/openblas";
  } catch { /* ignore */ }
  return "cpu";
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
  const rawFile = path.join(dir, "raw.wav");
  // Header с нулевой длиной данных; дозаписываем PCM и чиним header в finalize.
  fs.writeFileSync(rawFile, writeWavHeader(0, sr, ch));
  sessions.set(id, {
    vads: new VadBufferManager({
      sampleRate: sr,
      silenceMs: lc.vadSilenceMs,
      minChunkMs: lc.vadMinChunkMs,
      maxChunkMs: lc.vadMaxChunkMs,
      forceSplitMs: lc.vadForceSplitMs,
      padMs: lc.vadPadMs,
    }),
    rawFd: fs.openSync(rawFile, "r+"),
    rawFile,
    sampleRate: sr,
    channels: ch,
    pcmWritten: 0,
    ingestBytes: 0,
    queue: [],
    transcribing: false,
    lastError: "",
    startedAt: Date.now(),
  });
  stmts.lectureUpdate.run(id, { raw_file: path.basename(rawFile) });
  logger.action("lecture.session.start", { id, sampleRate: sr, channels: ch });
  return { id, sampleRate: sr, channels: ch, vad: vadConfig(lc), whisper: engineStatus() };
}

function vadConfig(c) {
  return {
    silenceMs: c.vadSilenceMs, minChunkMs: c.vadMinChunkMs,
    maxChunkMs: c.vadMaxChunkMs, forceSplitMs: c.vadForceSplitMs, padMs: c.vadPadMs,
  };
}

/** Приём PCM (Int16 LE, моно 16k). Возвращает статус очереди (без ожидания транскрипции). */
function ingest(id, buf) {
  const s = sessions.get(id);
  if (!s) throw new Error("session_not_found");
  s.ingestBytes += buf.length;
  // Fail-safe: непрерывный raw WAV на диск (защита от падения приложения/системы).
  fs.writeSync(s.rawFd, buf);
  s.pcmWritten += buf.length / 2;
  // VAD-нарезка → очередь транскрипции.
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const closed = s.vads.push(pcm);
  for (const chunk of closed) enqueueChunk(id, chunk);
  return {
    pending: s.queue.length,
    stats: s.vads.stats,
    elapsedMs: Date.now() - s.startedAt,
    recordingSec: Math.round(s.pcmWritten / s.sampleRate),
  };
}

function enqueueChunk(id, chunk) {
  const s = sessions.get(id);
  if (!s) return;
  const dir = sessionDir(id);
  const chunks = stmts.chunkFor.all(id);
  const idx = (chunks.length ? chunks[chunks.length - 1].idx : 0) + 1;
  const base = `chunk_${String(idx).padStart(5, "0")}.wav`;
  fs.writeFileSync(path.join(dir, base), toWav(chunk.samples, s.sampleRate, 1));
  const info = stmts.chunkInsert.run(id, idx, chunk.startMs, chunk.endMs, base);
  s.queue.push({ chunkId: Number(info.lastInsertRowid), file: base, startMs: chunk.startMs, endMs: chunk.endMs });
  pumpQueue(id);
}


/* ------------------------- Транскрипция (whisper.cpp) ------------------------- */

function pumpQueue(id) {
  const s = sessions.get(id);
  if (!s || s.transcribing) return;
  const item = s.queue[0];
  if (!item) return;
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
      if (sessions.has(id)) pumpQueue(id);
    });
}

function transcribeChunk(id, item) {
  return new Promise((resolve, reject) => {
    const bin = findWhisperBin();
    const model = findModel();
    const c = cfg();
    if (!bin || !model) {
      const err = new Error(bin ? "whisper_model_missing" : "whisper_not_installed");
      if (item.chunkId) stmts.chunkUpdate.run(item.chunkId, { status: "error", error: err.message });
      return reject(err);
    }
    const wavPath = path.join(sessionDir(id), item.file);
    const outBase = wavPath.replace(/\.wav$/i, "");
    const args = [
      "-m", model,
      "-f", wavPath,
      "-l", c.language || "ru",
      "-np", "-nt",          // тихий вывод, только текст
      "-t", String(Math.max(1, Math.min(8, Number(c.threads) || 4))),
      "--prompt", c.initialPrompt || "",
      "-of", outBase,
      "-osrt",               // сегменты с таймингами (для сабов и склейки)
    ];
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
      if (item.chunkId) stmts.chunkUpdate.run(item.chunkId, { text, status: text ? "done" : "empty", error: "" });
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
  // Схлопывание циклов: "а б а б а б" → "а б"
  const words = t.split(" ");
  for (let n = 1; n <= 6; n++) {
    let changed = false;
    for (let i = 0; i + 2 * n <= words.length; i++) {
      const a = words.slice(i, i + n).join(" ").toLowerCase();
      let j = i + n;
      while (j + n <= words.length && words.slice(j, j + n).join(" ").toLowerCase() === a) j += n;
      if (j > i + n) { words.splice(i + n, j - (i + n)); changed = true; break; }
    }
    if (!changed) break;
  }
  return words.join(" ").trim();
}

function parseSrt(srt) {
  const out = [];
  for (const block of String(srt).replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const m = lines.find((l) => l.includes("-->"));
    if (!m) continue;
    const [a, b] = m.split("-->").map((x) => x.trim().split(",")[0]);
    const text = lines.slice(lines.indexOf(m) + 1).join(" ").trim();
    out.push({ start: srtTimeToSec(a), end: srtTimeToSec(b), text });
  }
  return out;
}

function srtTimeToSec(t) {
  const [h, m, s] = String(t).split(":").map((x) => parseFloat(x) || 0);
  return h * 3600 + m * 60 + s;
}


/* ------------------------- Статусы / правки ------------------------- */

function getStatus(id) {
  const lecture = stmts.lectureGet.get(id);
  if (!lecture) return null;
  const s = sessions.get(id);
  return {
    lecture,
    chunks: stmts.chunkFor.all(id),
    live: !!s,
    queue: s ? s.queue.length : 0,
    transcribing: s ? s.transcribing : false,
    recordingSec: s ? Math.round(s.pcmWritten / s.sampleRate) : Math.round((lecture.duration_ms || 0) / 1000),
    vadStats: s ? s.vads.stats : null,
    lastError: s ? s.lastError : "",
    whisper: engineStatus(),
  };
}

/** Click-to-edit: правка текста чанка прямо из телепромтера. */
function updateChunkText(chunkId, text) {
  stmts.chunkUpdate.run(chunkId, { text: String(text || "").slice(0, 20000) });
  return stmts.chunkGet.get(chunkId);
}

/** Маркер «важного» (Ctrl+B / F2) — Obsidian-чекбокс с таймкодом в notes. */
function addMarker(id, atMs, label) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) return null;
  const ts = fmtTs(atMs || 0);
  const note = `${lec.notes ? lec.notes + "\n" : ""}- [ ] **[${ts}]** ${String(label || "Важное").slice(0, 300)}`;
  stmts.lectureUpdate.run(id, { notes: note });
  return { atMs, timestamp: ts, label };
}

function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return getStatus(id);
  for (const chunk of s.vads.flush()) enqueueChunk(id, chunk);
  const durMs = Math.max(0, Date.now() - s.startedAt);
  try {
    // Чиним header raw.wav (реальный размер данных).
    fs.writeSync(s.rawFd, writeWavHeader(s.pcmWritten * 2, s.sampleRate, s.channels), 0, 44, 0);
  } catch { /* файл всё равно играбелен большинством плееров */ }
  try { fs.closeSync(s.rawFd); } catch { /* ignore */ }
  sessions.delete(id);
  stmts.lectureUpdate.run(id, { status: "stopped", ended_at: new Date().toISOString().replace("T", " ").slice(0, 19), duration_ms: durMs });
  logger.action("lecture.session.stop", { id, durMs });
  return getStatus(id);
}

function deleteSession(id) {
  stopSession(id);
  stmts.lectureDelete.run(id);
  try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
  logger.action("lecture.session.delete", { id });
  return true;
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

function buildMarkdown(id) {
  const st = getStatus(id);
  if (!st) return "";
  const lines = [`# ${st.lecture.title}`, "", `> Запись от ${st.lecture.started_at} · длительность ${fmtTs(st.recordingSec * 1000)}`, ""];
  if (st.lecture.notes) lines.push("## Важное (маркеры)", "", st.lecture.notes, "");
  lines.push("## Расшифровка", "");
  for (const c of st.chunks) {
    if (c.text) lines.push(`**[${fmtTs(c.start_ms)}]** ${c.text}`, "");
  }
  return lines.join("\n");
}

function buildSrt(id) {
  const st = getStatus(id);
  if (!st) return "";
  let idx = 0;
  const out = [];
  for (const c of st.chunks) {
    if (!c.text) continue;
    const start = c.start_ms / 1000;
    const end = Math.max(c.end_ms / 1000, start + 1);
    out.push(`${++idx}`, `${fmtSrtTime(start)} --> ${fmtSrtTime(end)}`, c.text, "");
  }
  return out.join("\n");
}

function buildVtt(id) {
  const st = getStatus(id);
  if (!st) return "";
  const out = ["WEBVTT", ""];
  for (const c of st.chunks) {
    if (!c.text) continue;
    const start = c.start_ms / 1000;
    const end = Math.max(c.end_ms / 1000, start + 1);
    out.push(`${fmtVttTime(start)} --> ${fmtVttTime(end)}`, c.text, "");
  }
  return out.join("\n");
}

function exportContent(id, format) {
  if (format === "srt") return { mime: "application/x-subrip", body: buildSrt(id), name: `lecture_${id}.srt` };
  if (format === "vtt") return { mime: "text/vtt", body: buildVtt(id), name: `lecture_${id}.vtt` };
  return { mime: "text/markdown", body: buildMarkdown(id), name: `${safeName(getStatus(id)?.lecture.title || "lecture")}.md` };
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "lecture";
}


/* ------------------------- AI-конспект (Ollama / GGUF локально) ------------------------- */

const CONSPECTUS_PROMPT = `Ты — академический ассистент. Ниже — расшифровка университетской лекции.
Составь структурированный конспект на русском в Markdown ровно в таком виде:

## Обзор
(2-4 абзаца: о чём лекция, логика изложения)

## Ключевые термины
| Термин | Определение |
|---|---|

## Основные теоремы и формулы
(нумерованный список; формулы в LaTeX-нотации $...$)

## Вопросы для подготовки к экзамену
1. (вопрос) — (краткий ожидаемый ответ)

Не выдумывай факты, которых нет в расшифровке. Пиши только по тексту.
=== РАСШИФРОВКА ===
`;

/** Оффлайн-конспект через локальный Ollama (http://127.0.0.1:11434). */
function generateConspectus(id) {
  const st = getStatus(id);
  if (!st) return Promise.reject(new Error("session_not_found"));
  const transcript = st.chunks.map((c) => c.text).filter(Boolean).join(" ").trim();
  if (!transcript) return Promise.reject(new Error("no_transcript_yet"));
  const model = cfg().ollamaModel || "llama3.2";
  const prompt = CONSPECTUS_PROMPT + transcript.slice(-14000);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3 } });
    const req = http.request({
      host: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 600000,
    }, (res) => {
      let raw = "";
      res.on("data", (d) => { raw += d; });
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          const md = String(j.response || "").trim();
          if (!md) return reject(new Error("ollama_empty_response"));
          // Сохраняем конспект в заметки лекции.
          const lec = stmts.lectureGet.get(id);
          stmts.lectureUpdate.run(id, { notes: (lec?.notes ? lec.notes + "\n\n" : "") + md });
          logger.action("lecture.conspectus", { id, model, chars: md.length });
          resolve({ markdown: md, model });
        } catch (e) { reject(new Error("ollama_bad_response: " + e.message)); }
      });
    });
    req.on("error", (e) => reject(new Error("ollama_unreachable: " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("ollama_timeout")); });
    req.write(body);
    req.end();
  });
}

/* ------------------------- Аудио ------------------------- */

function chunkAudioPath(chunkId) {
  const c = stmts.chunkGet.get(chunkId);
  if (!c) return null;
  return path.join(sessionDir(c.lecture_id), c.file);
}

function rawAudioPath(id) {
  const lec = stmts.lectureGet.get(id);
  if (!lec) return null;
  const p = path.join(sessionDir(id), path.basename(lec.raw_file || "raw.wav"));
  return fs.existsSync(p) ? p : null;
}

module.exports = {
  createSession, ingest, getStatus, stopSession, deleteSession,
  updateChunkText, addMarker, engineStatus,
  exportContent, generateConspectus, chunkAudioPath, rawAudioPath,
  sanitizeText, parseSrt, // переиспользуется в тестах
};

