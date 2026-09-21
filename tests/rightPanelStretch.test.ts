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
 */
const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), "utf8");
const up: string = read("src/styles/upscale.css");
const cmp: string = read("src/styles/pages.css");

describe("правая карточка настроек тянется до низа", () => {
  it("апскейл: .up-fill растягивается и прокручивается сам", () => {
    expect(up).toMatch(/\.up-fill\s*\{[^}]*flex:\s*1 1 auto/s);
    expect(up).toMatch(/\.up-fill\s*\{[^}]*min-height:\s*0/s);
    expect(up).toMatch(/\.up-fill\s*\{[^}]*overflow-y:\s*auto/s);
    // Высоту даёт колонка: она во всю строку сетки и сама не прокручивается.
    expect(up).toMatch(/\.up-right\s*\{[^}]*overflow:\s*hidden/s);
  });

  it("сжатие: .cmp-fill растягивается так же", () => {
    expect(cmp).toMatch(/\.cmp-fill\s*\{[^}]*flex:\s*1 1 auto/s);
    expect(cmp).toMatch(/\.cmp-fill\s*\{[^}]*min-height:\s*0/s);
    expect(cmp).toMatch(/\.cmp-fill\s*\{[^}]*overflow-y:\s*auto/s);
    expect(cmp).toMatch(/\.cmp-right\s*\{[^}]*overflow:\s*hidden/s);
  });

  it("сетки обеих страниц отдают строке всю высоту страницы", () => {
    expect(up).toMatch(/\.up-grid\s*\{[^}]*flex:\s*1/s);
    expect(up).toMatch(/\.up-grid\s*\{[^}]*min-height:\s*0/s);
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
