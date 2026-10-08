// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { chandraToMarkdown } from "../src/lib/chandraMarkdown";

/** Ответ Chandra OCR 2 на страницу лекции (снят с реальной модели). */
const PAGE =
  '<div data-bbox="53 45 501 92" data-label="Section-Header"><h1>Лекция 3. Законы Ньютона</h1></div>' +
  '<div data-bbox="51 123 684 188" data-label="Text"><p>Первый закон: тело сохраняет покой.</p></div>' +
  '<div data-bbox="51 211 634 241" data-label="Text"><p>Второй закон: <math>F = m \\cdot a</math>, где <math>m</math> — масса.</p></div>' +
  '<div data-bbox="48 285 644 511" data-label="Table"><table border="1"><thead><tr><th>Величина</th><th>Обозначение</th><th>Единица</th></tr></thead>' +
  "<tbody><tr><td>Масса</td><td><math>m</math></td><td>кг</td></tr><tr><td>Сила</td><td><math>F</math></td><td>Н</td></tr></tbody></table></div>" +
  '<div data-bbox="51 556 440 586" data-label="Caption"><p>Рис. 1. Зависимость скорости от времени</p></div>' +
  '<div data-bbox="59 616 500 940" data-label="Figure"><img alt="Graph of velocity v versus time t."/><p>A graph with a blue line.</p></div>' +
  '<div data-bbox="0 0 1000 40" data-label="Page-Header"><p>Колонтитул</p></div>' +
  '<div data-bbox="542 775 987 806" data-label="Text"><p>Вывод: скорость растёт.</p></div>';

describe("chandraToMarkdown", () => {
  it("превращает блоки в Markdown, а рисунок вырезает и подставляет ссылкой", async () => {
    const crops: number[][] = [];
    const md = await chandraToMarkdown(PAGE, async (bbox) => {
      crops.push(bbox);
      return "/api/myspace/assets/abc";
    });
    expect(crops).toEqual([[59, 616, 500, 940]]);
    expect(md).toBe(
      [
        "# Лекция 3. Законы Ньютона",
        "Первый закон: тело сохраняет покой.",
        "Второй закон: $F = m \\cdot a$, где $m$ — масса.",
        "| Величина | Обозначение | Единица |\n| --- | --- | --- |\n| Масса | $m$ | кг |\n| Сила | $F$ | Н |",
        "Рис. 1. Зависимость скорости от времени",
        "![Graph of velocity v versus time t.](/api/myspace/assets/abc)",
        "Вывод: скорость растёт.",
      ].join("\n\n"),
    );
  });

  it("колонтитулы отбрасываются, а без вырезанной картинки остаётся описание", async () => {
    const md = await chandraToMarkdown(PAGE, async () => null);
    expect(md).not.toContain("Колонтитул");
    expect(md).toContain("*Graph of velocity v versus time t.*");
  });

  it("списки, чекбоксы, объединённые ячейки и блоки кода", async () => {
    const html =
      '<div data-label="List-Group"><ul><li>один<ul><li>вложенный</li></ul></li><li><input type="checkbox" checked/> готово</li></ul></div>' +
      '<div data-label="Table"><table><tr><th colspan="2">Итого</th></tr><tr><td rowspan="2">A</td><td>1</td></tr><tr><td>2</td></tr></table></div>' +
      '<div data-label="Code-Block"><pre>x = 1\ny = 2</pre></div>';
    const md = await chandraToMarkdown("```html\n" + html + "\n```", async () => null);
    expect(md).toContain("- один\n  - вложенный\n- [x] готово");
    expect(md).toContain("| Итого |  |\n| --- | --- |\n| A | 1 |\n|  | 2 |");
    expect(md).toContain("```\nx = 1\ny = 2\n```");
  });
});
