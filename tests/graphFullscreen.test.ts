import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Полноэкранный граф на странице MySpace — контракт по исходникам
 * (DOM-тестов в проекте нет: SSR не выполняет useEffect и не позволяет кликнуть).
 *
 * Что защищаем (0.2.x, жалоба «часть графа под меню страниц, снизу пустая полоса»):
 *  1) оверлей рендерится порталом в #overlay-root. Внутри .content-area — это
 *     stacking context z-index:1, поэтому собственный z-index оверлея
 *     (.content-area → .page-host → ...) не мог перекрыть рельс страниц и
 *     верхнюю панель (у них z-index:40) → левый край графа уходил под меню;
 *  2) геометрия панели берётся из переменных оболочки (.app-shell в theme.css),
 *     как у .content-area. Пока панель центрировалась по окну (92vw × 78vh), при
 *     вертикальном рельсе слева она уезжала под меню, а снизу оставалась пустая
 *     полоса от старого НИЖНЕГО меню;
 *  3) Esc закрывает оверлей через слушатель окна: onKeyDown на самом div не
 *     срабатывал — фокус в него не попадает.
 */
const root = path.resolve(__dirname, "..");
const myspaceSrc = fs.readFileSync(path.join(root, "src", "pages", "MyspacePage.tsx"), "utf8");
const notesCss = fs.readFileSync(path.join(root, "src", "styles", "notes.css"), "utf8");

describe("Полноэкранный граф: слой и геометрия панели", () => {
  it("рендерится порталом в #overlay-root", () => {
    expect(myspaceSrc).toContain('import { createPortal } from "react-dom"');
    expect(myspaceSrc).toContain('import { getOverlayRoot } from "../components/overlayHost"');
    expect(myspaceSrc).toContain("createPortal(");
    expect(myspaceSrc).toContain("getOverlayRoot() ?? document.body");
  });

  it("панель привязана к раскладке оболочки, а не к размерам окна", () => {
    const panel = notesCss.match(/\.graph-fs-panel\{[^}]*\}/)?.[0] ?? "";
    expect(panel, "нет правила .graph-fs-panel в notes.css").not.toBe("");
    expect(panel).toContain("top:var(--content-top)");
    expect(panel).toContain("bottom:var(--content-bottom)");
    expect(panel).toContain("left:calc(var(--rail-gap) + var(--rail-w) + 12px)");
    expect(panel).toContain("right:24px");
    // Регрессия: размеры «по окну» вместо прямоугольника контентной области.
    expect(myspaceSrc, "вернулась панель 92vw × 78vh").not.toContain("92vw");
    expect(myspaceSrc).not.toContain("78vh");
  });

  it("зеркалит панель для RTL (арабский)", () => {
    expect(notesCss).toMatch(/\.app-shell\[dir="rtl"\] \.graph-fs-panel\{[^}]*left:24px/);
  });

  it("гасится, когда страница перестаёт быть активной (keep-alive)", () => {
    // Портал лежит ВНЕ .page-host, поэтому правило
    // `.page-host:not(.is-active) *` его не спрячет — нужен явный гейт.
    expect(myspaceSrc).toContain("usePageActive");
    expect(myspaceSrc).toContain("graphFullscreen && pageActive && createPortal");
  });

  it("Esc закрывает оверлей слушателем окна", () => {
    expect(myspaceSrc).toContain('window.addEventListener("keydown", onKey)');
    expect(myspaceSrc, "вернулся нерабочий onKeyDown на div").not.toContain(
      'onKeyDown={(e)=>{if(e.key==="Escape")setGraphFullscreen(false);}}',
    );
  });
});
