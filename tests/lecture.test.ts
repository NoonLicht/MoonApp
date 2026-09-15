import { describe, it, expect } from "vitest";
import { VadBufferManager } from "../server/vad";
import { sanitizeText, parseSrt } from "../server/lecture";

/**
 * Регресс-тесты Lecture Recorder.
 *
 * Контекст: в VAD было две ошибки, которые не ломали сборку, но убивали
 * распознавание «в бою»:
 *   1) кадры чанка хранились ССЫЛКОЙ на переиспользуемый frameBuf, поэтому в
 *      WAV для Whisper попадал повтор последнего 30-мс фрейма (мусор →
 *      галлюцинации вида «Спасибо за просмотр»);
 *   2) «виртуальный» пре-ролл сдвигал startMs, но самого аудио в чанке не было
 *      → таймкоды чанка не совпадали с содержимым (экспорт SRT/VTT «уезжал»).
 */

const SR = 16000;

/**
 * Речеподобный сигнал: тон с амплитудной модуляцией (~4 слога в секунду).
 *
 * ВАЖНО: ровный (немодулированный) тон для VAD — НЕ речь, а гул/шум. У реальной
 * речи уровень всегда «дышит» (слоги, гласные/согласные), и именно по модуляции
 * VAD отличает голос от постоянного фона. Пока «речью» в тестах был ровный тон,
 * защиты от шума было невозможно проверить: такой сигнал сам выглядел как шум.
 */
function speech(ms: number, freq = 440, amp = 0.35): Int16Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = 0.55 + 0.45 * Math.abs(Math.sin((2 * Math.PI * 4 * i) / SR));
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp * env * 32767);
  }
  return out;
}

/** Ровный тон без модуляции — для проверок «это НЕ речь» (гул, наводка, шум). */
function tone(ms: number, freq = 440, amp = 0.35): Int16Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp * 32767);
  return out;
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}

function newVad(overrides: Record<string, number> = {}) {
  return new VadBufferManager({
    sampleRate: SR,
    silenceMs: 500,
    minChunkMs: 2000,
    maxChunkMs: 18000,
    forceSplitMs: 20000,
    padMs: 150,
    ...overrides,
  });
}

