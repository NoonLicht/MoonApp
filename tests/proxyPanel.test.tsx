import { describe, it, expect, beforeAll } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import os from "os";
import path from "path";

import { I18nProvider } from "@/app/i18n";
import ProxyPanel from "@/pages/bypass/parts/ProxyPanel";

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-pp-"));
});

/**
 * SSR-смоук панели прокси: рендер без ошибок (эффекты на сервере не выполняются,
 * поэтому сетевые вызовы к /api/proxycore не идут).
 */
describe("ProxyPanel (встроенный прокси)", () => {
  const html = renderToString(
    React.createElement(
      I18nProvider,
      { lang: "ru" },
      React.createElement(ProxyPanel, { onClose: () => {} }),
    ),
  );

  it("рендерит модалку с шапкой и действиями", () => {
    expect(html).toContain("proxy-panel-overlay");
    expect(html).toContain("proxy-panel");
    expect(html).toContain("proxy-actions");
  });

  it("показывает список страниц для per-page фильтра (все 14 страниц)", () => {
    expect(html).toContain("proxy-page-list");
    const pageButtons = html.match(/class="proxy-page /g) || [];
    expect(pageButtons.length).toBeGreaterThanOrEqual(14);
  });

  it("содержит секцию подписок с формой добавления", () => {
    expect(html).toContain("proxy-save-bar");
    expect(html).toContain("proxy-block-label");
    // Узлы рендерятся только внутри своей подписки: без данных (SSR) списка нет,
    // а плоского блока «Серверы» больше не существует.
    expect(html).not.toContain("proxy-node-list");
    const groups = html.match(/class="proxy-saved-block"/g) || [];
    expect(groups.length).toBe(2); // подписки + правила по страницам
  });
});
