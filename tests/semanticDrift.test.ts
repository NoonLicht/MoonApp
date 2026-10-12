import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Дрейф интересов и общие текстовые приёмы (semanticDrift.ts, textStats.ts). */
const req = createRequire(import.meta.url);
let d: any;
let ts: any;
beforeAll(() => {
  d = req("../server/semanticDrift");
  ts = req("../server/textStats");
});

const at = (y: number, m: number, day = 10) => new Date(y, m - 1, day, 12).getTime();
const doc = (y: number, m: number, text: string, source = "note") => ({ at: at(y, m), text, source });

describe("текстовые частоты", () => {
  it("объединяет формы слова по ключу и показывает частую форму", () => {
    const tc = ts.termCounts("энтропия энтропией энтропия и это очень важно");
    const k = ts.stemKey("энтропия");
    expect(tc.counts.get(k)).toBe(3);
    expect(tc.surface.get(k)).toBe("энтропия");
    expect(tc.counts.has("очень")).toBe(false); // стоп-слово
  });

  it("косинус одинаковых векторов 1, непересекающихся 0", () => {
    const a = new Map([["x", 1], ["y", 2]]);
    expect(ts.cosine(a, a)).toBeCloseTo(1, 5);
    expect(ts.cosine(a, new Map([["z", 3]]))).toBe(0);
  });
});

describe("дрейф интересов", () => {
  const docs = [
    doc(2026, 1, "Python программирование алгоритмы сортировка программирование алгоритмы"),
    doc(2026, 1, "программирование на Python: функции и алгоритмы", "bookmark"),
    doc(2026, 2, "Python программирование алгоритмы деревья графы"),
    doc(2026, 3, "Бег марафон тренировка пульс бег темп тренировка"),
    doc(2026, 3, "марафон питание восстановление бег тренировка"),
    doc(2026, 4, "Бег марафон тренировка Python программирование"),
  ];
  let r: any;
  beforeAll(() => {
    r = d.analyzeDrift(docs);
  });

  it("делит документы по месяцам и считает источники", () => {
    expect(r.months.map((m: any) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(r.months[0].docs).toBe(2);
    expect(r.months[0].bySource).toEqual({ note: 1, bookmark: 1 });
  });

  it("характерные слова месяца отражают тему месяца", () => {
    const jan = r.months[0].top.map((t: any) => t.term);
    const mar = r.months[2].top.map((t: any) => t.term);
    expect(jan).toContain("программирование");
    expect(mar).toContain("бег");
    expect(mar).not.toContain("программирование");
  });

  it("находит самый сильный сдвиг и новые темы", () => {
    expect(r.biggestShift.month).toBe("2026-03");
    expect(r.biggestShift.shift).toBeGreaterThan(0.8);
    expect(r.months[2].emerging).toEqual(expect.arrayContaining(["бег"]));
    expect(r.months[0].shift).toBeNull();
  });

  it("без документов — пустой отчёт", () => {
    expect(d.analyzeDrift([])).toEqual({ months: [], persistent: [], biggestShift: null, topOverall: null });
  });

  it("постоянные интересы — слова из топа большинства месяцев", () => {
    const only = d.analyzeDrift([
      doc(2026, 1, "дизайн интерфейсов прототип дизайн"),
      doc(2026, 2, "дизайн интерфейсов исследование"),
      doc(2026, 3, "дизайн интерфейсов тестирование"),
    ]);
    expect(only.persistent).toEqual(expect.arrayContaining(["дизайн"]));
  });
});
