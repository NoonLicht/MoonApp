import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Главы лекции по расшифровке (server/ts/lectureChapters.ts). */
const req = createRequire(import.meta.url);
let lc: any;
beforeAll(() => {
  lc = req("../server/lectureChapters");
});

const chunk = (startSec: number, text: string, lenSec = 20) => ({
  start_ms: startSec * 1000,
  end_ms: (startSec + lenSec) * 1000,
  text,
});

describe("buildChapters", () => {
  const physics = [
    "Электрический заряд создаёт электрическое поле вокруг себя",
    "Напряжённость электрического поля измеряется в вольтах на метр",
    "Заряд и поле связаны законом Кулона между зарядами",
  ];
  const history = [
    "Римская империя достигла наибольшего расширения при императоре Траяне",
    "Римские легионы охраняли границы империи вдоль Рейна и Дуная",
    "Падение Западной Римской империи произошло в пятом веке",
  ];

  it("делит запись на главы там, где меняется тема", () => {
    const chunks = [...physics, ...physics].map((t, i) => chunk(i * 20, t));
    const hist = [...history, ...history].map((t, i) => chunk(120 + i * 20, t));
    const ch = lc.buildChapters([...chunks, ...hist], { minMs: 60_000 });
    expect(ch.length).toBe(2);
    expect(ch[0].startMs).toBe(0);
    expect(ch[1].startMs).toBe(120_000);
    expect(ch[0].title).toMatch(/электр|заряд|поле/i);
    expect(ch[1].title).toMatch(/римск|импер/i);
  });

  it("одна тема — одна глава", () => {
    const chunks = [...physics, ...physics].map((t, i) => chunk(i * 20, t));
    expect(lc.buildChapters(chunks).length).toBe(1);
  });

  it("слишком короткие главы не создаются", () => {
    const mixed = [...physics, ...history].map((t, i) => chunk(i * 10, t, 10));
    expect(lc.buildChapters(mixed, { minMs: 120_000 }).length).toBe(1);
  });

  it("пустой ввод и пустые отрывки", () => {
    expect(lc.buildChapters([])).toEqual([]);
    expect(lc.buildChapters([chunk(0, "   ")])).toEqual([]);
  });
});
