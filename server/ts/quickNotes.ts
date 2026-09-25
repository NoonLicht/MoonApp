/**
 * Быстрые голосовые заметки: «наговорил идею → получил текст», без полного
 * пайплайна лекций (VAD-чанкование, диаризация, конспект). Переиспользует
 * УЖЕ существующую инфраструктуру распознавания:
 *   - server/whisperEngine.js — та же модель/сборка whisper.cpp, что и на
 *     странице «Лекторий» (findBin/findModel/transcribeArgs);
 *   - server/lecture.js → transcribeFile() — тот же прогон с откатом без
 *     --prompt, уже покрытый тестами лекций.
 * Если whisper не установлен — честная ошибка с указанием, что нужно зайти
 * на страницу «Лекторий» и поставить движок/модель там (единая точка
 * настройки, дублировать её здесь не нужно).
 *
 * Запись пишется браузерным MediaRecorder в любой формат, который Chromium
 * отдаёт (обычно webm/opus) — на сервере ffmpeg конвертирует её в 16кГц моно
 * WAV, который принимает whisper.cpp.
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import { detectFfmpeg } from "./convertEngine";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const whisperEngine = require("./whisperEngine") as {
  findBin(): string | null;
  findModel(): string | null;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lecture = require("./lecture") as {
  transcribeFile(
    bin: string,
    model: string,
    wavPath: string,
    outBase: string,
  ): Promise<{ text: string; segments: unknown[] }>;
};

const { DIRS, FILES } = config;

export interface QuickNote {
  id: string;
  text: string;
  audioFile: string | null;
  durationSec: number | null;
  createdAt: number;
  /** Текст, оформленный ИИ в Markdown по кнопке "Структурировать" (null — не оформлялась). */
  structuredText: string | null;
}

function readAll(): QuickNote[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.quickNotesIndex, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(items: QuickNote[]): void {
  fs.writeFileSync(FILES.quickNotesIndex, JSON.stringify(items, null, 2), "utf8");
}

export function list(): QuickNote[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

/** Сохраняет результат ИИ-структурирования (кнопка "Структурировать в Markdown"). */
export function setStructuredText(id: string, structuredText: string): QuickNote | null {
  const all = readAll();
  const idx = all.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], structuredText };
  writeAll(all);
  return all[idx];
}

export function remove(id: string): boolean {
  const all = readAll();
  const note = all.find((x) => x.id === id);
  if (!note) return false;
  if (note.audioFile) {
    try {
      fs.rmSync(path.join(DIRS.quickNotes, note.audioFile), { force: true });
    } catch {
      /* ignore */
    }
  }
  writeAll(all.filter((x) => x.id !== id));
  return true;
}

function toWav16kMono(ffmpegBin: string, inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegBin,
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outPath],
      { windowsHide: true },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(`ffmpeg_exit_${code}: ${stderr.slice(-300)}`));
    });
  });
}

export interface TranscribeInput {
  audioPath: string;
  originalExt: string;
  keepAudio: boolean;
}

/** Конвертирует запись в WAV, распознаёт текст, сохраняет заметку в индекс. */
export async function transcribeAndSave(input: TranscribeInput): Promise<QuickNote> {
  const ff = await detectFfmpeg();
  if (!ff.found || !ff.ffmpeg) throw new Error("ffmpeg_not_found");

  const bin = whisperEngine.findBin();
  const model = whisperEngine.findModel();
  if (!bin || !model) throw new Error("whisper_not_installed");

  const id = crypto.randomUUID();
  const wavPath = path.join(DIRS.quickNotesTmp, `${id}.wav`);
  const outBase = path.join(DIRS.quickNotesTmp, id);

  try {
    await toWav16kMono(ff.ffmpeg, input.audioPath, wavPath);
    const result = await lecture.transcribeFile(bin, model, wavPath, outBase);

    let audioFile: string | null = null;
    if (input.keepAudio) {
      audioFile = `${id}${input.originalExt}`;
      fs.copyFileSync(input.audioPath, path.join(DIRS.quickNotes, audioFile));
    }

    const durationSec = probeWavDurationSec(wavPath);
    const note: QuickNote = {
      id,
      text: result.text,
      audioFile,
      durationSec,
      createdAt: Date.now(),
      structuredText: null,
    };
    const all = readAll();
    all.unshift(note);
    writeAll(all);
    logger.info("quickNotes.transcribeAndSave", { id, chars: result.text.length, kept: !!audioFile });
    return note;
  } finally {
    fs.rmSync(wavPath, { force: true });
    fs.rmSync(`${outBase}.srt`, { force: true });
  }
}

/** Длительность WAV из заголовка (без внешних либ) — байты данных / байт-в-секунду. */
function probeWavDurationSec(wavPath: string): number | null {
  try {
    const buf = fs.readFileSync(wavPath);
    if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      return null;
    }
    // Честный обход чанков — ffmpeg иногда пишет доп. чанки (LIST/fmt с
    // расширениями), из-за чего фиксированные офсеты 28/40 у "простого"
    // 44-байтного заголовка съезжают.
    let byteRate = 0;
    let dataSize = 0;
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === "fmt " && body + 16 <= buf.length) byteRate = buf.readUInt32LE(body + 8);
      else if (id === "data") dataSize = size;
      offset = body + size + (size % 2); // чанки выровнены по чётной границе
    }
    if (!byteRate || !dataSize) return null;
    return Math.round((dataSize / byteRate) * 10) / 10;
  } catch {
    return null;
  }
}
