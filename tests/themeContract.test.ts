import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Контракт тем и акцентов: список в настройках, цикл кнопки в тулбаре и CSS
 * должны совпадать. Проверка появилась вместе с темами midnight/sand и акцентами
 * sky/rose: раньше значение из селекта можно было «добавить», забыв стили — и
 * тема молча не применялась (в CSS нет `.app-shell.theme-<id>`).
 *
 * DOM-тестов в проекте нет (SSR не выполняет эффекты), поэтому смотрим исходники.
 */
const root = path.resolve(__dirname, "..");
const settingsSrc = fs.readFileSync(
  path.join(root, "src", "pages", "settings", "SettingsPage.tsx"),
  "utf8",
);
const appSrc = fs.readFileSync(path.join(root, "src", "app", "App.tsx"), "utf8");
const themeCss = fs.readFileSync(path.join(root, "src", "styles", "theme.css"), "utf8");

/** Значения из опций селекта: { value: "x", label: t("settings.<prefix>…") }. */
function optionValues(prefix: string): string[] {
  const re = new RegExp(`[{] value: "([a-z]+)", label: t[(]"settings[.]${prefix}`, "g");
  return [...settingsSrc.matchAll(re)].map((m) => m[1]);
}
const themeValues = optionValues("theme");
const accentValues = optionValues("accent");

describe("Темы и акценты: селект ↔ CSS ↔ кнопка в тулбаре", () => {
  it("в настройках есть все темы и акценты (включая новые)", () => {
    expect(themeValues).toEqual(["dark", "midnight", "oled", "light", "sand"]);
    expect(accentValues).toEqual(["amber", "violet", "teal", "coral", "sky", "rose"]);
  });

  it("каждой теме и акценту из настроек соответствует правило в theme.css", () => {
    for (const th of themeValues) {
      expect(themeCss, `нет .app-shell.theme-${th}`).toContain(`.app-shell.theme-${th} {`);
      // Палитра темы задаёт фон и текст — иначе тема «пустая».
      const block = themeCss.slice(themeCss.indexOf(`.app-shell.theme-${th} {`));
      const body = block.slice(0, block.indexOf("}"));
      expect(body, `тема ${th}: нет --bg-base`).toContain("--bg-base:");
      expect(body, `тема ${th}: нет --text-primary`).toContain("--text-primary:");
    }
    for (const ac of accentValues) {
      expect(themeCss, `нет .app-shell.accent-${ac}`).toContain(`.app-shell.accent-${ac} {`);
    }
  });

  it("кнопка темы в тулбаре листает ВСЕ темы из настроек", () => {
    const cycle = /const THEME_CYCLE = \[([^\]]+)\]/.exec(appSrc)?.[1] ?? "";
    for (const th of themeValues) {
      expect(cycle, `THEME_CYCLE без "${th}"`).toContain(`"${th}"`);
    }
  });

  it("новые темы наследуют семейство светлой/тёмной (точечные правки CSS)", () => {
    // Правки вида `.theme-light .foo` и иконка кнопки темы завязаны на семейство.
    expect(appSrc).toContain('theme === "light" || theme === "sand" ? "theme-light" : "theme-dark"');
    // OLED — отдельное оформление, ему семейство не добавляем (иначе кнопка темы
    // покажет луну вместо иконки контраста).
    expect(appSrc).toContain('if (theme === "oled") return "";');
  });
});
