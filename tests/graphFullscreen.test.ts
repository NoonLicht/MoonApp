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
 *
 * Проверки сравнивают исходники БЕЗ пробелов: Prettier (фаза 0) переносит JSX
 * и раскладывает CSS-декларации по строкам, поэтому привязка к конкретным
 * переносам ломала бы тест при каждом `npm run format`.
 */
const root = path.resolve(__dirname, "..");
const myspaceSrc = fs.readFileSync(path.join(root, "src", "pages", "MyspacePage.tsx"), "utf8");
const notesCss = fs.readFileSync(path.join(root, "src", "styles", "notes.css"), "utf8");

/** Убирает все пробельные символы — сравнение перестаёт зависеть от форматирования. */
const squash = (s: string): string => s.replace(/\s+/g, "");

/** Достаёт тело первого CSS-правила по селектору (из «сплющенного» текста). */
function ruleBody(css: string, selector: string): string {
  // Селектор тоже сплющиваем: squash убирает и пробел-комбинатор потомка
  // (`.app-shell[dir="rtl"] .graph-fs-panel` -> `.app-shell[dir="rtl"].graph-fs-panel`).
  const flat = squash(selector);
  const escaped = flat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return squash(css).match(new RegExp(`${escaped}\\{([^}]*)\\}`))?.[1] ?? "";
}

const jsx = squash(myspaceSrc);

describe("Полноэкранный граф: слой и геометрия панели", () => {
  it("рендерится порталом в #overlay-root", () => {
    expect(jsx).toContain('import{createPortal}from"react-dom";');
    expect(jsx).toContain('import{getOverlayRoot}from"../components/overlayHost";');
    expect(jsx).toContain("createPortal(");
    expect(jsx).toContain("getOverlayRoot()??document.body");
  });

  it("панель привязана к раскладке оболочки, а не к размерам окна", () => {
    const panel = ruleBody(notesCss, ".graph-fs-panel");
    expect(panel, "нет правила .graph-fs-panel в notes.css").not.toBe("");
    expect(panel).toContain("top:var(--content-top)");
    expect(panel).toContain("bottom:var(--content-bottom)");
    expect(panel).toContain("left:calc(var(--rail-gap)+var(--rail-w)+12px)");
    expect(panel).toContain("right:24px");
    // Регрессия: размеры «по окну» вместо прямоугольника контентной области.
    expect(myspaceSrc, "вернулась панель 92vw × 78vh").not.toContain("92vw");
    expect(myspaceSrc).not.toContain("78vh");
  });

  it("зеркалит панель для RTL (арабский)", () => {
    const rtl = ruleBody(notesCss, '.app-shell[dir="rtl"] .graph-fs-panel');
    expect(rtl, "нет RTL-правила .app-shell[dir=rtl] .graph-fs-panel").not.toBe("");
    expect(rtl).toContain("left:24px");
    expect(rtl).toContain("right:calc(var(--rail-gap)+var(--rail-w)+12px)");
  });

  it("гасится, когда страница перестаёт быть активной (keep-alive)", () => {
    // Портал лежит ВНЕ .page-host, поэтому правило
    // `.page-host:not(.is-active) *` его не спрячет — нужен явный гейт.
    expect(jsx).toContain("usePageActive");
    expect(jsx).toContain("graphFullscreen&&pageActive&&createPortal");
  });

  it("Esc закрывает оверлей слушателем окна", () => {
    expect(jsx).toContain('window.addEventListener("keydown",onKey)');
    expect(jsx, "слушатель не снимается при закрытии").toContain(
      'window.removeEventListener("keydown",onKey)',
    );
    // Регрессия: обработчик Esc вернулся на сам div оверлея — так фокус в него
    // не попадает и Esc не работает. Проверяем именно закрытие графа, а не
    // любой onKeyDown в файле (у инпута создания заметки он свой и нужен).
    expect(jsx, "вернулся нерабочий onKeyDown на div оверлея").not.toContain(
      'onKeyDown={(e)=>{if(e.key==="Escape")setGraphFullscreen(false)',
    );
  });
});
