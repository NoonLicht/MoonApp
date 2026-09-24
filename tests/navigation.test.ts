import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "@/app/App";
import { PAGES, startPageOptions } from "@/app/navigation";
import en from "@/i18n/en.json";
import ru from "@/i18n/ru.json";
import es from "@/i18n/es.json";
import fr from "@/i18n/fr.json";
import zh from "@/i18n/zh.json";
import ar from "@/i18n/ar.json";

/**
 * Страницы приложения описаны в одном месте (src/navigation.ts). Тест следит за
 * тем, чтобы перечень не разъезжался с доком и со списком «Стартовая страница»
 * в настройках: именно там не хватало movies, lecture и bypass.
 */
const DICT: Record<string, typeof en> = { en, ru, es, fr, zh, ar };
const ALL_IDS = [
  "store",
  "convert",
  "compress",
  "upscale",
  "video",
  "movies",
  "music",
  "books",
  "monitor",
  "myspace",
  "aichat",
  "voice",
  "lecture",
  "bypass",
  "tools",
  "archive",
  "settings",
];

describe("перечень страниц приложения (src/navigation.ts)", () => {
  it("содержит все страницы приложения", () => {
    expect(PAGES.map((p) => p.id)).toEqual(ALL_IDS);
  });

  it("id не повторяются, у каждой страницы есть иконка и i18n-ключ", () => {
    const ids = PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PAGES) {
      expect(p.icon, p.id).toBeTruthy();
      expect(p.i18n, p.id).toMatch(/^nav\./);
    }
  });

  it("названия страниц переведены на все 6 языков", () => {
    for (const [lang, dict] of Object.entries(DICT)) {
      for (const p of PAGES) {
        const key = p.i18n.replace(/^nav\./, "");
        expect(
          (dict as { nav: Record<string, string> }).nav[key],
          `${lang} → ${p.i18n}`,
        ).toBeTruthy();
      }
    }
  });

  it("док приложения рисует кнопку для каждой страницы перечня", () => {
    const html = renderToString(React.createElement(App));
    const dockButtons = html.split("dock-btn").length - 1;
    expect(dockButtons).toBe(PAGES.length);
  });
});

describe("стартовая страница в настройках", () => {
  it("предлагает ВСЕ страницы приложения", () => {
    const options = startPageOptions((key) => key);
    expect(options.map((o) => o.value)).toEqual(ALL_IDS);
    for (const id of ["movies", "lecture", "bypass"]) {
      expect(
        options.some((o) => o.value === id),
        id,
      ).toBe(true);
    }
  });

  it("подписывает варианты переведёнными названиями, а не id", () => {
    for (const [lang, dict] of Object.entries(DICT)) {
      const options = startPageOptions((key) => {
        const [section, name] = key.split(".");
        const d = dict as unknown as Record<string, Record<string, string>>;
        return d[section]?.[name] ?? key;
      });
      for (const o of options) {
        expect(o.label, `${lang} → ${o.value}`).toBeTruthy();
        expect(o.label, `${lang} → ${o.value} не должен остаться ключом`).not.toBe(
          `nav.${o.value}`,
        );
      }
    }
  });
});
