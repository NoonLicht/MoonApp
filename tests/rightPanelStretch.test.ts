import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Правая колонка (карточка настроек) должна доходить до нижней границы окна.
 *
 * Раньше у `.cmp-fill`/`.up-fill` стоял закомментированный `flex: 1`, поэтому
 * карточка заканчивалась там, где кончался текст, и под ней оставалась пустота.
 * Растягивает её `flex: 1 1 auto` (basis auto — не «схлопывается» в одноколоночной
 * раскладке), а длинные настройки остаются внутри карточки за счёт
 * `min-height: 0` + `overflow-y: auto`.
 *
 * На странице апскейла это позже стало проблемой: колонки были зажаты в
 * высоту окна и каждая скроллилась сама по себе — окно предпросмотра могло
 * показывать картинку не целиком. Там сетка/колонки/карточка настроек больше
 * не растягиваются и не скроллятся отдельно — прокручивается вся страница
 * (см. `.up-page { overflow-y: auto }`). Страница сжатия (.cmp-*) не менялась
 * и сохраняет старое поведение.
 */
const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), "utf8");
const up: string = read("src/styles/upscale.css");
const cmp: string = read("src/styles/pages.css");

describe("правая карточка настроек тянется до низа", () => {
  it("апскейл: страница скроллится целиком, колонки не зажаты в высоту окна", () => {
    expect(up).toMatch(/\.up-page\s*\{[^}]*overflow-y:\s*auto/s);
    expect(up).not.toMatch(/\.up-fill\s*\{[^}]*overflow-y:\s*auto/s);
    expect(up).not.toMatch(/\.up-right\s*\{[^}]*overflow:\s*hidden/s);
    expect(up).not.toMatch(/\.up-grid\s*\{[^}]*flex:\s*1/s);
  });

  it("сжатие: .cmp-fill растягивается и прокручивается сам (не менялось)", () => {
    expect(cmp).toMatch(/\.cmp-fill\s*\{[^}]*flex:\s*1 1 auto/s);
    expect(cmp).toMatch(/\.cmp-fill\s*\{[^}]*min-height:\s*0/s);
    expect(cmp).toMatch(/\.cmp-fill\s*\{[^}]*overflow-y:\s*auto/s);
    expect(cmp).toMatch(/\.cmp-right\s*\{[^}]*overflow:\s*hidden/s);
    expect(cmp).toMatch(/\.cmp-grid\s*\{[^}]*flex:\s*1/s);
    expect(cmp).toMatch(/\.cmp-grid\s*\{[^}]*min-height:\s*0/s);
  });

  it("карточки — колонки: настройки стоят друг под другом", () => {
    const pageUp = read("src/pages/upscale/UpscalePage.tsx");
    const pageCmp = read("src/pages/compressor/CompressorPage.tsx");
    expect(pageUp).toMatch(/<Glass className="up-card up-fill" style=\{\{ flexDirection: "column"/);
    expect(pageCmp).toMatch(/className="cmp-card cmp-fill"[\s\S]{0,80}flexDirection: "column"/);
  });
});
