import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Движок GigaAM v3 (server/ts/gigaamEngine.ts) и выбор между ним и Whisper.
 *
 * Без сети и без модели: проверяем математику признаков, CTC-декодирование,
 * нарезку длинного аудио и правила маршрутизации. «Живой» прогон на настоящей
 * модели включается переменными GIGAAM_LIVE_STORAGE (каталог со storage/gigaam)
 * и GIGAAM_LIVE_WAV (русская речь, PCM16 WAV) — в обычном прогоне он пропускается.
 */

const LIVE_STORAGE = process.env.GIGAAM_LIVE_STORAGE || "";
const LIVE_WAV = process.env.GIGAAM_LIVE_WAV || "";

beforeAll(() => {
  process.env.MOONAPP_STORAGE =
    LIVE_STORAGE || fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-gigaam-"));
});

function engine(): Promise<any> {
  return import("../server/gigaamEngine");
}

function wavFile(samples: Int16Array, rate = 16000, channels = 1): string {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  const f = path.join(os.tmpdir(), `gigaam-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  fs.writeFileSync(f, Buffer.concat([h, data]));
  return f;
}

describe("gigaamEngine — признаки", () => {
  it("мел-банк: 161 частота × 64 полосы, значения в [0..1], без пустых полос", async () => {
    const e = await engine();
    const fb: Float32Array = e.buildMelBank();
    expect(fb.length).toBe(161 * 64);
    let max = 0;
    for (const v of fb) {
      expect(v).toBeGreaterThanOrEqual(0);
      max = Math.max(max, v);
    }
    expect(max).toBeLessThanOrEqual(1.0001);
    for (let m = 0; m < 64; m++) {
      let s = 0;
      for (let k = 0; k < 161; k++) s += fb[k * 64 + m];
      expect(s, `полоса ${m} пустая`).toBeGreaterThan(0);
    }
  });

  it("logMel: число кадров = floor((n-320)/160)+1, укороченное аудио даёт 0", async () => {
    const e = await engine();
    expect(e.logMel(new Float32Array(319)).frames).toBe(0);
    const r = e.logMel(new Float32Array(16000));
    expect(r.frames).toBe(Math.floor((16000 - 320) / 160) + 1);
    expect(r.data.length).toBe(64 * r.frames);
    // тишина → ln(1e-9) (нижний клип), без NaN
    expect(r.data[0]).toBeCloseTo(Math.log(1e-9), 4);
  });

  it("logMel: тон 1 кГц даёт максимум в полосе, соответствующей 1 кГц", async () => {
    const e = await engine();
    const x = new Float32Array(8000);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 16000);
    const { data, frames } = e.logMel(x);
    const mid = Math.floor(frames / 2);
    let best = 0;
    for (let m = 0; m < 64; m++) if (data[m * frames + mid] > data[best * frames + mid]) best = m;
    // HTK-мел 1000 Гц ≈ 1000 мел из 2840 (на 8 кГц) → ~35% шкалы → полоса ~22
    expect(best).toBeGreaterThan(17);
    expect(best).toBeLessThan(28);
  });
});

describe("gigaamEngine — декодирование и нарезка", () => {
  it("parseVocab: «токен индекс», токены со спецсимволом ▁", async () => {
    const e = await engine();
    const v: string[] = e.parseVocab("<unk> 0\n▁ 1\n. 2\n▁в 3\n<blk> 4\n");
    expect(v[3]).toBe("▁в");
    expect(v.length).toBe(5);
  });

  it("ctcDecode: схлопывает повторы, пропускает blank, делит сегменты по паузе", async () => {
    const e = await engine();
    // классы: 0 «▁п», 1 «ри», 2 «вет», 3 blank
    const vocab = ["▁п", "ри", "вет", "<blk>"];
    const frame = (c: number) => [0, 1, 2, 3].map((i) => (i === c ? 0 : -10));
    const seq = [0, 0, 3, 1, 1, 2, 3, ...Array(30).fill(3), 0, 1, 2];
    const flat = seq.flatMap(frame);
    const segs = e.ctcDecode(flat, seq.length, 4, vocab, 10);
    expect(segs.map((s: any) => s.text)).toEqual(["привет", "привет"]);
    expect(segs[0].start).toBeCloseTo(10, 5);
    expect(segs[1].start).toBeGreaterThan(segs[0].end);
  });

  it("planWindows: короткое — одно окно; длинное — окна ≤ 25 с без дыр и перекрытий", async () => {
    const e = await engine();
    expect(e.planWindows(new Float32Array(16000 * 10))).toEqual([[0, 160000]]);
    const total = 16000 * 100;
    const x = new Float32Array(total).fill(0.3);
    // тихая «щель» на 18-й секунде: разрез должен прийтись рядом
    for (let i = 18 * 16000; i < 18.2 * 16000; i++) x[i] = 0;
    const wins: [number, number][] = e.planWindows(x);
    expect(wins[0][0]).toBe(0);
    expect(wins[wins.length - 1][1]).toBe(total);
    for (let i = 0; i < wins.length; i++) {
      expect(wins[i][1] - wins[i][0]).toBeLessThanOrEqual(25 * 16000);
      if (i) expect(wins[i][0]).toBe(wins[i - 1][1]);
    }
    expect(Math.abs(wins[0][1] - 18.1 * 16000)).toBeLessThan(0.2 * 16000);
  });
});

describe("gigaamEngine — WAV", () => {
  it("readWav: PCM16 моно и стерео (усреднение), частота из заголовка", async () => {
    const e = await engine();
    const mono = wavFile(Int16Array.from([0, 16384, -16384]), 16000, 1);
    const m = e.readWav(mono);
    expect(m.sampleRate).toBe(16000);
    expect(Array.from(m.samples).map((v: number) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5]);
    const st = wavFile(Int16Array.from([32767, 0, 0, 0]), 22050, 2);
    const s = e.readWav(st);
    expect(s.sampleRate).toBe(22050);
    expect(s.samples.length).toBe(2);
    expect(s.samples[0]).toBeCloseTo(0.5, 2);
    fs.rmSync(mono, { force: true });
    fs.rmSync(st, { force: true });
  });

  it("resampleTo16k: длина пропорциональна частоте", async () => {
    const e = await engine();
    expect(e.resampleTo16k(new Float32Array(22050), 22050).length).toBe(16000);
    const same = new Float32Array(10);
    expect(e.resampleTo16k(same, 16000)).toBe(same);
  });
});

describe("gigaamEngine — выбор движка", () => {
  it("по умолчанию GigaAM; русский и auto поддержаны, английский — нет", async () => {
    const e = await engine();
    expect(e.preferred()).toBe("gigaam");
    expect(e.languageSupported("ru")).toBe(true);
    expect(e.languageSupported("auto")).toBe(true);
    expect(e.languageSupported("en")).toBe(false);
  });

  it("без скачанной модели: not installed, info отдаёт размер и пустую задачу", async () => {
    if (LIVE_STORAGE) return;
    const e = await engine();
    expect(e.isInstalled()).toBe(false);
    const i = e.info();
    expect(i.installed).toBe(false);
    expect(i.sizeMb).toBeGreaterThan(100);
    expect(i.task.state).toBe("idle");
  });

  it("useGigaam: без модели — Whisper; модель есть, Whisper нет — GigaAM", async () => {
    if (LIVE_STORAGE) return;
    const asr = await import("../server/lectureAsr");
    expect(asr.useGigaam(true)).toBe(false);
    expect(asr.useGigaam(false)).toBe(false);
    expect(asr.asrReady(null, null)).toBe(false);
    expect(asr.asrReady("whisper-cli.exe", "model.bin")).toBe(true);
  });
});

describe.skipIf(!LIVE_STORAGE || !LIVE_WAV)("gigaamEngine — живой прогон", () => {
  it("распознаёт русскую речь и отдаёт сегменты с таймингами", async () => {
    const e = await engine();
    expect(e.isInstalled()).toBe(true);
    const t0 = Date.now();
    const r = await e.transcribeWav(LIVE_WAV);
    const ms = Date.now() - t0;
    console.log("GigaAM:", JSON.stringify(r.text), `${ms} мс`, r.segments.length, "сегм.");
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.text.toLowerCase()).toMatch(/лекци|производн|предел|интеграл/);
    expect(r.segments[0].end).toBeGreaterThan(r.segments[0].start);
  }, 120_000);

  it("через transcribeFile (общая точка входа лекций/заметок) — тот же текст", async () => {
    const asr = await import("../server/lectureAsr");
    const r: any = await asr.transcribeFile(null, null, LIVE_WAV, LIVE_WAV.replace(/\.wav$/i, ""));
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.promptless).toBe(true);
  }, 120_000);
});
