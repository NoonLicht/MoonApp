import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Тесты разделения говорящих (server/diarize.js).
 *
 * Сеть и бинарник sherpa НЕ трогаем: проверяем ЛОГИКУ — разбор вывода движка,
 * привязку сегментов к чанкам, настройки и подписи в экспорте. Строки вывода
 * взяты из живого прогона sherpa-onnx 1.13.8 на тестовом WAV (4 говорящих):
 *    0.318 -- 6.865 speaker_00
 *    progress 96.10%   (в stderr)
 *
 * ВАЖНО: модули грузим через createRequire (server/* — CJS), иначе динамический
 * import() даст второй экземпляр модуля со своим соединением к «БД».
 */
const req = createRequire(import.meta.url);

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-diarize-"));
});

function diarizeMod(): any {
  return req("../server/diarize");
}
function lectureMod(): any {
  return req("../server/lecture");
}

describe("диаризация — разбор вывода sherpa", () => {
  it("читает сегменты «start -- end speaker_NN»", async () => {
    const d = await diarizeMod();
    const out = [
      "OfflineSpeakerDiarizationConfig(segmentation=…)",
      "Started",
      "0.318 -- 6.865 speaker_00",
      " 7.017 -- 10.747 speaker_01",
      "11.455 -- 13.632 speaker_01",
      "",
      "33.680 -- 37.932 speaker_03",
    ].join("\n");
    const segs = d.parseSegments(out);
    expect(segs).toHaveLength(4);
    expect(segs[0]).toEqual({ start: 0.318, end: 6.865, speaker: 0 });
    expect(segs[3].speaker).toBe(3);
    // Мусор (конфиг, заголовки, прогресс) не попадает в сегменты.
    expect(segs.every((s: { end: number; start: number }) => s.end > s.start)).toBe(true);
  });

  it("игнорирует битые строки и нулевую длительность", async () => {
    const d = await diarizeMod();
    const segs = d.parseSegments(
      "speaker_00\n1.0 -- 1.0 speaker_00\nabc -- def speaker_1\n2.0 -- 3.5 speaker_2",
    );
    expect(segs).toEqual([{ start: 2.0, end: 3.5, speaker: 2 }]);
  });

  it("берёт прогресс из stderr («progress 42.50%»)", async () => {
    const d = await diarizeMod();
    expect(d.parseProgress("progress 0.00%\nprogress 42.50%")).toBe(43);
    expect(d.parseProgress("нет прогресса")).toBeNull();
  });
});

