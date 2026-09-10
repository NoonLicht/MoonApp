import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import AudiobookTTSPage from "../src/pages/AudiobookTTSPage";

/** Достаём атрибуты всех <input type="range"> из SSR-разметки страницы. */
function ranges(html: string): string[] {
  return html
    .split('<input type="range"')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("/>")));
}

/** Ползунки Pro-панели (у полосы плеера есть класс ap-seek — исключаем её). */
function proSliders(html: string): string[] {
  return ranges(html).filter((attrs) => !attrs.includes("ap-seek"));
}

/**
 * Pro-панель аудиокниг (F5-TTS · инференс / Coqui XTTS v2 · инференс /
 * Мастеринг и паузы). Ползунки должны быть живыми: раньше они рендерились с
 * `disabled` (режим Smart Express) и тянулись ровно на одно деление.
 */
describe("Pro-панель аудиокниг: ползунки интерактивны", () => {
  const html = renderToString(React.createElement(AudiobookTTSPage));
  const sliders = proSliders(html);

  it("рендерит слайдеры Pro-панели в аккордеонах", () => {
    // Движок по умолчанию — F5-TTS: nfe, cfg, exaggeration + «мастеринг и паузы».
    expect(sliders.length).toBeGreaterThanOrEqual(8);
    expect(html).toContain("ab-param");
    expect(html).toContain("ab-acc-collapse");
  });

  it("ни один ползунок Pro-панели не заблокирован", () => {
    for (const attrs of sliders) {
      expect(attrs).not.toContain("disabled");
    }
  });

  it("у каждого ползунка заданы границы, шаг и текущее значение", () => {
    for (const attrs of sliders) {
      expect(attrs).toMatch(/min="[-\d.]+"/);
      expect(attrs).toMatch(/max="[-\d.]+"/);
      expect(attrs).toMatch(/step="[\d.]+"/);
      expect(attrs).toMatch(/value="[-\d.]+"/);
    }
  });
});