describe("Lecture Recorder — VAD-нарезка", () => {
  it("режет речь на чанки по паузам", () => {
    const vad = newVad();
    // Чанк закрывается ТОЛЬКО по паузе (или принудительным сплитом), поэтому
    // после второй речи тоже нужна тишина — иначе она останется «в работе».
    const closed = [
      ...vad.push(speech(3000)),
      ...vad.push(silence(900)),
      ...vad.push(speech(3000)),
      ...vad.push(silence(900)),
    ];
    expect(closed.length).toBeGreaterThanOrEqual(2);
    for (const c of closed) {
      expect(c.endMs).toBeGreaterThan(c.startMs);
      expect(c.samples.length).toBeGreaterThan(0);
    }
  });

  it("кадры чанка не алиасятся: аудио содержит реальный сигнал, а не повтор фрейма", () => {
    const vad = newVad();
    const closed = vad.push(speech(3000)).concat(vad.push(silence(900)));
    expect(closed.length).toBeGreaterThanOrEqual(1);
    const samples = closed[0].samples;
    // Речь — знакопеременный тон: в начале чанка должно быть много РАЗНЫХ
    // значений. При алиасинге все 30-мс фреймы указывают на один массив
    // (последний фрейм), и уникальных значений было бы всего пара.
    const window = samples.slice(0, Math.round(SR * 0.4));
    const uniq = new Set(Array.from(window)).size;
    expect(uniq).toBeGreaterThan(50);
    const nonzero = Array.from(window).filter((v) => v !== 0).length;
    expect(nonzero / window.length).toBeGreaterThan(0.5);
  });

  it("пре-ролл реальный: startMs соответствует первому сэмплу, речь не обрезана", () => {
    const vad = newVad();
    // 2 c тишины → 3 c речи → пауза (закрывает чанк).
    vad.push(silence(2000));
    const closed = vad.push(speech(3000)).concat(vad.push(silence(900)));
    expect(closed.length).toBeGreaterThanOrEqual(1);
    const c = closed[0];
    // Начало речи — на 2000 мс; пре-ролл 150 мс даёт допуск, но не больше.
    expect(c.startMs).toBeGreaterThanOrEqual(1800);
    expect(c.startMs).toBeLessThanOrEqual(2000);
    // Пост-ролл 150 мс: сэмплов примерно «речь + паддинг», но не меньше речи.
    const speechSamples = Math.round(SR * 3);
    expect(c.samples.length).toBeGreaterThanOrEqual(speechSamples);
    expect(c.samples.length).toBeLessThanOrEqual(speechSamples + SR * 1.5);
    // endMs — конец РЕЧИ, а не конец файла с паддингом.
    expect(c.endMs).toBeGreaterThanOrEqual(4700);
    expect(c.endMs).toBeLessThanOrEqual(5300);
  });

  it("не отдаёт чанк из одной тишины (анти-галлюцинация)", () => {
    const vad = newVad();
    const closed = vad.push(silence(5000));
    expect(closed).toEqual([]);
    expect(vad.stats.speechFrames).toBe(0);
    expect(vad.stats.frames).toBeGreaterThan(0);
  });

  it("flush() возвращает хвост незакрытой речи, таймкоды в пределах потока", () => {
    const vad = newVad();
    const streamed = 2000 + 3000; // тишина + речь
    vad.push(silence(2000));
    vad.push(speech(3000));
    const tail = vad.flush();
    expect(tail.length).toBe(1);
    expect(tail[0].startMs).toBeGreaterThanOrEqual(1800);
    expect(tail[0].endMs).toBeLessThanOrEqual(streamed + 100);
    expect(tail[0].samples.length).toBeGreaterThan(0);
  });

  it("таймкоды последовательных чанков не пересекаются", () => {
    const vad = newVad();
    const closed = [
      ...vad.push(speech(2500)),
      ...vad.push(silence(800)),
      ...vad.push(speech(2500)),
      ...vad.push(silence(800)),
      ...vad.push(speech(2500)),
      ...vad.push(silence(800)),
    ];
    expect(closed.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < closed.length; i++) {
      // Пре-ролл может «залезть» в паузу, но не поверх предыдущей речи.
      expect(closed[i].startMs).toBeGreaterThanOrEqual(closed[i - 1].endMs - 200);
    }
  });
});

describe("Lecture Recorder — очистка текста Whisper", () => {
  it("вырезает типовые галлюцинации", () => {
    expect(sanitizeText("Спасибо за просмотр!")).toBe("");
    expect(sanitizeText("Продолжение следует")).toBe("");
    expect(sanitizeText("  ...  ")).toBe("");
    expect(sanitizeText("Subtitles by Amara.org")).toBe("");
  });

  it("схлопывает зацикленные повторы", () => {
    expect(sanitizeText("да да да да да да да да")).toBe("да");
    expect(sanitizeText("вот так вот так вот так вот так")).toBe("вот так");
  });

  it("сохраняет нормальную речь", () => {
    const src = "Производная в точке равна угловому коэффициенту касательной";
    expect(sanitizeText(src)).toBe(src);
  });
});

describe("Lecture Recorder — разбор SRT от whisper.cpp", () => {
  it("читает сегменты с таймингами", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:02,500",
      "Первая фраза",
      "",
      "2",
      "00:00:02,500 --> 00:00:06,000",
      "Вторая фраза",
      "",
    ].join("\n");
    const segs = parseSrt(srt);
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("Первая фраза");
    expect(segs[0].start).toBe(0);
    expect(segs[1].start).toBeCloseTo(2.5, 3);
    expect(segs[1].end).toBeCloseTo(6, 3);
  });

  it("не ломается на пустом вводе", () => {
    expect(parseSrt("")).toEqual([]);
  });
});