describe("диаризация — привязка говорящих к чанкам", () => {
  it("у чанка побеждает говорящий, звучавший дольше", async () => {
    const d = await diarizeMod();
    const chunks = [{ id: 1, start_ms: 0, end_ms: 10000 }];
    // Спикер 0 — 6 с, спикер 1 — 4 с: побеждает первый.
    const segs = [
      { start: 0, end: 6, speaker: 0 },
      { start: 6, end: 10, speaker: 1 },
    ];
    const map = d.assignSpeakers(chunks, segs);
    expect(map.get(1).speaker).toBe(0);
    expect(map.get(1).ratio).toBeCloseTo(0.6, 5);
  });

  it("показывает сомнение (ratio), когда голоса поделили чанк почти поровну", async () => {
    const d = await diarizeMod();
    const chunks = [{ id: 7, start_ms: 0, end_ms: 10000 }];
    const segs = [
      { start: 0, end: 5, speaker: 2 },
      { start: 5, end: 10, speaker: 3 },
    ];
    const map = d.assignSpeakers(chunks, segs);
    // ровно 50/50 — уверенности нет, экспорт и UI пометят это «?».
    expect(map.get(7).ratio).toBeCloseTo(0.5, 5);
    expect(map.get(7).speaker).toBe(2);
  });

  it("чанк без пересечений со сегментами остаётся без говорящего", async () => {
    const d = await diarizeMod();
    const map = d.assignSpeakers(
      [{ id: 5, start_ms: 0, end_ms: 1000 }],
      [{ start: 2, end: 3, speaker: 0 }],
    );
    expect(map.size).toBe(0);
  });

  it("сегменты вне чанка не влияют (границы учитываются точно)", async () => {
    const d = await diarizeMod();
    const chunks = [{ id: 1, start_ms: 10000, end_ms: 20000 }];
    const segs = [
      { start: 0, end: 9.9, speaker: 0 },
      { start: 10.1, end: 19.9, speaker: 4 },
    ];
    const map = d.assignSpeakers(chunks, segs);
    expect(map.get(1).speaker).toBe(4);
    expect(map.get(1).ratio).toBe(1);
  });
});
describe("диаризация — настройки и состояние пакета", () => {
  it("по умолчанию выключена (это минуты CPU, нельзя включать молча)", async () => {
    const d = await diarizeMod();
    const s = d.diarizeSettings();
    expect(s.enabled).toBe(false);
    expect(s.track).toBe("auto");
    expect(s.threshold).toBe(0.5);
    expect(s.speakers).toBe(-1); // -1 = определить автоматически
  });

  it("сохраняет настройки и зажимает значения в границы", async () => {
    const d = await diarizeMod();
    expect(
      d.setDiarizeSettings({ enabled: true, track: "mic", threshold: 0.65, speakers: 3 }),
    ).toMatchObject({ enabled: true, track: "mic", threshold: 0.65, speakers: 3 });
    // Вне границ — приводим к ближайшему допустимому.
    expect(d.setDiarizeSettings({ threshold: 5 }).threshold).toBe(0.9);
    expect(d.setDiarizeSettings({ speakers: 99 }).speakers).toBe(12);
    expect(() => d.setDiarizeSettings({ track: "both" })).toThrow(/diarize_track_unknown/);
    d.setDiarizeSettings({ enabled: false, track: "auto", threshold: 0.5, speakers: -1 });
  });

  it("setupInfo честно сообщает, что пакет не установлен", async () => {
    const d = await diarizeMod();
    const s = d.setupInfo();
    expect(s.ready).toBe(false);
    expect(s.engine.bin).toBeNull();
    expect(s.engine.version).toMatch(/^v\d/);
    // Три пакета: бинарь sherpa, сегментация, отпечаток голоса.
    expect(s.packages.map((p: { id: string }) => p.id)).toEqual(["bin", "seg", "emb"]);
    expect(s.packages.every((p: { installed: boolean }) => p.installed === false)).toBe(true);
    const totalMb = s.packages.reduce((n: number, p: { sizeMb: number }) => n + p.sizeMb, 0);
    expect(totalMb).toBeGreaterThan(50); // реально ~64 МБ
  });

  it("startDiarize без пакета — diarize_not_installed, без сессии — session_not_found", async () => {
    const d = await diarizeMod();
    const lecture = await lectureMod();
    const info = lecture.createSession("Без пакета", 16000, 1);
    expect(() => d.startDiarize(info.id)).toThrow(/diarize_not_installed/);
    expect(() => d.startDiarize(999999)).toThrow(/session_not_found/);
  });
});

