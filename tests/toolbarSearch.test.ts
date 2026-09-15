import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import ToolbarSearch from "../src/components/ToolbarSearch";
import { NARROW_TOOLBAR_QUERY, collapseToolbarSearch } from "../src/components/toolbarSearchMode";
import { BREAKPOINTS } from "../src/utils/useMediaQuery";

/**
 * Адаптив поиска в верхней панели управления: пока окно широкое — поле стоит
 * в панели, ниже 1200px — прячется под кнопку-иконку с поповером.
 * Порог проверяем чистой функцией (в тестах нет ни DOM, ни matchMedia).
 */
describe("ToolbarSearch — адаптив поиска в верхней панели", () => {
  it("сворачивает поиск только ниже 1200px", () => {
    expect(collapseToolbarSearch(1920)).toBe(false);
    expect(collapseToolbarSearch(1440)).toBe(false);
    expect(collapseToolbarSearch(BREAKPOINTS.md)).toBe(false);      // 1200 — поле ещё в панели
    expect(collapseToolbarSearch(BREAKPOINTS.md - 1)).toBe(true);   // 1199 — уже под кнопкой
    expect(collapseToolbarSearch(900)).toBe(true);
  });

  it("медиазапрос совпадает с порогом из BREAKPOINTS", () => {
    expect(NARROW_TOOLBAR_QUERY).toBe(`(max-width: ${BREAKPOINTS.md - 1}px)`);
  });

  it("без matchMedia (SSR) рендерит поле в панели, а не кнопку-триггер", () => {
    const html = renderToString(
      React.createElement(ToolbarSearch, {
        value: "dune",
        onChange: () => {},
        placeholder: "Поиск фильмов и сериалов…",
      })
    );
    expect(html).toContain("tb-search");
    expect(html).toContain('placeholder="Поиск фильмов и сериалов…"');
    expect(html).toContain('value="dune"');
    expect(html).not.toContain("tb-menu"); // кнопки-триггера в широком режиме нет
  });

  it("режим bare не рисует «пилюлю»: поле живёт внутри чужой панели", () => {
    const html = renderToString(
      React.createElement(ToolbarSearch, { value: "", onChange: () => {}, bare: true })
    );
    expect(html).toContain("tb-search is-bare");
  });
});