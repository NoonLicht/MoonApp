import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { VadBufferManager, zcrOf, dbOf, frameStats } from "../server/vad";

/**
 * Регресс-тесты «Аудио» для Lecture Recorder.
 *
 * Контекст: пользователь записал лекцию и увидел только строки «тишина/шум —
 * отброшено VAD». Причины были разные и невидимые: (1) надпись выдавала ответ
 * Whisper за решение VAD, (2) VAD работал только по энергии, поэтому постоянный
 * шум (шипение системного звука, микрофон веб-камеры, наводки) считался речью,
 * (3) порог был жёстко зашит и не подстраивался под комнату.
 *
 * Эти тесты фиксируют новое поведение: шум/гул не превращаются в чанки,
 * автоподстройка порога работает, а слабая речь не теряется.
 */

const SR = 16000;

/**
 * Речеподобный сигнал: тон с амплитудной модуляцией (~4 слога в секунду).
 *
 * ВАЖНО: ровный (немодулированный) тон для VAD — НЕ речь, а гул/шум: у реальной
 * речи уровень всегда «дышит». Ровный тон используется ниже именно как
 * «не-речь» (проверки отбраковки), а как «речь» — только эта функция.
 */
function speech(ms: number, freq = 180, amp = 0.25): Int16Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = 0.55 + 0.45 * Math.abs(Math.sin((2 * Math.PI * 4 * i) / SR));
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp * env * 32767);
  }
  return out;
}

function tone(ms: number, freq = 180, amp = 0.25): Int16Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp * 32767);
  return out;
}

/** Белый шум с фиксированным seed: тест не должен «мигать» от Math.random. */
function noise(ms: number, amp = 0.12): Int16Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Int16Array(n);
  let s = 123456789;
  for (let i = 0; i < n; i++) {
    s = (1103515245 * s + 12345) & 0x7fffffff;
    out[i] = Math.round(((s / 0x7fffffff) * 2 - 1) * amp * 32767);
  }
  return out;
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}

function newVad(overrides: Record<string, unknown> = {}) {
  return new VadBufferManager({
    sampleRate: SR,
    silenceMs: 500,
    minChunkMs: 2000,
    maxChunkMs: 18000,
    forceSplitMs: 6000,
    ...overrides,
  });
}