describe("диаризация — подписи в экспорте", () => {
  /** Сессия с двумя дорожками и говорящими, найденными диаризацией. */
  async function sessionWithVoices() {
    const lecture = await lectureMod();
    const { stmts } = req("../server/db");
    const info = stmts.lectureInsert.run("Семинар", 16000, 1);
    const id = Number(info.lastInsertRowid);
    // Эфир: лектор (уверенно) и второй голос в эфире (сомнительно — 50/50).
    stmts.chunkInsert.run(id, 1, 0, 5000, "sys_00001.wav", {
      status: "done",
      text: "Лектор объясняет",
      source: "sys",
      speaker: "sys_0",
      speakerRatio: 0.92,
    });
    stmts.chunkInsert.run(id, 2, 5000, 9000, "sys_00002.wav", {
      status: "done",
      text: "Второй голос в эфире",
      source: "sys",
      speaker: "sys_1",
      speakerRatio: 0.5,
    });
    // Микрофон: двое студентов.
    stmts.chunkInsert.run(id, 3, 9000, 13000, "chunk_00003.wav", {
      status: "done",
      text: "Первый студент",
      source: "mic",
      speaker: "mic_0",
      speakerRatio: 0.9,
    });
    stmts.chunkInsert.run(id, 4, 13000, 17000, "chunk_00004.wav", {
      status: "done",
      text: "Второй студент",
      source: "mic",
      speaker: "mic_1",
      speakerRatio: 0.88,
    });
    return { lecture, id };
  }

  it("нумерует говорящих внутри дорожки: «Лектор 1», «Аудитория 2»", async () => {
    const d = await diarizeMod();
    const { id } = await sessionWithVoices();
    const names = d.speakerNames(id, { sys: "Лектор", mic: "Аудитория" });
    expect(names.sys_0).toBe("Лектор 1");
    expect(names.sys_1).toBe("Лектор 2");
    expect(names.mic_0).toBe("Аудитория 1");
    expect(names.mic_1).toBe("Аудитория 2");
  });

  it("один говорящий на дорожке — подпись без номера", async () => {
    const d = await diarizeMod();
    const { stmts } = req("../server/db");
    const info = stmts.lectureInsert.run("Один голос", 16000, 1);
    const id = Number(info.lastInsertRowid);
    stmts.chunkInsert.run(id, 1, 0, 5000, "sys_00001.wav", {
      status: "done",
      text: "Лектор",
      source: "sys",
      speaker: "sys_0",
      speakerRatio: 0.99,
    });
    expect(d.speakerNames(id, { sys: "Лектор", mic: "Аудитория" })).toEqual({ sys_0: "Лектор" });
  });

  it("SRT подписывает поимённо, а сомнительные чанки — со знаком «?»", async () => {
    const { lecture, id } = await sessionWithVoices();
    const out = lecture.exportContent(id, "srt", { mode: "dual", sys: "Лектор", mic: "Аудитория" });
    expect(out.body).toContain("— Лектор 1: Лектор объясняет");
    expect(out.body).toContain("— Аудитория 2: Второй студент");
    // 50/50 в чанке — экспорт обязан показать сомнение, а не выбрать наугад.
    expect(out.body).toContain("— Лектор 2?: Второй голос в эфире");
  });

  it("labels=off отключает подписи даже при диаризации", async () => {
    const { lecture, id } = await sessionWithVoices();
    const out = lecture.exportContent(id, "md", { mode: "off" });
    expect(out.body).not.toContain("**Лектор");
    expect(out.body).toContain("Лектор объясняет");
  });
});
describe("диаризация — нормализация номеров кластеров (applySpeakers)", () => {
  /** Сессия с чанками микрофона — как после реальной записи. */
  async function sessionWithChunks() {
    const lecture = await lectureMod();
    const { stmts } = req("../server/db");
    const info = stmts.lectureInsert.run("Нормализация", 16000, 1);
    const id = Number(info.lastInsertRowid);
    // Три чанка: 0-5 с, 5-10 с, 10-15 с (все дорожка микрофона).
    stmts.chunkInsert.run(id, 1, 0, 5000, "chunk_00001.wav", {
      status: "done",
      text: "раз",
      source: "mic",
    });
    stmts.chunkInsert.run(id, 2, 5000, 10000, "chunk_00002.wav", {
      status: "done",
      text: "два",
      source: "mic",
    });
    stmts.chunkInsert.run(id, 3, 10000, 15000, "chunk_00003.wav", {
      status: "done",
      text: "три",
      source: "mic",
    });
    return { lecture, stmts, id };
  }

  it("произвольные номера sherpa превращаются в 0..N−1 по времени появления", async () => {
    const d = await diarizeMod();
    const { stmts, id } = await sessionWithChunks();
    // Живой sherpa выдавал именно такие «дырявые» номера: 6 и 11 при 4 голосах.
    const speakers = d.applySpeakers(id, {
      mic: [
        { start: 0, end: 5, speaker: 6 },
        { start: 5, end: 10, speaker: 11 },
        { start: 10, end: 15, speaker: 6 },
      ],
    });
    // Говорящих двое, а не 12: подписи будут «Аудитория 1» и «Аудитория 2».
    expect(speakers).toBe(2);
    const chunks = stmts.chunkFor.all(id).sort((a: any, b: any) => a.idx - b.idx);
    expect(chunks.map((c: any) => c.speaker)).toEqual(["mic_0", "mic_1", "mic_0"]);
    expect(stmts.lectureGet.get(id).diarize_speakers).toBe(2);
    expect(stmts.lectureGet.get(id).diarize_at).toBeTruthy();
    expect(stmts.lectureGet.get(id).diarize_tracks).toBe("mic");
  });

  it("дорожки нумеруются независимо: эфир и микрофон не смешиваются", async () => {
    const d = await diarizeMod();
    const { stmts, id } = await sessionWithChunks();
    stmts.chunkInsert.run(id, 4, 0, 5000, "sys_00004.wav", {
      status: "done",
      text: "лектор",
      source: "sys",
    });
    const speakers = d.applySpeakers(id, {
      mic: [{ start: 0, end: 15, speaker: 2 }],
      sys: [{ start: 0, end: 5, speaker: 9 }],
    });
    expect(speakers).toBe(2); // mic_0 и sys_0 — это РАЗНЫЕ говорящие
    const names = d.speakerNames(id, { sys: "Лектор", mic: "Аудитория" });
    expect(names.mic_0).toBe("Аудитория");
    expect(names.sys_0).toBe("Лектор");
  });

  it("доля доминирующего голоса пишется в чанк (для пометки «?»)", async () => {
    const d = await diarizeMod();
    const { stmts, id } = await sessionWithChunks();
    d.applySpeakers(id, {
      mic: [
        { start: 0, end: 3, speaker: 0 },
        { start: 3, end: 5, speaker: 1 },
      ],
    });
    const first = stmts.chunkFor.all(id).find((c: any) => c.start_ms === 0);
    // 3 с из 5 — 0.6: уверенно, «?» не появится.
    expect(first.speakerRatio).toBeCloseTo(0.6, 2);
  });
});
