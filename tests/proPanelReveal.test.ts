import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Раскрытие Pro-настроек и аккордеонов на странице «Голос».
 *
 * Реальная жалоба пользователя: «кнопка нажимается, но снизу ничего не
 * появляется». Причина была в CSS: у `.ab-pro-collapse`/`.ab-acc-collapse` в
 * закрытом состоянии стоит `grid-template-rows: 0fr`, а правила для `.is-open`
 * не существовало — узел появлялся в DOM, но его высота оставалась нулевой.
 *
 * Тест держит это свойство в двух местах: правило в pages.css и класс в разметке
 * страницы (иначе раскрытие снова «сломается молча»).
 */
const root = process.cwd();
const css = fs.readFileSync(path.join(root, "src/styles/pages.css"), "utf8");
const page = fs.readFileSync(path.join(root, "src/pages/voice/AudiobookTTSPage.tsx"), "utf8");

describe("pages.css: раскрытие Pro-настроек и аккордеонов", () => {
  it("у открытого состояния задана высота строки 1fr", () => {
    expect(
      /\.ab-acc-collapse\.is-open,\s*\.ab-pro-collapse\.is-open\s*\{[^}]*grid-template-rows:\s*1fr/.test(
        css,
      ),
    ).toBe(true);
  });

  it("закрытое состояние по-прежнему нулевое (анимация есть с обеих сторон)", () => {
    expect(/\.ab-pro-collapse\s*\{[^}]*grid-template-rows:\s*0fr/s.test(css)).toBe(true);
    expect(/\.ab-acc-collapse\s*\{[^}]*grid-template-rows:\s*0fr/s.test(css)).toBe(true);
  });

  it("правило .is-open идёт после базового: порядок виден при чтении файла", () => {
    const base = css.indexOf(".ab-pro-collapse {");
    const open = css.indexOf(".ab-pro-collapse.is-open");
    expect(base).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(base);
  });

  it("внутренний блок прокручиваем и сжимаем — без этого 1fr не раскрывается", () => {
    expect(/\.ab-pro-inner\s*\{[^}]*min-height:\s*0/s.test(css)).toBe(true);
    expect(/\.ab-pro-inner\s*\{[^}]*overflow:\s*hidden/s.test(css)).toBe(true);
    expect(/\.ab-acc-collapse\s*>\s*\.ab-acc-body\s*\{[^}]*min-height:\s*0/s.test(css)).toBe(true);
  });
});

describe("страница «Голос»: класс is-open ставится по состоянию тумблера", () => {
  it("Pro-панель получает is-open, когда proOpen", () => {
    expect(page).toMatch(/ab-pro-collapse \$\{proOpen \? "is-open" : ""\}/);
  });

  it("аккордеоны — через общий toggleAcc (id состояния из openAcc)", () => {
    expect(page).toMatch(/ab-acc-collapse \$\{open \? "is-open" : ""\}/);
    expect(page).toMatch(/const toggleAcc = useCallback/);
  });

  it("рабочая область сворачивается отдельно для каждой вкладки", () => {
    expect(page).toMatch(/ab-acc-collapse \$\{wsIsOpen \? "is-open" : ""\}/);
  });
});
