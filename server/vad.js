"use strict";

/**
 * Smart VAD Buffer Manager (Zero Hallucination Protocol).
 *
 * Задача: нарезать поток PCM (Int16, моно 16 кГц) на чанки для Whisper так,
 * чтобы туда НИКОГДА не попадала чистая тишина, кашель и фоновый шум лекции —
 * именно они вызывают галлюцинационные повторы ("Спасибо за просмотр" и т.п.).
 *
 * Архитектурный паттерн — как в chidiwilliams/buzz:
 *   - фреймовый детектор речи (здесь: энергия + гистерезис, интерфейс готов
 *     к замене на Silero-VAD ONNX без изменений вызывающего кода);
 *   - буфер копит речь и закрывает чанк по паузе (silenceMs, 400..1200);
 *   - целевые чанки 7..18 c, принудительный мягкий сплит на forceSplitMs (25 c)
 *     по ближайшему локальному минимуму энергии (словная граница);
 *   - пре/пост-ролл паддинг 150 мс;
 *   - отбраковка слишком коротких/тихих фрагментов.
 */

const FRAME_MS = 30; // длительность фрейма VAD

class VadBufferManager {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate   (16000)
   * @param {number} opts.silenceMs    пауза для закрытия чанка (400..1200)
   * @param {number} opts.minChunkMs   целевой минимум чанка
   * @param {number} opts.maxChunkMs   целевой максимум чанка (мягкий сплит)
   * @param {number} opts.forceSplitMs принудительный сплит длинной речи
   * @param {number} opts.padMs        пре/пост-ролл
   * @param {number} opts.rmsThreshold порог речи (0..1, RMS Int16/32768)
   */
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 16000;
    this.silenceMs = clamp(opts.silenceMs ?? 700, 400, 1200);
    this.minChunkMs = clamp(opts.minChunkMs ?? 7000, 2000, 60000);
    this.maxChunkMs = clamp(opts.maxChunkMs ?? 18000, this.minChunkMs, 60000);
    this.forceSplitMs = Math.max(opts.forceSplitMs ?? 25000, this.maxChunkMs);
    this.padMs = clamp(opts.padMs ?? 150, 0, 500);
    this.rmsThreshold = clamp(opts.rmsThreshold ?? 0.008, 0.001, 0.5);

    this.frameSamples = Math.round((this.sampleRate * FRAME_MS) / 1000);
    this.frameBuf = new Int16Array(this.frameSamples);
    this.frameFill = 0;

    // Состояние буфера чанка
    this.pending = [];          // фреймы текущего чанка (Int16Array)
    this.speechFrames = [];     // фреймы речи (без тишины) текущего чанка
    this.chunkStartMs = 0;      // абсолютное время начала чанка
    this.chunkSpeechMs = 0;     // суммарная длительность речи в чанке
    this.lastSpeechMs = 0;
    this.silenceRunMs = 0;      // текущая серия тишины
    this.consecutiveSpeech = 0; // фреймов речи подряд (анти-щелчок)
    this.lastRms = [];          // окно RMS для поиска минимума (мягкий сплит)

