import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Уверенность, происхождение абзацев, рецензент, следы решений. */
const req = createRequire(import.meta.url);
let conf: any;
let prov: any;
let rv: any;
let dt: any;
beforeAll(() => {
  conf = req("../server/confidence");
  prov = req("../server/provenance");
  rv = req("../server/reviewer");
  dt = req("../server/decisionTraces");
});

const DAY = 86_400_000;
const T0 = new Date(2026, 0, 10, 12).getTime();

describe("градус уверенности", () => {
  it("разбирает метки со сроком и без", () => {
    const m = conf.parseMarks(
      "Текст {70%: рынок вырастет в этом году}. И ещё {40% до 2026-12-01: запуск успеем} и {150%: мимо}.",
    );
    expect(m.map((x: any) => [x.pct, x.claim, x.due])).toEqual([
      [70, "рынок вырастет в этом году", null],
      [40, "запуск успеем", "2026-12-01"],
    ]);
  });

  it("синхронизация не дублирует и обновляет процент до проверки", () => {
    let r = conf.syncNote([], "a.md", "{70%: дождь завтра}", T0);
    expect(r.added).toBe(1);
    expect(r.entries[0].due).toBe("2026-02-09");
    r = conf.syncNote(r.entries, "a.md", "{80%: дождь завтра}", T0 + DAY);
    expect(r.added).toBe(0);
    expect(r.entries[0].pct).toBe(80);
    const id = r.entries[0].id;
    const done = conf.resolve(r.entries, id, true, T0 + 2 * DAY);
    const again = conf.syncNote(done, "a.md", "{10%: дождь завтра}", T0 + 3 * DAY);
    expect(again.entries[0].pct).toBe(80); // после проверки не меняется
  });

  it("срок наступил — запись в очереди; калибровка видит переоценку", () => {
    const mk = (pct: number, outcome: boolean | null, due = "2026-01-01") => ({
      id: String(Math.random()),
      path: "a.md",
      claim: "x",
      pct,
      due,
      createdAt: 0,
      outcome,
      resolvedAt: null,
    });
    const list = [mk(90, false), mk(90, true), mk(90, false), mk(30, false), mk(60, null, "2026-05-01")];
    expect(conf.dueEntries(list, "2026-02-01")).toHaveLength(0);
    expect(conf.dueEntries(list, "2026-06-01")).toHaveLength(1);
    const c = conf.calibration(list);
    expect(c.resolved).toBe(4);
    expect(c.bias).toBeGreaterThan(0); // говорил 90 — сбылось 33
    const top = c.buckets.find((b: any) => b.from === 80);
    expect(top).toMatchObject({ n: 3, predicted: 90, actual: 33 });
    expect(c.brier).toBeGreaterThan(0.25);
  });
});

describe("происхождение абзацев", () => {
  const aiText =
    "Градиентный спуск минимизирует функцию потерь шагами против направления градиента каждый раз пересчитывая параметры.";
  const own = "Сегодня я вернулся домой пешком и долго думал о проекте, который мы начали весной.";

  it("абзац из ИИ и вставленный распознаются, свой остаётся своим", () => {
    let s = prov.record({}, "n.md", aiText, "ai", 1);
    s = prov.record(s, "n.md", "Цитата из статьи про внимание: оно ограничено и распределяется между задачами по приоритетам.", "copied", 2);
    const text = `${own}\n\n${aiText}\n\nЦитата из статьи про внимание: оно ограничено и распределяется между задачами по приоритетам.`;
    const p = prov.classify(s, "n.md", text);
    expect(p.map((x: any) => x.origin)).toEqual(["own", "ai", "copied"]);
    const sum = prov.summarize(p);
    expect(sum.pct.own + sum.pct.ai + sum.pct.copied).toBeGreaterThanOrEqual(99);
  });

  it("лёгкая правка вставленного не снимает метку, переписанное — снимает", () => {
    const s = prov.record({}, "n.md", aiText, "ai", 1);
    const edited = aiText.replace("минимизирует", "уменьшает");
    expect(prov.classify(s, "n.md", edited)[0].origin).toBe("ai");
    expect(prov.classify(s, "n.md", "Совсем другой текст про совершенно иные вещи и темы вообще.")[0].origin).toBe("own");
  });

  it("метки привязаны к заметке; перенос сохраняет", () => {
    let s = prov.record({}, "a.md", aiText, "ai", 1);
    expect(prov.classify(s, "b.md", aiText)[0].origin).toBe("own");
    s = prov.move(s, "a.md", "c.md");
    expect(prov.classify(s, "c.md", aiText)[0].origin).toBe("ai");
  });

  it("абзацы режутся по пустым строкам с позициями", () => {
    const p = prov.paragraphs("один\nдва\n\nтри");
    expect(p).toEqual([
      { start: 0, end: 8, text: "один\nдва" },
      { start: 10, end: 13, text: "три" },
    ]);
  });
});

describe("рецензент", () => {
  it("оставляет только вопросы и вытаскивает цитату", () => {
    const q = rv.parseQuestions(
      "Вот мои замечания:\n1. («рост на 40%») Чем подтверждается эта цифра?\n- Перепишите введение.\n" +
        "* Для кого вы это пишете?\n* Для кого вы это пишете?\nМожет, лучше короче?",
    );
    expect(q).toEqual([
      { quote: "рост на 40%", question: "Чем подтверждается эта цифра?" },
      { quote: "", question: "Для кого вы это пишете?" },
      { quote: "", question: "Может, лучше короче?" },
    ]);
  });

  it("промпт запрещает переписывать", () => {
    expect(rv.buildReviewPrompt("текст ".repeat(20), "evidence")).toMatch(/НЕ переписывай/);
  });
});

describe("следы решений", () => {
  it("создаёт след со сроком через полгода и собирает контекст", () => {
    const t = dt.createTrace(
      {
        kind: "note",
        ref: "a.md",
        title: "Переезд",
        decision: "Переезжаю в другой город",
        context: dt.contextBlocks({
          related: [{ title: "Работа", snippet: "предложение" }],
          diary: "Тяжёлый день",
          budget: { balance: 1000, income: 5000, expense: 4000 },
          date: "2026-01-10",
        }),
      },
      T0,
    );
    expect(t.reviewAt).toBe(T0 + 180 * DAY);
    expect(t.context.map((c: any) => c.kind)).toEqual(["related", "diary", "budget"]);
  });

  it("очередь возвращает просроченные; итоги считают долю правоты", () => {
    const a = dt.createTrace({ kind: "note", ref: "", title: "A", decision: "a", context: [], reviewInDays: 10 }, T0);
    const b = dt.createTrace({ kind: "expense", ref: "", title: "B", decision: "b", context: [], reviewInDays: 400 }, T0);
    expect(dt.due([a, b], T0 + 11 * DAY).map((t: any) => t.title)).toEqual(["A"]);
    let all = dt.review([a, b], a.id, "partly", "почти", T0 + 12 * DAY);
    all = dt.review(all, b.id, "right", "", T0 + 13 * DAY);
    expect(dt.due(all, T0 + 999 * DAY)).toEqual([]);
    expect(dt.trackRecord(all)).toMatchObject({ reviewed: 2, right: 1, partly: 1, score: 75 });
    expect(dt.update(all, a.id, { reason: "потому что" })[0].reason).toBe("потому что");
  });
});
