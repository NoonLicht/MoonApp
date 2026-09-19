import React from "react";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { renderToString } from "react-dom/server";
import { I18nProvider, useI18n } from "@/app/i18n";
import TrackerSearch from "@/pages/movies/parts/TrackerSearch";

/**
 * Вкладка «Поиск раздач» в плеере.
 *
 * Проверяем в SSR то, что видит пользователь при открытии вкладки: название
 * открытого фильма уже подставлено в строку поиска (автопоиск выполняется в
 * эффекте — на сервере эффектов нет, поэтому здесь проверяем именно подстановку),
 * а блок «Куки из браузера» на месте — он нужен, когда форум закрыт Cloudflare.
 */
function render(node: React.ReactElement): string {
  return renderToString(React.createElement(I18nProvider, { lang: "ru" }, node));
}

describe("TrackerSearch", () => {
  it("подставляет название открытого фильма в строку поиска", () => {
    const html = render(
      React.createElement(TrackerSearch, { onOpenRelease: () => {}, initialQuery: "Матрица" }),
    );
    expect(html).toContain('value="Матрица"');
    expect(html).toContain("Найти");
    expect(html).toContain("Проверить");
    // Запасные пути получения куки (когда окно входа недоступно / не помогло).
    expect(html).toContain("Подхватить из браузера");
    expect(html).toContain("Вставить вручную");
    // Кнопка сброса входа появляется только при живой сессии (в SSR статус ещё
    // не загружен — серверных вызовов нет), поэтому здесь её быть не должно.
    expect(html).not.toContain("Сбросить вход");
  });

  it("без названия строка поиска пустая", () => {
    const html = render(React.createElement(TrackerSearch, { onOpenRelease: () => {} }));
    expect(html).toContain("Что искать");
    expect(html).not.toContain('value="Матрица"');
  });

  /**
   * Окно входа — часть приложения. В браузере (моста нет) кнопки быть не может:
   * вместо неё должно быть объяснение, что делать, и раскрытая ручная вставка.
   */
  it("в браузере: объясняет, что окно входа только в приложении", () => {
    const html = render(React.createElement(TrackerSearch, { onOpenRelease: () => {} }));
    expect(html).toContain("Окно входа доступно только в приложении MoonApp");
    expect(html).toContain("npm start");
    // Кнопки-действия нет (в тексте подсказки её название упоминается — сверяем разметку).
    expect(html).not.toContain("<span>Войти на форум</span>");
  });

  /** Мост Electron есть → кнопка окна входа обязана быть (без ожидания статуса). */
  it("в приложении: показывает кнопку входа через окно", () => {
    const g = globalThis as unknown as { window?: { appBridge?: unknown } };
    const had = "window" in g;
    const prev = g.window;
    g.window = { appBridge: { openTrackerLogin: () => undefined } };
    try {
      const html = render(React.createElement(TrackerSearch, { onOpenRelease: () => {} }));
      expect(html).toContain("<span>Войти на форум</span>");
      expect(html).not.toContain("Окно входа доступно только в приложении MoonApp");
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });
/**
 * Ключи переключателя трекеров.
 *
 * Компонент строит ключ названия трекера ДИНАМИЧЕСКИ (`movies.trackerPreset_<id>`
 * в presetLabel), поэтому опечатка в i18n проявилась бы сырым ключом прямо в списке
 * выбора. Проверяем, что перевод есть и в русском, и в английском (остальные локали
 * откатываются на английский — как и все tracker-ключи).
 */
function TrackerKeysProbe() {
  const { t } = useI18n();
  return (
    <span>
      {t("movies.trackerPreset")}|{t("movies.trackerPreset_rutracker")}|
      {t("movies.trackerPreset_rutor")}|{t("movies.trackerNoLoginNeeded")}|
      {t("movies.trackerPresetSwitched")}
    </span>
  );
}

describe("TrackerSearch — i18n переключателя трекеров", () => {
  it.each(["ru", "en"])("%s: названия трекеров и подсказки переведены", (lang) => {
    const html = renderToString(
      React.createElement(I18nProvider, { lang }, React.createElement(TrackerKeysProbe)),
    );
    // Ни одного сырого ключа: иначе пользователь увидит «movies.trackerPreset_rutor».
    expect(html).not.toContain("movies.tracker");
    expect(html).toContain("RuTracker");
    expect(html).toContain("RuTor");
  });
});

/**
 * Фильтры выдачи (разрешение и сиды).
 *
 * Сиды — это те, кто раздаёт файл: их число и определяет скорость скачивания,
 * поэтому порог по сидам важнее остальных фильтров. В SSR списка раздач нет
 * (запрос идёт в эффекте), поэтому проверяем исходник: правило фильтра и то, что
 * селект «Сиды» предлагает пороги, а строка «Показано N из M» учитывает оба
 * фильтра. Актуальные значения — tests/trackerProviders.test.ts и данные бэкенда.
 */
describe("TrackerSearch — фильтр по сидам (структура исходника)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src/pages/movies/parts/TrackerSearch.tsx"),
    "utf8",
  );

  it("есть порог по сидам и селект с готовыми значениями", () => {
    expect(src).toContain("minSeeds");
    expect(src).toContain("seedThreshold");
    expect(src).toContain("seeders"); // фильтр сравнивает число сидов раздачи
    expect(src).toContain("trackerSeedsAny");
    expect(src).toContain("trackerSeedsMin");
    expect(src).toContain("[5, 10, 20, 50, 100]");
  });

  it("оба фильтра применяются вместе, и счётчик считает отфильтрованное", () => {
    // Разрешение и сиды — в одном выражении: иначе один фильтр затирал бы другой.
    const block = src.slice(src.indexOf("const seedThreshold"), src.indexOf("const presets"));
    expect(block).toContain("resFilter");
    expect(block).toContain("seedThreshold");
    // «Показано N из M» показывает именно items (отфильтрованное) и allItems.
    expect(src).toContain("{ shown: items.length, total: allItems.length }");
  });
});

});