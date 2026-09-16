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
 *   - пре-ролл: скользящее кольцо последних кадров тишины, которое РЕАЛЬНО
 *     попадает в начало чанка, поэтому startMs совпадает с первым сэмплом;
 *   - пост-ролл: 150 мс тишины в конец (Whisper «дописывает» последнее слово),
 *     на таймкоды не влияет — endMs остаётся концом речи;
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
   * @param {number} opts.rmsThreshold СТАРТОВЫЙ порог речи (0..1, RMS Int16/32768)
   * @param {boolean} opts.adaptive    подстраивать порог под шумовой пол (по умолчанию да)
   * @param {number} opts.thresholdFactor множитель над шумом (шум × k = порог)
   * @param {number} opts.minRms / maxRms рамки автоподстройки порога
   * @param {number} opts.minSpeechRatio минимальная ДОЛЯ речи в чанке (иначе — шум)
   * @param {boolean} opts.zcrGate     отсев широкополосного шума по ZCR (по умолчанию да)
   * @param {number} opts.zcrLimit     порог ZCR (0..1): выше — считаем шумом/шипением
   */
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 16000;
    this.silenceMs = clamp(opts.silenceMs ?? 700, 400, 1200);
    this.minChunkMs = clamp(opts.minChunkMs ?? 7000, 2000, 60000);
    this.maxChunkMs = clamp(opts.maxChunkMs ?? 18000, this.minChunkMs, 60000);
    this.forceSplitMs = Math.max(opts.forceSplitMs ?? 25000, this.maxChunkMs);
    this.padMs = clamp(opts.padMs ?? 150, 0, 500);
    this.rmsThreshold = clamp(opts.rmsThreshold ?? 0.008, 0.0005, 0.5);
    // --- Адаптивный порог и анти-шум -----------------------------------
    // Причина: постоянное шипение (системный звук, дешёвый микрофон, наводки)
    // выше фиксированного порога заставляло VAD «нарезать речь» из шума, а
    // Whisper возвращал пустоту — пользователь видел только «тишина/шум».
    this.adaptive = opts.adaptive !== false;
    this.thresholdFactor = clamp(opts.thresholdFactor ?? 2.5, 1.5, 12);
    this.minRms = clamp(opts.minRms ?? 0.002, 0.0005, 0.1);
    this.maxRms = clamp(opts.maxRms ?? 0.06, 0.005, 0.5);
    // «Прогрев»: пока порог не устоялся над только что измеренным полом,
    // требуем запас coldGuard над порогом для ОТКРЫТИЯ нового чанка. Иначе шум,
    // который громче настроечного порога (ровная комната, системный звук) успевал
    // открыть чанк за те ~5 кадров, пока автопорог догоняет измеренный пол.
    // Ограничение coldMaxMs не даёт «глушить» тихую речь бесконечно.
    // Кандидаты для оценки шумового пола — УСТОЙЧИВЫЕ отрезки (ровный фон),
    // а не просто «тихие» кадры. Почему так:
    //   • ровный шум комнаты/системного звука часто громче настроечного порога,
    //     и при правиле «кадры НИЖЕ порога» автопорог его вообще не видел —
    //     шум считался речью, Whisper возвращал пустоту;
    //   • правило «ЛЮБЫЕ кадры» ломает тихую речь: 10-й процентиль первых кадров
    //     уходит к уровню самой речи, порог поднимается выше неё и речь теряется.
    // Ровность отличает фон от речи: у речи всегда есть слоговая модуляция.
    // Порог 0.06 измерен на практике: белый шум комнаты даёт CV ≈ 0.02–0.03,
    // низкочастотный гул ≈ 0.05–0.10, а даже слабо модулированная речь — 0.13+.
    this.steadyWindow = 8; // ~240 мс
    this.steadyCv = 0.06; // разброс RMS, ниже которого отрезок ровный
    this.steadyRunFrames = 8; // как долго ровность должна держаться подряд
    this.steadyRun = 0;
    this.recentRms = [];
    this.coldGuard = clamp(opts.coldGuard ?? 3, 1, 10);
    this.coldMaxMs = clamp(opts.coldMaxMs ?? 1200, 0, 5000);
    this.floorSeenAt = -1; // кадр, на котором пол стал известен
    // Порог для оценки шумового пола: всё тише считаем цифровой тишиной.
    this.noiseEps = clamp(opts.noiseEps ?? 0.0006, 0.0001, 0.01);
    this.minSpeechRatio = clamp(opts.minSpeechRatio ?? 0.15, 0, 1);
    this.zcrGate = opts.zcrGate !== false;
    this.zcrLimit = clamp(opts.zcrLimit ?? 0.48, 0.2, 0.9);
    // Кольцо «тихих» кадров для оценки шумового пола (10-й процентиль).
    this.quietRms = [];
    this.quietWindow = 400; // ~12 c при кадре 30 мс
    this.noiseFloor = 0;
    this.threshold = this.rmsThreshold;
    // Метрики текущего чанка считает frameStats() в момент закрытия: так они
    // одинаково точны и для обычного закрытия, и для мягкого сплита.
    this.lastZcr = 0;
    // Отклонённые отрезки: UI показывает их как «пропуски» с реальной причиной,
    // поэтому одна строка «тишина/шум» больше не скрывает шум/тихий микрофон.
    this.skipped = [];

    this.frameSamples = Math.round((this.sampleRate * FRAME_MS) / 1000);
    this.frameBuf = new Int16Array(this.frameSamples);
    this.frameFill = 0;

    // Состояние буфера чанка
    // Дорожка чанка: pending (аудио) и chunkInfo (класс кадров) идут параллельно,
    // чтобы при закрытии можно было ОБРЕЗАТЬ края, где речи нет. Без этого шум в
    // начале (пока порог ещё не поднялся) приклеивался к речи и попадал в Whisper.
    this.chunkInfo = [];
    this.pending = []; // фреймы текущего чанка (Int16Array)
    this.speechFrames = []; // фреймы речи (без тишины) текущего чанка
    this.chunkStartMs = 0; // абсолютное время начала чанка
    this.chunkSpeechMs = 0; // суммарная длительность речи в чанке
    this.lastSpeechMs = 0;
    this.silenceRunMs = 0; // текущая серия тишины
    this.consecutiveSpeech = 0; // фреймов речи подряд (анти-щелчок)
    this.lastRms = []; // окно RMS для поиска минимума (мягкий сплит)

    // Пре-ролл: кольцо последних кадров (аудио + их RMS). Именно эти кадры
    // уходят в начало нового чанка, поэтому таймкод startMs соответствует
    // первому сэмплу в samples (раньше пре-ролл был «виртуальным»: сдвигал
    // startMs, но само аудио в чанк не попадало → тайминги «уезжали»).
    this.preRollFrames = Math.ceil(this.padMs / FRAME_MS);
    this.preRoll = [];
    this.preRollRms = [];
    this.lastSpeechIdx = -1; // индекс последнего кадра РЕЧИ в pending

    this.offsetMs = 0; // сколько входного аудио обработано
    this.stats = {
      frames: 0,
      speechFrames: 0,
      rejected: 0,
      chunks: 0,
      loudFrames: 0, // кадры выше порога по энергии
      noiseFrames: 0, // из них отброшены как широкополосный шум (ZCR)
      skippedMs: 0, // суммарная длительность пропусков
    };
  }

  /**
   * Оценка шумового пола по «фоновым» кадрам: 10-й процентиль их RMS.
   *
   * Кандидаты — кадры, которые принадлежат УСТОЙЧИВОМУ (ровному) отрезку
   * (см. _isSteady), а не просто кадры ниже порога. Исправлено: при старом
   * правиле ровный шум комнаты/системного звука, оказавшийся ГРОМЧЕ настроечного
   * порога, никогда не попадал в оценку — автопорог не поднимался, шум считался
   * речью, Whisper возвращал пустоту.
   */
  _updateNoiseFloor(rms) {
    // Истинную цифровую тишину в оценку не берём: она тянет процентиль к нулю
    // и порог «схлопывался» до минимума после каждой паузы, из-за чего шум
    // комнаты снова становился «речью».
    if (rms >= this.noiseEps) {
      this.recentRms.push(rms);
      if (this.recentRms.length > this.steadyWindow) this.recentRms.shift();
      this.steadyRun = this._isSteady(rms) ? this.steadyRun + 1 : 0;
      // Пол обновляем только после НЕПРЕРЫВНОГО ровного отрезка: короткие
      // «ровные» окна внутри речи (затянутая гласная) не должны поднимать пол.
      if (this.steadyRun >= this.steadyRunFrames) {
        this.quietRms.push(rms);
        if (this.quietRms.length > this.quietWindow) this.quietRms.shift();
      }
    } else {
      this.steadyRun = 0;
    }
    if (this.quietRms.length < 10) return;
    const sorted = this.quietRms.slice().sort((a, b) => a - b);
    this.noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 0;
    if (this.noiseFloor > 0 && this.floorSeenAt < 0) this.floorSeenAt = this.stats.frames;
    if (!this.adaptive) return;
    // Целевой порог — на thresholdFactor выше шума, но в рамках minRms..maxRms.
    // Вверх идём быстро (0.4 на кадр): пока порог догоняет пол, шум успевает
    // открыть чанк. Вниз — медленно (0.1): иначе порог обваливался бы в паузах
    // и тихая речь снова считалась бы шумом.
    const target = clamp(this.noiseFloor * this.thresholdFactor, this.minRms, this.maxRms);
    this.threshold += (target - this.threshold) * (target > this.threshold ? 0.4 : 0.1);
  }

  /**
   * Кадр принадлежит ровному отрезку? У речи RMS кадров постоянно меняется
   * (слоги, гласные/согласные), у шума/гула — почти нет. Именно это отличает
   * «громкий шум» от «тихой речи»: по одному уровню их различить нельзя.
   */
  _isSteady(rms) {
    const w = this.recentRms;
    if (w.length < 4) return false;
    let sum = 0,
      sumSq = 0;
    for (const v of w) {
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / w.length;
    if (mean <= 0) return false;
    const sd = Math.sqrt(Math.max(0, sumSq / w.length - mean * mean));
    if (sd / mean > this.steadyCv) return false;
    // Кадр не должен быть «всплеском» на ровном отрезке (щелчок, стук).
    return Math.abs(rms - mean) <= mean * 0.5;
  }

  /**
   * Порог, при котором РАЗРЕШЕНО открыть новый чанк.
   *
   * Пока автопорог не устоялся над измеренным полом (первые ~0.3–0.6 с записи
   * или сразу после резкого изменения фона), требуем запас coldGuard: ровный шум
   * не должен открывать чанк, а речь даже тихого лектора этот запас проходит.
   */
  _openThreshold() {
    if (!this.adaptive) return this.threshold;
    const target = Math.min(this.noiseFloor * this.thresholdFactor, this.maxRms);
    const settled = this.noiseFloor > 0 && this.threshold >= target * 0.9;
    const warming =
      this.stats.frames - Math.max(0, this.floorSeenAt) <= Math.round(this.coldMaxMs / FRAME_MS);
    if (settled || !warming) return this.threshold;
    return this.threshold * this.coldGuard;
  }

  /** Зафиксировать пропущенный отрезок (для диагностики и «Проверить пропуски»). */
  _pushSkipped(startMs, endMs, reason, m = {}) {
    const durMs = Math.max(0, endMs - startMs);
    // Совсем короткие «пропуски» не интересны: это щелчки и стыки.
    if (durMs < 1000) return;
    this.stats.skippedMs += durMs;
    this.skipped.push({
      startMs,
      endMs,
      durMs,
      reason,
      rmsDb: m.rmsDb ?? dbOf(0),
      rmsPeakDb: m.rmsPeakDb ?? dbOf(0),
      noiseDb: m.noiseFloorDb ?? dbOf(this.noiseFloor),
      thresholdDb: m.thresholdDb ?? dbOf(this.threshold),
      speechRatio: m.speechRatio ?? 0,
      zcr: m.zcrMean ?? 0,
    });
    // Страховка от бесконечного роста (очень шумная запись).
    if (this.skipped.length > 500) this.skipped.shift();
  }

  /** Забрать накопленные пропуски (вызывающий пишет их в БД как строки-объяснения). */
  drainSkipped() {
    const out = this.skipped;
    this.skipped = [];
    return out;
  }

  /** Текущее состояние детектора — уходит в UI вместе со статусом сессии. */
  metrics() {
    return {
      thresholdDb: dbOf(this.threshold),
      noiseFloorDb: dbOf(this.noiseFloor),
      adaptive: this.adaptive,
      zcrGate: this.zcrGate,
      lastZcr: Math.round(this.lastZcr * 1000) / 1000,
      skipped: this.stats.skippedMs,
      skippedCount: this.stats.rejected,
      stats: { ...this.stats },
    };
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
        // ВАЖНО: копируем кадр. this.frameBuf переиспользуется под следующий
        // кадр, поэтому без копии все кадры чанка ссылались бы на один массив
        // и в WAV (для Whisper) попадал бы повтор последнего 30-мс фрейма.
        const chunk = this._processFrame(this.frameBuf.slice());
        this.frameFill = 0;
        if (chunk) out.push(chunk);
      }
    }
    return out;
  }

  /**
   * Прогнать отрезок с АБСОЛЮТНЫМ таймкодом (для «Проверить пропуски»):
   * иначе найденные чанки получили бы время от нуля и «уехали» на таймлайне.
   */
  pass(pcm, startMs = 0) {
    this.offsetMs = Math.max(0, Math.round(startMs));
    return this.push(pcm);
  }

  /** Хвост при остановке записи: вернуть недозакрытый чанк, если там была речь. */
  flush() {
    const startMs = this.chunkStartMs;
    const speechMs = this.chunkSpeechMs;
    const trimmed = this._trimEdges(this.pending, this.chunkInfo, startMs);
    const frames = trimmed && trimmed.frames.length ? trimmed.frames : this.pending;
    const outStart = trimmed && trimmed.frames.length ? trimmed.startMs : startMs;
    // endMs — конец речи, а не конец буфера: хвостовая тишина остаётся в
    // samples (нужна Whisper), но в таймкод субтитров не попадает.
    const outEnd =
      trimmed && trimmed.frames.length
        ? trimmed.endMs
        : startMs + framesToMs(Math.max(1, this.lastSpeechIdx + 1));
    const m = this._metricsOf(frames, speechMs, Math.max(1, outEnd - outStart));
    this._resetChunk();
    if (speechMs < 400 || !frames.length) return [];
    const reason = this._rejectReason(m, outEnd - outStart);
    if (reason) {
      this.stats.rejected++;
      this._pushSkipped(outStart, outEnd, reason, m);
      return [];
    }
    this.stats.chunks++;
    return [
      {
        startMs: outStart,
        endMs: outEnd,
        speechMs,
        samples: padTail(concat(frames), this.sampleRate, this.padMs),
        reason: "",
        ...m,
      },
    ];
  }

  /** Кольцо пре-ролла: держим только последние preRollFrames кадров. */
  _pushPreRoll(frame, rms) {
    this.preRoll.push(frame);
    this.preRollRms.push(rms);
    while (this.preRoll.length > this.preRollFrames) {
      this.preRoll.shift();
      this.preRollRms.shift();
    }
  }

  _processFrame(frame) {
    const rms = rmsOf(frame);
    const zcr = zcrOf(frame);
    this.lastZcr = zcr;
    // Шипение/широкополосный шум: высокий ZCR при заметной энергии — это НЕ речь.
    // Раньше такой шум открывал чанк (энергия выше порога), Whisper возвращал
    // пустоту, и пользователь видел «тишина/шум — отброшено VAD» без причины.
    const noisy = this.zcrGate && zcr > this.zcrLimit;
    this._updateNoiseFloor(rms);
    // isSpeech — «это речь» для учёта внутри уже открытого чанка.
    // canOpen — «этим кадром МОЖНО открыть чанк»: пока автопорог не устоялся,
    // требуется запас (см. _openThreshold) — иначе ровный шум громче настроечного
    // порога открывал чанк, и первая фраза лекции склеивалась с шумом.
    const isSpeech = rms >= this.threshold && !noisy;
    const canOpen = rms >= this._openThreshold() && !noisy;
    this.stats.frames++;
    if (rms >= this.threshold) this.stats.loudFrames++;
    if (noisy && rms >= this.threshold) this.stats.noiseFrames++;
    if (isSpeech) this.stats.speechFrames++;

    if (!this.pending.length) {
      // Чанк не открыт: ждём стабильную речь (2 фрейма подряд — отсев щелчков).
      if (!canOpen) {
        this._pushPreRoll(frame, rms);
        this.offsetMs += FRAME_MS;
        return null;
      }
      this.consecutiveSpeech++;
      if (this.consecutiveSpeech < 2) {
        this._pushPreRoll(frame, rms);
        this.offsetMs += FRAME_MS;
        return null;
      }
      // Открываем чанк с реальным пре-роллом (кадры тишины перед речью).
      const pre = this.preRoll;
      const preRms = this.preRollRms;
      this.pending = pre.slice();
      this.pending.push(frame);
      // Кадры пре-ролла по определению не речь (мы ждали речь) — это паддинг.
      this.chunkInfo = pre.map(() => ({ speech: false, rms: 0, zcr: 0 }));
      this.chunkInfo.push({ speech: true, rms, zcr });
      this.speechFrames = [frame];
      this.chunkStartMs = Math.max(0, this.offsetMs - framesToMs(pre.length));
      this.chunkSpeechMs = FRAME_MS;
      this.silenceRunMs = 0;
      this.lastRms = preRms.slice().concat([rms]);
      this.lastSpeechIdx = this.pending.length - 1;
      this.preRoll = [];
      this.preRollRms = [];
      this.offsetMs += FRAME_MS;
      return null;
    }

    // Чанк открыт.
    this.pending.push(frame);
    this.chunkInfo.push({ speech: isSpeech, rms, zcr });
    this.lastRms.push(rms);
    if (this.lastRms.length > 40) this.lastRms.shift(); // окно ~1.2 c
    this.offsetMs += FRAME_MS;

    if (isSpeech) {
      this.speechFrames.push(frame);
      this.chunkSpeechMs += FRAME_MS;
      this.silenceRunMs = 0;
      this.lastSpeechIdx = this.pending.length - 1;
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
    //    Раньше такой отрезок молча «съедался»: пользователь потом видел пустые
    //    чанки и не понимал, что это шум. Теперь он попадает в пропуски с dBFS.
    if (this.silenceRunMs > 3000 && speechMs < 400) {
      const m = this._metricsOf(this.pending, speechMs, Math.max(1, durMs));
      const startMs = this.chunkStartMs;
      const endMs = this.offsetMs;
      this.stats.rejected++;
      this._resetChunk();
      this._pushSkipped(startMs, endMs, "noise_burst", m);
    }
    return null;
  }

  /** Индекс фрейма в this.pending для мягкого сплита: локальный минимум RMS в последних ~2 c. */
  _findSoftSplitIndex() {
    const window = Math.min(this.lastRms.length, Math.ceil(2000 / FRAME_MS));
    const region = this.lastRms.slice(-window);
    let bestIdx = -1,
      bestVal = Infinity;
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

  /** Метрики чанка (dBFS, доля речи, «тональность» и стационарность шума). */
  _metricsOf(frames, speechMs, durMs) {
    const s = frameStats(frames);
    const ratio = durMs > 0 ? speechMs / durMs : 0;
    // Чистый периодический гул (вентилятор/наводка 50 Гц): ZCR низкий и СТАБИЛЬНЫЙ.
    // У речи ZCR «дышит» (гласные/согласные), поэтому std заметно выше.
    const tonal = s.frames >= 20 && s.zcrMean < 0.015 && s.zcrStd < 0.004;
    // Стационарный шум: уровень ровный (нет слоговой модуляции). Именно так
    // шум комнаты/шипение системного звука проходил энергетический порог и
    // превращался в чанки, из которых Whisper не мог извлечь текст.
    const modulation = s.rmsAvg > 0 ? s.rmsStd / s.rmsAvg : 0;
    // Признак шума учитываем ТОЛЬКО вблизи шумового пола: настоящая речь даже у
    // тихого лектора заметно громче фона, поэтому громкий ровный сигнал не
    // должен отбраковываться (иначе «монотонный» голос попал бы под нож).
    const nearFloor = this.noiseFloor > 0 && s.rmsAvg <= this.noiseFloor * 4;
    const stationary = s.frames >= 20 && modulation < 0.12 && nearFloor;
    // Широкополосный шум на уровне отрезка (если кадровый гейт пропустил).
    const broadband = s.frames >= 20 && s.zcrMean > this.zcrLimit;
    return {
      rmsDb: dbOf(s.rmsAvg),
      rmsPeakDb: dbOf(s.rmsPeak),
      speechRatio: Math.round(ratio * 100) / 100,
      zcrMean: Math.round(s.zcrMean * 1000) / 1000,
      modulation: Math.round(modulation * 1000) / 1000,
      noiseFloorDb: dbOf(this.noiseFloor),
      thresholdDb: dbOf(this.threshold),
      tonal,
      stationary,
      broadband,
    };
  }

  /** Причина отбраковки отрезка (для строки-пропуска в UI) или "" если это речь. */
  _rejectReason(m, durMs) {
    if (m.tonal) return "hum";
    if (m.broadband) return "noise";
    if (m.stationary) return "stationary_noise";
    if (durMs > 2000 && m.speechRatio < this.minSpeechRatio) return "low_speech_ratio";
    return "";
  }

  /**
   * Обрезает края чанка там, где речи не было.
   *
   * Зачем: пока автопорог не подстроился (0.3–0.9 с), шум в начале открывал
   * чанк и «приклеивался» к речи — в Whisper уходил мусор, а таймкод чанка
   * начинался с шума. Пре-ролл (padMs) сохраняем: без него срезается атака
   * первого слова.
   */
  _trimEdges(frames, info, startMs) {
    if (!frames.length || !info.length) return null;
    let first = -1,
      last = -1;
    for (let i = 0; i < info.length; i++)
      if (info[i].speech) {
        first = i;
        break;
      }
    for (let i = info.length - 1; i >= 0; i--)
      if (info[i].speech) {
        last = i;
        break;
      }
    if (first < 0 || last < 0)
      return { frames: [], info: [], startMs, endMs: startMs, speechFrames: 0 };
    const from = Math.max(0, first - this.preRollFrames);
    const kept = frames.slice(from, last + 1);
    const keptInfo = info.slice(from, last + 1);
    return {
      frames: kept,
      info: keptInfo,
      startMs: startMs + framesToMs(from),
      endMs: startMs + framesToMs(last + 1),
      speechFrames: keptInfo.filter((f) => f.speech).length,
    };
  }

  _closeChunk() {
    const startMs = this.chunkStartMs;
    const speechMs = this.chunkSpeechMs;
    const durMs = Math.max(1, this.offsetMs - this.chunkStartMs);
    const trimmed = this._trimEdges(this.pending, this.chunkInfo, startMs);
    const frames = trimmed && trimmed.frames.length ? trimmed.frames : this.pending;
    const outStart = trimmed && trimmed.frames.length ? trimmed.startMs : startMs;
    // endMs — конец РЕЧИ: хвостовая тишина (в samples она нужна Whisper)
    // не должна растягивать таймкод чанка в субтитрах и на таймлайне.
    const outEnd =
      trimmed && trimmed.frames.length
        ? trimmed.endMs
        : startMs + framesToMs(Math.max(1, this.lastSpeechIdx + 1));
    const m = this._metricsOf(frames, speechMs, Math.max(1, outEnd - outStart));
    this._resetChunk();
    const samples = concat(frames);
    // Анти-галлюцинация: слишком короткая болтовня — отбраковка.
    if (speechMs < 300 || samples.length < this.sampleRate / 2) {
      this.stats.rejected++;
      return null;
    }
    // Шум/гул вместо речи: пропуск с ЧЕСТНОЙ причиной (UI покажет её и dBFS).
    const reason = this._rejectReason(m, durMs);
    if (reason) {
      this.stats.rejected++;
      this._pushSkipped(outStart, outEnd, reason, m);
      return null;
    }
    this.stats.chunks++;
    // Пост-ролл: тишина в хвост (пре-ролл уже внутри pending). endMs остаётся
    // концом речи, поэтому таймкоды чанка не «разъезжаются» с аудио.
    return {
      startMs: outStart,
      endMs: outEnd,
      speechMs,
      samples: padTail(samples, this.sampleRate, this.padMs),
      reason: "",
      ...m,
    };
  }

  /** Жёсткий сплит pending на [0..cut) — закрытый чанк; хвост остаётся новым буфером. */
  _splitAt(cut) {
    const headAll = this.pending.slice(0, cut);
    const headInfo = this.chunkInfo.slice(0, cut);
    const tail = this.pending.slice(cut);
    const tailInfo = this.chunkInfo.slice(cut);
    const headSpeechMs = framesToMs(this.speechFrames.length);
    const startMs = this.chunkStartMs;
    const endAll = this.chunkStartMs + framesToMs(headAll.length);
    // Края головы тоже обрезаем: шум перед речью не должен попасть в Whisper.
    const trimmed = this._trimEdges(headAll, headInfo, startMs);
    const head = trimmed && trimmed.frames.length ? trimmed.frames : headAll;
    const outStart = trimmed && trimmed.frames.length ? trimmed.startMs : startMs;
    const outEnd = trimmed && trimmed.frames.length ? trimmed.endMs : endAll;
    const samples = concat(head);
    const m = this._metricsOf(head, headSpeechMs, Math.max(1, outEnd - outStart));
    // Хвост становится новым чанком (речь в нём сохраняется).
    this.pending = tail;
    this.chunkInfo = tailInfo;
    this.chunkStartMs = endAll;
    this.chunkSpeechMs = framesToMs(tailInfo.filter((f) => f.speech).length);
    this.lastSpeechIdx = tailInfo.reduce((acc, f, i) => (f.speech ? i : acc), -1);
    this.silenceRunMs = 0;
    if (headSpeechMs < 300) {
      this.stats.rejected++;
      this._pushSkipped(
        outStart,
        outEnd,
        this._rejectReason(m, outEnd - outStart) || "low_speech_ratio",
        m,
      );
      return null;
    }
    const headReason = this._rejectReason(m, endAll - startMs);
    if (headReason) {
      this.stats.rejected++;
      this._pushSkipped(outStart, outEnd, headReason, m);
      return null;
    }
    this.stats.chunks++;
    return { startMs: outStart, endMs: outEnd, speechMs: headSpeechMs, samples, reason: "", ...m };
  }

  _resetChunk() {
    this.lastSpeechMs = this.chunkSpeechMs;
    this.pending = [];
    this.chunkInfo = [];
    this.speechFrames = [];
    this.chunkStartMs = 0;
    this.chunkSpeechMs = 0;
    this.silenceRunMs = 0;
    this.consecutiveSpeech = 0;
    this.lastRms = [];
    this.lastSpeechIdx = -1;
  }
}

function framesToMs(n) {
  return Math.round(n * FRAME_MS);
}

function rmsOf(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Zero-crossing rate: доля смен знака на сэмпл (0..1).
 * Речь — 0.02..0.4 (гласные дают низкий ZCR, шипящие — высокий),
 * широкополосный шум/шипение — около 0.5, поэтому ZCR > 0.48 считаем шумом.
 * Раньше VAD работал только по энергии, и любой шум выше порога становился
 * «речью» — Whisper возвращал пустоту, а пользователь видел «тишина/шум».
 */
function zcrOf(frame) {
  let crosses = 0;
  for (let i = 1; i < frame.length; i++) {
    const a = frame[i - 1],
      b = frame[i];
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crosses++;
  }
  return frame.length > 1 ? crosses / (frame.length - 1) : 0;
}

/** RMS → dBFS (−100 для «нуля», чтобы UI не показывал −Infinity). */
function dbOf(rms) {
  if (!rms || rms <= 0) return -100;
  return Math.round(20 * Math.log10(rms) * 10) / 10;
}

/**
 * Сводные метрики по кадрам чанка: средний/пиковый RMS и статистика ZCR.
 * Нужны и для диагностики в UI, и для решения «это речь или гул/шум».
 */
function frameStats(frames) {
  if (!frames.length) return { frames: 0, rmsAvg: 0, rmsPeak: 0, rmsStd: 0, zcrMean: 0, zcrStd: 0 };
  let sum = 0,
    peak = 0,
    zSum = 0,
    zSq = 0,
    rSq = 0;
  for (const f of frames) {
    const r = rmsOf(f);
    sum += r;
    rSq += r * r;
    if (r > peak) peak = r;
    const z = zcrOf(f);
    zSum += z;
    zSq += z * z;
  }
  const n = frames.length;
  const rMean = sum / n;
  // rmsStd — разброс уровня между кадрами. Нужен, чтобы отличить СТАЦИОНАРНЫЙ
  // шум (ровный уровень) от речи: у речи всегда есть слоговая модуляция.
  // Без этой величины modulation был NaN, и проверка стационарного шума
  // молча не срабатывала (шум уходил в Whisper как «речь»).
  const rVar = Math.max(0, rSq / n - rMean * rMean);
  const zMean = zSum / n;
  const zVar = Math.max(0, zSq / n - zMean * zMean);
  return {
    frames: n,
    rmsAvg: rMean,
    rmsPeak: peak,
    rmsStd: Math.sqrt(rVar),
    zcrMean: zMean,
    zcrStd: Math.sqrt(zVar),
  };
}

function concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Int16Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * Пост-ролл: тишина в хвост чанка (padMs). Нужна, чтобы Whisper договорил
 * последнее слово; пре-ролл приходит реальным аудио из кольца кадров
 * (см. _pushPreRoll), поэтому здесь паддинг только в конец.
 */
function padTail(samples, sampleRate, padMs) {
  const pad = Math.round((sampleRate * padMs) / 1000);
  if (!pad) return samples;
  const out = new Int16Array(samples.length + pad);
  out.set(samples, 0);
  return out;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

module.exports = { VadBufferManager, FRAME_MS, rmsOf, zcrOf, dbOf, frameStats };