describe("VAD — анти-шум (регресс «тишина/шум — отброшено VAD»)", () => {
  it("широкополосный шум не превращается в чанк, а помечается как шум", () => {
    const vad = newVad();
    const closed = [...vad.push(noise(3000, 0.3)), ...vad.push(silence(900))];
    expect(closed).toEqual([]);
    // Часть кадров проходит по энергии, но ZCR-гейт отбрасывает их как шум.
    expect(vad.stats.loudFrames).toBeGreaterThan(0);
    expect(vad.stats.noiseFrames).toBeGreaterThan(vad.stats.loudFrames * 0.6);
  });

  it("периодический гул (50 Гц) отбрасывается с причиной hum", () => {
    const vad = newVad();
    const closed = [...vad.push(tone(3000, 50, 0.25)), ...vad.push(silence(900))];
    expect(closed).toEqual([]);
    const skipped = vad.drainSkipped();
    expect(skipped.map((s) => s.reason)).toContain("hum");
  });

  it("автоподстройка поднимает порог над шумом комнаты", () => {
    const vad = newVad();
    vad.push(noise(4000, 0.02));   // «шумная» комната: RMS ≈ 0.0116 (−38.7 dBFS)
    const m = vad.metrics();
    // Порог обязан быть ВЫШЕ шума (иначе шум снова станет речью), но ниже речи.
    expect(m.thresholdDb).toBeGreaterThan(m.noiseFloorDb);
    expect(m.noiseFloorDb).toBeGreaterThan(-60);
  });

  it("после паузы порог не «схлопывается» в минимум", () => {
    const vad = newVad();
    vad.push(noise(3000, 0.02));
    const before = vad.metrics().thresholdDb;
    vad.push(silence(2000));       // цифровая тишина не должна обнулять шумовой пол
    const after = vad.metrics().thresholdDb;
    expect(after).toBeGreaterThan(before - 12);
    expect(after).toBeGreaterThan(-45);
  });

  it("речь после шумной комнаты всё равно распознаётся как чанк", () => {
    const vad = newVad();
    vad.push(noise(3000, 0.02));
    vad.push(silence(500));
    const closed = [...vad.push(speech(3000, 200, 0.3)), ...vad.push(silence(900))];
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(closed[0].speechRatio).toBeGreaterThan(0.5);
    expect(closed[0].rmsDb).toBeGreaterThan(-30);
  });

  it("тихая речь не теряется при низком пороге", () => {
    const vad = newVad();
    const closed = [...vad.push(speech(3000, 160, 0.05)), ...vad.push(silence(900))];
    expect(closed.length).toBeGreaterThanOrEqual(1);
  });

  it("метрики VAD отдают порог, шумовой пол и счётчики", () => {
    const vad = newVad();
    vad.push(speech(2000));
    const m = vad.metrics();
    expect(typeof m.thresholdDb).toBe("number");
    expect(typeof m.noiseFloorDb).toBe("number");
    expect(m.adaptive).toBe(true);
    expect(m.stats.frames).toBeGreaterThan(0);
  });

  /**
   * ГЛАВНЫЙ регресс жалобы «тишина/шум — отброшено VAD» + «в расшифровку попал
   * шум»: ровный шум комнаты оказался ГРОМЧЕ настроечного порога. Автопорог
   * обязан подняться над таким шумом и НЕ открывать на нём чанк, а речь должна
   * начинаться со своей метки, а не с нуля (раньше шум приклеивался к фразе).
   */
  it("ровный шум громче настроечного порога поднимает автопорог и не открывает чанк", () => {
    const vad = newVad({ rmsThreshold: 0.005 });   // порог ниже уровня комнаты
    const closed = [...vad.push(noise(3000, 0.02)), ...vad.push(silence(300))];
    expect(closed).toEqual([]);
    const m = vad.metrics();
    // Порог стал ВЫШЕ измеренного шума — значит шум больше не «речь».
    expect(m.noiseFloorDb).toBeGreaterThan(-60);
    expect(m.thresholdDb).toBeGreaterThan(m.noiseFloorDb);
  });

  it("шум перед первой фразой не склеивается с речью (startMs начинается с речи)", () => {
    const vad = newVad({ rmsThreshold: 0.005 });
    const closed = [
      ...vad.push(noise(3000, 0.02)),     // «шумная комната» с самого старта записи
      ...vad.push(speech(3000, 200, 0.3)), // речь лектора
      ...vad.push(silence(900)),
    ];
    expect(closed.length).toBeGreaterThanOrEqual(1);
    // Речь начинается на 3000 мс: чанк обязан стартовать около неё (пре-ролл 150 мс),
    // а не с нуля — иначе в Whisper уходили 3 с шума, а субтитры «уезжали».
    expect(closed[0].startMs).toBeGreaterThan(2500);
    expect(closed[0].endMs).toBeLessThanOrEqual(6100);
  });

  /**
   * Тихая речь раньше «травила» шумовой пол: 10-й процентиль её же кадров
   * поднимал порог выше речи, и лекция пропадала. Признак «ровности» (фон) её
   * не ловит: речь модулирована, значит пол остаётся неизвестным, а порог —
   * настроечным.
   */
  it("тихая речь не «травит» шумовой пол (пол остаётся неизвестным)", () => {
    const vad = newVad({ rmsThreshold: 0.005 });
    vad.push(silence(1000));
    const closed = [...vad.push(speech(3000, 200, 0.03)), ...vad.push(silence(900))]; // RMS ≈ −36 dBFS
    expect(closed.length).toBeGreaterThanOrEqual(1);
    // Речь распознана почти целиком (пауза на старте — 1 с).
    expect(closed[0].speechMs).toBeGreaterThan(2500);
    expect(vad.noiseFloor).toBe(0);
  });

  it("ровный тон (гул микрофона) не считается речью", () => {
    const vad = newVad();
    const closed = [...vad.push(tone(3000, 200, 0.25)), ...vad.push(silence(900))];
    expect(closed).toEqual([]);
  });
});

