import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Инструменты заметок и учёбы (server/ts/noteTools.ts). */
const req = createRequire(import.meta.url);
let nt: any;
beforeAll(() => {
  nt = req("../server/noteTools");
});

describe("оглавление", () => {
  const md = "# Курс\n\n## Введение\n\n```\n# не заголовок\n```\n\n## Тема\n\n### Пункт\n\n## Тема\n";

  it("игнорирует код и различает повторяющиеся заголовки", () => {
    expect(nt.headings(md).map((h: any) => h.slug)).toEqual(["курс", "введение", "тема", "пункт", "тема-1"]);
  });

  it("строит вложенный список", () => {
    expect(nt.buildToc(md, 3)).toBe(
      ["- [Курс](#курс)", "  - [Введение](#введение)", "  - [Тема](#тема)", "    - [Пункт](#пункт)", "  - [Тема](#тема-1)"].join("\n"),
    );
  });

  it("applyToc вставляет после H1 и обновляет без дублей", () => {
    const once = nt.applyToc(md);
    expect(once).toContain("<!-- toc -->");
    expect(once.indexOf("<!-- toc -->")).toBeGreaterThan(once.indexOf("# Курс"));
    const twice = nt.applyToc(once.replace("## Введение", "## Введение и цели"));
    expect(twice.match(/<!-- toc -->/g)).toHaveLength(1);
    expect(twice).toContain("[Введение и цели](#введение-и-цели)");
  });
});

describe("MOC и трансклюзия", () => {
  it("MOC группирует по папкам", () => {
    const moc = nt.buildMoc([
      { path: "Физика/Волны.md", title: "Волны", tags: ["#физика"] },
      { path: "Физика/Атомы.md", title: "Атомы", tags: [] },
      { path: "Идеи.md", title: "Идеи", tags: [] },
    ]);
    expect(moc).toContain("## Физика\n\n- [[Атомы]]\n- [[Волны]] — #физика");
    expect(moc).toContain("## Без папки\n\n- [[Идеи]]");
  });

  const notes: Record<string, string> = {
    A: "Начало\n![[B]]\nКонец",
    B: "# Заголовок\n\n## Раздел 1\nтекст 1\n\n## Раздел 2\nтекст 2",
    C: "![[C]]",
  };
  const resolve = (n: string) => (n in notes ? notes[n] : null);

  it("разворачивает заметку и раздел", () => {
    expect(nt.expandTransclusions("![[B#Раздел 1]]", resolve)).toBe("текст 1");
    expect(nt.expandTransclusions("![[A]]", resolve)).toContain("текст 2");
  });

  it("цикл, отсутствие и картинки обрабатываются без падения", () => {
    expect(nt.expandTransclusions("![[C]]", resolve)).toContain("цикл трансклюзии");
    expect(nt.expandTransclusions("![[Нет]]", resolve)).toContain("не найдена");
    expect(nt.expandTransclusions("![[pic.png]]", resolve)).toBe("![[pic.png]]");
  });
});

describe("паразиты, приватное, глоссарий", () => {
  it("считает слова-паразиты вне кода", () => {
    const r = nt.findParasites("Ну это типа важно, короче. Ну да.\n```\nтипа код\n```");
    expect(r.hits).toEqual([
      { word: "ну", count: 2 },
      { word: "типа", count: 1 },
      { word: "короче", count: 1 },
    ]);
    expect(r.total).toBe(4);
  });

  it("stripPrivate вырезает блоки и комментарии", () => {
    const md = "Публично\n\n::: private\nсекрет\n:::\n\nещё %%скрытое%% текст";
    expect(nt.stripPrivate(md)).toBe("Публично\n\nещё  текст");
  });

  it("глоссарий из выделенных терминов без дублей", () => {
    const md = "- **Энтропия** — мера неопределённости\n**Информация**: сведения\n**энтропия** — повтор\n```\n**Код** — не термин\n```";
    expect(nt.extractGlossary(md)).toEqual([
      { term: "Информация", definition: "сведения" },
      { term: "Энтропия", definition: "мера неопределённости" },
    ]);
  });
});

describe("повторения", () => {
  it("SM-2: интервалы растут, провал сбрасывает", () => {
    let c = nt.NEW_CARD;
    c = nt.sm2(c, 5);
    expect(c.interval).toBe(1);
    c = nt.sm2(c, 5);
    expect(c.interval).toBe(6);
    c = nt.sm2(c, 4);
    expect(c.interval).toBeGreaterThan(6);
    const failed = nt.sm2(c, 1);
    expect(failed).toMatchObject({ interval: 1, repetitions: 0 });
    expect(failed.ease).toBeGreaterThanOrEqual(1.3);
  });

  it("план повторений от даты", () => {
    expect(nt.reviewPlan("2026-03-01", [1, 7])).toEqual(["2026-03-02", "2026-03-08"]);
  });
});

describe("формулы в таблицах", () => {
  it("SUM, AVG и арифметика по ячейкам; повторный прогон обновляет значения", () => {
    const md = [
      "| Товар | Цена | Кол-во | Сумма |",
      "|---|---|---|---|",
      "| Хлеб | 50 | 2 | =B2*C2 |",
      "| Молоко | 80 | 3 | =B3*C3 |",
      "| Итого |  |  | =SUM(D2:D3) |",
    ].join("\n");
    const r = nt.evaluateTables(md);
    expect(r.evaluated).toBe(3);
    expect(r.text).toContain("| Хлеб | 50 | 2 | 100 <!--=B2*C2--> |");
    expect(r.text).toContain("340 <!--=SUM(D2:D3)-->");
    // меняем цену и считаем заново по сохранённой формуле
    const again = nt.evaluateTables(r.text.replace("| 50 |", "| 60 |"));
    expect(again.text).toContain("120 <!--=B2*C2-->");
    expect(again.text).toContain("360 <!--=SUM(D2:D3)-->");
  });

  it("небезопасное выражение не вычисляется", () => {
    const md = "| a | b |\n|---|---|\n| 1 | =alert(1) |";
    expect(nt.evaluateTables(md).evaluated).toBe(0);
  });
});

describe("долги графа, цитатник, слайды", () => {
  const notes = [
    { path: "a.md", title: "А", content: "См. [[Б]] и [[Нет такой]] и [[task:1]]\n```\n[[В коде]]\n```" },
    { path: "b.md", title: "Б", content: "Снова [[нет такой|подпись]]\n> Хорошая длинная цитата про знания\n> и продолжение мысли\n\n> [!note] выноска, не цитата" },
  ];

  it("находит ссылки на несуществующие заметки и считает их", () => {
    const d = nt.unresolvedLinks(notes);
    expect(d).toEqual([{ target: "Нет такой", count: 2, from: ["a.md", "b.md"] }]);
  });

  it("цитаты — блоки >, без выносок и коротких", () => {
    const q = nt.extractQuotes(notes);
    expect(q).toEqual([{ text: "Хорошая длинная цитата про знания и продолжение мысли", source: "Б" }]);
  });

  it("слайды: разбиение по --- и заголовкам, приватное вырезано, HTML экранирован", () => {
    const html = nt.toSlidesHtml("## Один\n- пункт <b>\n\n---\n## Два\nтекст\n\n::: private\nсекрет\n:::", "T");
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("секрет");
    const byH = nt.toSlidesHtml("# Титул\n\n## A\nx\n\n## B\ny");
    expect(byH.match(/<section/g)?.length).toBe(3);
  });
});
