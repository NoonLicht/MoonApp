import { describe, it, expect } from "vitest";
import {
  clampPan,
  clampZoom,
  FIT_MODES,
  fitBoxFor,
  fitModeLabelKey,
  fitObjectFit,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
} from "@/pages/movies/lib/playback";

/**
 * Вписывание кадра в плеере (кнопка вписывания) и зум.
 *
 * Режимы — та же логика, что в CSS (.mv-vp.fit-*), поэтому проверяем в первую
 * очередь решение «какой размер блока и какой object-fit»: ошибка здесь видна
 * не как падение, а как чёрные полосы или обрезанные края у пользователя.
 */
describe("плеер — режимы вписывания кадра", () => {
  it("список режимов и их подписи согласованы с локалями", () => {
    // Кадр никогда не искажается: режимов «растянуть» и «умное растяжение» нет.
    expect(FIT_MODES).toEqual(["fit", "cover", "width", "height"]);
    expect(fitModeLabelKey("cover")).toBe("movies.fit_cover");
    expect(fitModeLabelKey("height")).toBe("movies.fit_height");
    // Мусор не превращается в отсутствующий ключ.
    expect(fitModeLabelKey("нет" as never)).toBe("movies.fit_fit");
  });

  it("«вписать» отдаёт блок по кадру, остальные режимы — всю область", () => {
    const area = { aspect: 16 / 9, availWidth: 1600, availHeight: 900 };
    // 16:9 в 16:9 — блок совпадает с областью.
    expect(fitBoxFor("fit", area)).toEqual({ width: 1600, height: 900 });
    // 4:3 в широкой области — блок уже кадра: полей по бокам нет.
    expect(fitBoxFor("fit", { ...area, aspect: 4 / 3 })).toEqual({ width: 1200, height: 900 });
    // Остальные режимы живут во всей области, кадр вписывает сам <video>.
    for (const m of ["cover", "width", "height"] as const) {
      expect(fitBoxFor(m, area)).toEqual({ width: 1600, height: 900 });
    }
  });

  it("object-fit по режиму: cover — обрезка, остальные — contain (без искажений)", () => {
    expect(fitObjectFit("fit")).toBe("contain");
    expect(fitObjectFit("width")).toBe("contain");
    expect(fitObjectFit("height")).toBe("contain");
    expect(fitObjectFit("cover")).toBe("cover");
  });
});

describe("плеер — зум и панорама", () => {
  it("зум клампится и имеет ступени быстрого выбора", () => {
    expect(ZOOM_STEPS).toEqual([100, 125, 150, 200, 300]);
    expect(clampZoom(150)).toBe(150);
    expect(clampZoom("200")).toBe(200);
    expect(clampZoom(Number.NaN)).toBe(100);
    expect(clampZoom(ZOOM_MIN - 10)).toBe(ZOOM_MIN);
    expect(clampZoom(ZOOM_MAX + 10)).toBe(ZOOM_MAX);
  });

  it("панорама не выходит за границы увеличенного кадра", () => {
    const box = { width: 1000, height: 600 };
    // Без зума двигать нечего.
    expect(clampPan({ x: 999, y: 999 }, { ...box, zoomPercent: 100 })).toEqual({ x: 0, y: 0 });
    // 200% — половина кадра в каждую сторону.
    expect(clampPan({ x: 5000, y: -5000 }, { ...box, zoomPercent: 200 })).toEqual({
      x: 500,
      y: -300,
    });
    // Внутри границ значение сохраняется.
    expect(clampPan({ x: -120, y: 40 }, { ...box, zoomPercent: 200 })).toEqual({ x: -120, y: 40 });
  });
});