describe("VAD — измерители (используются в диагностике UI)", () => {
  it("zcrOf различает тон и шум", () => {
    expect(zcrOf(tone(100, 200))).toBeLessThan(0.1);
    expect(zcrOf(noise(100, 0.3))).toBeGreaterThan(0.3);
  });

  it("dbOf даёт −100 для тишины и отрицательные dBFS для сигнала", () => {
    expect(dbOf(0)).toBe(-100);
    expect(dbOf(0.5)).toBeLessThan(0);
    expect(dbOf(1)).toBe(0);
  });

  it("frameStats считает средний/пиковый RMS и статистику ZCR", () => {
    const frames = [tone(30, 200), silence(30)];
    const st = frameStats(frames);
    expect(st.frames).toBe(2);
    expect(st.rmsPeak).toBeGreaterThan(st.rmsAvg);
    expect(st.zcrStd).toBeGreaterThanOrEqual(0);
  });

  /** Регресс: без rmsStd величина modulation была NaN, и защита от стационарного шума не работала. */
  it("frameStats отдаёт rmsStd: по нему считается модуляция (речь vs ровный шум)", () => {
    const steady = frameStats([tone(30, 200), tone(30, 200), tone(30, 200), tone(30, 200)]);
    expect(steady.rmsStd).toBeCloseTo(0, 5);          // ровный сигнал не «дышит»
    // Разные фазы огибающей + тишина: уровни кадров расходятся — модуляция > 0.
    const phrase = speech(300, 200, 0.25);
    const mod = frameStats([
      phrase.slice(0, 480), phrase.slice(1120, 1600), phrase.slice(2880, 3360), silence(30),
    ]);
    expect(mod.rmsStd).toBeGreaterThan(0);
    expect(mod.rmsStd / mod.rmsAvg).toBeGreaterThan(0.1);
  });

  it("pass() сохраняет абсолютные таймкоды (для «Проверить пропуски»)", () => {
    const vad = newVad();
    vad.push(silence(1000));
    // Чанк закрывается паузой, поэтому второй вызов — тишина на абсолютном времени.
    // ВАЖНО: имя переменной не speech — иначе локальная перекрывает хелпер speech().
    const first = vad.pass(speech(3000), 60000);
    const closed = first.concat(vad.pass(silence(900), 63000));
    expect(closed.length).toBe(1);
    // startMs включает РЕАЛЬНЫЙ пре-ролл (150 мс), поэтому допуск 200 мс.
    expect(closed[0].startMs).toBeGreaterThanOrEqual(59800);
    expect(closed[0].startMs).toBeLessThanOrEqual(60000);
  });
});
/**
 * Серверные настройки аудиовхода и строки-пропуски VAD.
 *
 * ВАЖНО: storage подменяем на временный каталог ДО импорта server/*: config.js
 * читает MOONAPP_STORAGE при загрузке, иначе тест писал бы в рабочие настройки
 * проекта. Импорты динамические по той же причине.
 */
describe("Lecture — настройки аудио и пропуски VAD", () => {
  let lecture: any;
  let stmts: any;

  beforeAll(async () => {
    process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-audiotest-"));
    lecture = await import("../server/lecture");
    stmts = (await import("../server/db")).stmts;
  });

  it("audioSettings отдаёт порог в dBFS и границы для UI", () => {
    const s = lecture.audioSettings();
    expect(s.vad).toBeTruthy();
    expect(typeof s.vad.thresholdDb).toBe("number");
    expect(s.vad.thresholdDb).toBeLessThan(0);
    expect(s.limits.micGain).toEqual([0.5, 4]);
    expect(s.micAgc).toBe(false);
  });

  it("setAudioSettings зажимает значения в допустимые границы", () => {
    const s = lecture.setAudioSettings({
      micGain: 99,
      vad: { rmsThreshold: 5, minSpeechRatio: 9, thresholdFactor: 100 },
    });
    expect(s.micGain).toBe(4);
    expect(s.vad.rmsThreshold).toBeLessThanOrEqual(0.2);
    expect(s.vad.minSpeechRatio).toBe(1);
    expect(s.vad.thresholdFactor).toBeLessThanOrEqual(12);
  });

  it("сохраняет выбранный микрофон", () => {
    const s = lecture.setAudioSettings({ micDeviceId: "mic-abc" });
    expect(s.micDeviceId).toBe("mic-abc");
    expect(lecture.audioSettings().micDeviceId).toBe("mic-abc");
  });

  it("строка-пропуск VAD пишется с причиной и уровнем (без Whisper)", () => {
    const info = stmts.lectureInsert.run("тест", 16000, 1);
    const id = Number(info.lastInsertRowid);
    stmts.chunkInsertSkipped.run(id, 1, 1000, 4000, {
      reason: "noise", rmsDb: -44.2, rmsPeakDb: -38.1, speechRatio: 0.2,
      noiseDb: -52, thresholdDb: -46, zcr: 0.51, source: "mic",
    });
    const rows = stmts.chunkFor.all(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("vad_skip");
    expect(rows[0].reason).toBe("noise");
    expect(rows[0].rms_db).toBeCloseTo(-44.2, 1);
    expect(rows[0].threshold_db).toBeCloseTo(-46, 1);
    expect(rows[0].source).toBe("mic");
    expect(rows[0].file).toBe("");
  });

  it("«Проверить пропуски» отказывается работать на отсутствующей сессии", () => {
    expect(() => lecture.startRecheck(999999)).toThrow(/session_not_found/);
  });

  it("recheckState по умолчанию — idle", () => {
    const st = lecture.recheckState(999999);
    expect(st.state).toBe("idle");
    expect(st.found).toBe(0);
  });
});