/**
 * Выделено из lecture.ts при разбиении крупного файла (поведение не менялось).
 */
import { stmts } from "./db";
import path from "path";
import fs from "fs";
import logger from "./logger";
import { VadBufferManager } from "./vad";
import { cfg, nextIdx, sessionDir, sessions, toWav, transcribeChunk, vadOptions } from "./lecture";
import { maybeAutoConspectus } from "./lectureConspectus";

/* ------------------------- Проверка пропусков ------------------------- */

/**
 * «Проверить пропуски»: повторная расшифровка того, что VAD/Whisper потеряли.
 *
 * Зачем: при шумном входе чанки молча отбрасывались, и лекция оставалась с
 * дырами без объяснения. Здесь мы идём по raw.wav, находим участки, НЕ покрытые
 * удачными чанками, и прогоняем их чувствительным VAD + Whisper.
 */
const rechecks = new Map(); // id → состояние прогона

export function recheckState(id: any) {
  return (
    rechecks.get(id) || {
      state: "idle",
      progress: 0,
      total: 0,
      found: 0,
      restored: 0,
      error: "",
      at: 0,
      truncated: false,
    }
  );
}

/** Интервалы удачных чанков (status=done) в миллисекундах. */
function transcribedSpans(id: any, padMs = 300) {
  return stmts.chunkFor
    .all(id)
    .filter((c) => c.status === "done")
    .map((c) => [Math.max(0, c.start_ms - padMs), c.end_ms + padMs])
    .sort((a, b) => a[0] - b[0]);
}

/** Вычитает покрытие из [0, totalMs] → список «дыр» (не короче 1.5 с). */
function gapsOf(totalMs: any, spans: any) {
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
function readRawTrack(id: any, file: any) {
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
export function startRecheck(id: any, opts: Record<string, any> = {}) {
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
    state: "working",
    progress: 0,
    total: gaps.length,
    found: 0,
    restored: 0,
    error: "",
    at: Date.now(),
    truncated: false,
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
        if (spentMs >= maxMs || st.found >= maxChunks) {
          st.truncated = true;
          break;
        }
        const from = Math.floor((gs / 1000) * raw.sampleRate);
        const to = Math.min(raw.pcm.length, Math.ceil((ge / 1000) * raw.sampleRate));
        // pass() прогоняет отрезок с АБСОЛЮТНЫМ таймкодом: иначе все найденные
        // чанки получили бы время от нуля и «уехали» на таймлайне лекции.
        const produced = sensitive.pass(raw.pcm.subarray(from, to), gs);
        spentMs += ge - gs;
        for (const chunk of produced) {
          const idx = nextIdx(id);
          const file = `recheck_${String(idx).padStart(5, "0")}.wav`;
          fs.writeFileSync(
            path.join(sessionDir(id), file),
            toWav(chunk.samples, raw.sampleRate, 1),
          );
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
            chunkId: Number(info.lastInsertRowid),
            file,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            source: "recheck",
          };
          try {
            const r = await transcribeChunk(id, item);
            if (r.text) st.restored++;
          } catch (e: any) {
            stmts.chunkUpdate.run(item.chunkId, {
              status: "error",
              error: String(e.message || e).slice(0, 300),
            });
          }
        }
        st.progress = gaps.length ? Math.round(((gi + 1) / gaps.length) * 100) : 100;
      }
      st.state = "done";
      logger.action("lecture.recheck.done", {
        id,
        found: st.found,
        restored: st.restored,
        truncated: st.truncated,
      });
      // Повторная проверка могла добыть новые куски текста: в smart-режиме это
      // законный повод пересобрать конспект (он помечается stale — см. conspectusStale).
      if (st.restored > 0) maybeAutoConspectus(id);
    } catch (e: any) {
      st.state = "error";
      st.error = String(e?.message || e);
      logger.error("lecture.recheck", { id, error: st.error });
    }
  })();

  return recheckState(id);
}