    this.offsetMs = 0;          // сколько входного аудио обработано
    this.stats = { frames: 0, speechFrames: 0, rejected: 0, chunks: 0 };
  }

  /**
   * Прогнать кусок PCM через VAD. Возвращает массив закрытых чанков:
   * { startMs, endMs, samples: Int16Array (с паддингом), speechMs }
   * @param {Int16Array} pcm
   */
  push(pcm) {
    const out = [];
    let pos = 0;
    while (pos < pcm.length) {
      const take = Math.min(this.frameSamples - this.frameFill, pcm.length - pos);
      this.frameBuf.set(pcm.subarray(pos, pos + take), this.frameFill);
      this.frameFill += take;
      pos += take;
      if (this.frameFill === this.frameSamples) {
        const chunk = this._processFrame(this.frameBuf);
        this.frameFill = 0;
        if (chunk) out.push(chunk);
      }
    }
    return out;
  }

  /** Хвост при остановке записи: вернуть недозакрытый чанк, если там была речь. */
  flush() {
    const hasSpeech = this.chunkSpeechMs >= 400;
    const pending = this.pending;
    const startMs = this.chunkStartMs;
    const endMs = this.offsetMs;
    const speechMs = this.chunkSpeechMs;
    this._resetChunk();
    if (!hasSpeech || !pending.length) return [];
    return [{ startMs, endMs, speechMs, samples: concat(pending) }];
  }

  _processFrame(frame) {
    const rms = rmsOf(frame);
    const isSpeech = rms >= this.rmsThreshold;
    this.stats.frames++;
    if (isSpeech) this.stats.speechFrames++;

    if (!this.pending.length) {
      // Чанк не открыт: ждём стабильную речь (2 фрейма подряд — отсев щелчков).
      if (!isSpeech) { this.offsetMs += FRAME_MS; return null; }
      this.consecutiveSpeech++;
      if (this.consecutiveSpeech < 2) { this.offsetMs += FRAME_MS; return null; }
      // Открываем чанк с пре-роллом.
      const padFrames = Math.ceil(this.padMs / FRAME_MS);
      this.chunkStartMs = Math.max(0, this.offsetMs - padFrames * FRAME_MS);
      this.pending.push(frame);
      this.speechFrames.push(frame);
      this.chunkSpeechMs = FRAME_MS;
      this.silenceRunMs = 0;
      this.lastRms = [rms];
      this.offsetMs += FRAME_MS;
      return null;
    }

    // Чанк открыт.
    this.pending.push(frame);
    this.lastRms.push(rms);
    if (this.lastRms.length > 40) this.lastRms.shift(); // окно ~1.2 c
    this.offsetMs += FRAME_MS;

    if (isSpeech) {
      this.speechFrames.push(frame);
      this.chunkSpeechMs += FRAME_MS;
      this.silenceRunMs = 0;
    } else {
      this.silenceRunMs += FRAME_MS;
    }

    const speechMs = this.chunkSpeechMs;
    const durMs = this.offsetMs - this.chunkStartMs;

    // 1) Пауза после достаточной речи → закрыть чанк (естественная граница).
    if (this.silenceRunMs >= this.silenceMs && speechMs >= Math.min(this.minChunkMs, 4000)) {
      return this._closeChunk();
    }
    // 2) Длинный монолог без пауз → мягкий сплит по минимуму энергии.
    if (durMs >= this.forceSplitMs || (speechMs >= this.maxChunkMs && this.silenceRunMs >= 120)) {
      const cut = this._findSoftSplitIndex();
      if (cut > 0) return this._splitAt(cut);
      return this._closeChunk();
    }
    // 3) Затянувшаяся тишина при почти пустом чанке (ложное срабатывание) → сброс.
    if (this.silenceRunMs > 3000 && speechMs < 400) {
      this.stats.rejected++;
      this._resetChunk();
    }
    return null;
  }

  /** Индекс фрейма в this.pending для мягкого сплита: локальный минимум RMS в последних ~2 c. */
  _findSoftSplitIndex() {
    const window = Math.min(this.lastRms.length, Math.ceil(2000 / FRAME_MS));
    const region = this.lastRms.slice(-window);
    let bestIdx = -1, bestVal = Infinity;
    for (let i = 1; i < region.length - 1; i++) {
      if (region[i] < region[i - 1] && region[i] <= region[i + 1] && region[i] < bestVal) {
        bestVal = region[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return -1;
    const fromEnd = region.length - 1 - bestIdx;
    return Math.max(1, this.pending.length - fromEnd - 1);
  }

  _closeChunk() {
    const samples = concat(this.pending);
    const startMs = this.chunkStartMs;
    const endMs = this.chunkStartMs + framesToMs(this.pending.length);
    const speechMs = this.chunkSpeechMs;
    this._resetChunk();
    // Анти-галлюцинация: слишком короткая болтовня — отбраковка.
    if (speechMs < 300 || samples.length < this.sampleRate / 2) {
      this.stats.rejected++;
      return null;
    }
    this.stats.chunks++;
    return { startMs, endMs, speechMs, samples: padEdges(samples, this.sampleRate, this.padMs) };
  }

  /** Жёсткий сплит pending на [0..cut) — закрытый чанк; хвост остаётся новым буфером. */
  _splitAt(cut) {
    const head = this.pending.slice(0, cut);
    const tail = this.pending.slice(cut);
    const headSpeechMs = framesToMs(this.speechFrames.length);
    const startMs = this.chunkStartMs;
    const endMs = this.chunkStartMs + framesToMs(head.length);
    const samples = concat(head);
    // Хвост становится новым чанком (речь в нём сохраняется).
    const tailFrames = Math.ceil(tail.length / this.frameSamples);
    const tailSpeech = this.speechFrames.slice(-Math.min(this.speechFrames.length, tailFrames));
    this.pending = tail;
    this.speechFrames = tailSpeech;
    this.chunkStartMs = endMs;
    this.chunkSpeechMs = framesToMs(tailSpeech.length);
    this.silenceRunMs = 0;
    if (headSpeechMs < 300) { this.stats.rejected++; return null; }
    this.stats.chunks++;
    return { startMs, endMs, speechMs: headSpeechMs, samples };
  }

  _resetChunk() {
    this.lastSpeechMs = this.chunkSpeechMs;
    this.pending = [];
    this.speechFrames = [];
    this.chunkStartMs = 0;
    this.chunkSpeechMs = 0;
    this.silenceRunMs = 0;
    this.consecutiveSpeech = 0;
    this.lastRms = [];
  }
}

function framesToMs(n) { return Math.round(n * FRAME_MS); }

function rmsOf(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) { const v = frame[i] / 32768; sum += v * v; }
  return Math.sqrt(sum / frame.length);
}

function concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Int16Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

/** Паддинг краёв чанка тишиной (150 мс до и после) — Whisper не «съедает» первые слова. */
function padEdges(samples, sampleRate, padMs) {
  const pad = Math.round((sampleRate * padMs) / 1000);
  if (!pad) return samples;
  const out = new Int16Array(samples.length + pad * 2);
  out.set(samples, pad);
  return out;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

module.exports = { VadBufferManager, FRAME_MS, rmsOf };

