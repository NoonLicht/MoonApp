import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import path from "path";
import fs from "fs";
import os from "os";

import { I18nProvider } from "@/app/i18n";
import { applyFeatures, enabledPages, isPageEnabled } from "@/app/pageAccess";
import ru from "@/i18n/ru.json";
import { PagesSection } from "@/pages/settings/parts/SettingsPages";
import type { FeaturesState } from "@/api/apiFeatures";

/**
 * Клиентская часть отключаемых страниц: набор страниц для дока/палитры и раздел настроек
 * «Страницы и профили». Состояние берём у настоящего серверного модуля features.
 */

let feat: typeof import("../server/features");

beforeAll(async () => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-pageaccess-"));
  feat = await import("../server/features");
});

beforeEach(() => {
  feat.setDisabledPages([]);
  applyFeatures(feat.summary() as FeaturesState);
});

function render(lang: string): string {
  return renderToString(
    React.createElement(I18nProvider, { lang }, React.createElement(PagesSection)),
  );
}

describe("набор страниц", () => {
  it("отключённая страница пропадает из списка дока, «Настройки» остаются", () => {
    expect(enabledPages().some((p) => p.id === "mail")).toBe(true);
    const total = enabledPages().length;
    feat.setDisabledPages(["mail", "games"]);
    applyFeatures(feat.summary() as FeaturesState);
    expect(enabledPages().some((p) => p.id === "mail")).toBe(false);
    expect(isPageEnabled("mail")).toBe(false);
    expect(isPageEnabled("settings")).toBe(true);
    expect(enabledPages().length).toBeLessThan(total);
  });
});

describe("раздел «Страницы и профили»", () => {
  it("рисует все страницы, выключатель отключённой — выключен", () => {
    feat.setDisabledPages(["mail"]);
    applyFeatures(feat.summary() as FeaturesState);
    const html = render("ru");
    expect(html).toContain("Почта");
    expect(html).toContain("Лекторий");
    const mailRow = html.split("set-row").find((r) => r.includes('aria-label="Почта"'));
    expect(mailRow).toContain('aria-checked="false"');
    expect(html).toContain('aria-checked="true"');
  });

  it("у «Настроек» выключатель заблокирован, подпись «Нельзя отключить»", () => {
    const html = render("ru");
    const row = html.split("set-row").find((r) => r.includes("Нельзя отключить"));
    expect(row).toBeTruthy();
    expect(row).toContain("disabled");
  });

  it("у лектория подсказка: распознавание речи останется — оно нужно чату", () => {
    const html = render("ru");
    const row = html.split("set-row").find((r) => r.includes('aria-label="Лекторий"'))!;
    expect(row).toContain("Останется");
    expect(row).toContain("Голосовой ввод и распознавание речи");
    expect(row).toContain(ru.nav.aichat);
  });

  it("профили показаны кнопками, подсказки на всех языках не пустые", () => {
    for (const lang of ["ru", "en", "es", "fr", "zh", "ar"]) {
      const html = render(lang);
      expect(html, lang).not.toContain("settings.pages.");
    }
  });
});
