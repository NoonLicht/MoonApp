import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/app/i18n";
import ToolsPage from "@/pages/tools/ToolsPage";

/**
 * Смоук-тест страницы «Инструменты»: рендерится без падения (SSR), и вкладки
 * из i18n присутствуют в разметке — ловит рассинхрон переводов/структуры
 * раньше ручного открытия в браузере.
 */
describe("ToolsPage — рендер и вкладки", () => {
  it("рендерится на сервере без ошибок и показывает вкладки инструментов", () => {
    const html = renderToString(
      React.createElement(I18nProvider, { lang: "ru" }, React.createElement(ToolsPage)),
    );
    expect(html).toContain("JSON");
    expect(html).toContain("Diff");
    expect(html).toContain("Regex");
  });
});
