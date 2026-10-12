import { describe, it, expect } from "vitest";
import { autoCropBounds } from "../src/pages/screenshots/lib/autoCrop";

/** Умная обрезка скриншота: поля вокруг содержимого. */
function image(w: number, h: number, bg: number, boxes: { x: number; y: number; w: number; h: number; v: number }[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([bg, bg, bg, 255], i * 4);
  for (const b of boxes) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) data.set([b.v, b.v, b.v, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

describe("autoCropBounds", () => {
  it("обрезает однотонные поля, оставляя отступ", () => {
    const img = image(100, 80, 255, [{ x: 30, y: 20, w: 40, h: 30, v: 0 }]);
    expect(autoCropBounds(img, 12, 5)).toEqual({ x: 25, y: 15, w: 50, h: 40 });
  });

  it("работает и на тёмном фоне", () => {
    const img = image(60, 60, 10, [{ x: 10, y: 10, w: 20, h: 20, v: 220 }]);
    expect(autoCropBounds(img, 12, 0)).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });

  it("если полей нет — null", () => {
    // содержимое доходит до краёв, светлыми остались только угловые пиксели
    const img = image(40, 40, 255, [
      { x: 0, y: 1, w: 40, h: 38, v: 100 },
      { x: 1, y: 0, w: 38, h: 40, v: 100 },
    ]);
    expect(autoCropBounds(img)).toBeNull();
  });

  it("однотонное изображение — null", () => {
    expect(autoCropBounds(image(50, 50, 128, []))).toBeNull();
  });

  it("слабый шум в пределах допуска считается фоном", () => {
    const img = image(50, 50, 200, [
      { x: 0, y: 0, w: 50, h: 5, v: 205 },
      { x: 20, y: 20, w: 10, h: 10, v: 0 },
    ]);
    expect(autoCropBounds(img, 12, 0)).toEqual({ x: 20, y: 20, w: 10, h: 10 });
  });
});
