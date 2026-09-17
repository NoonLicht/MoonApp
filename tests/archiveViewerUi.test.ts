import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Окно просмотра архива (.arch-view-*): слой, клики и колесо мыши.
 *
 * Реальная жалоба: «окно открывается, но прокрутки нет — колесо крутит страницу
 * архива под окном, страницу слева выбрать не могу, крестик не нажимается».
 *
 * Причина: окно рисуется ПОРТАЛОМ в #overlay-root, а у этого узла в theme.css
 * стоит `pointer-events: none` (пустая обёртка не должна перехватывать клики).
 * Модалки включают `auto` себе сами — в .arch-view-overlay этой строки не было,
 * поэтому все события (клики и колесо) проходили СКВОЗЬ окно на страницу архива.
 *
 * DOM-тестов в проекте нет (SSR не выполняет useEffect и не кликает), поэтому
 * проверяем контракт по исходникам — как в tests/graphFullscreen.test.ts.
 */
const root = path.resolve(__dirname, "..");
const pageSrc = fs.readFileSync(
  path.join(root, "src", "pages", "archiver", "ArchiverPage.tsx"),
  "utf8",
);
const read = (rel: string) => fs.readFileSync(path.join(root, "src", "styles", rel), "utf8");

/** Убирает пробелы — сравнение не зависит от переносов Prettier. */
const squash = (s: string): string => s.replace(/\s+/g, "");

/** Тело первого CSS-правила по селектору (текст файла тоже сплющивается). */
function ruleBody(css: string, selector: string): string {
  const escaped = squash(selector).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return squash(css).match(new RegExp(`${escaped}\\{([^}]*)\\}`))?.[1] ?? "";
}

const jsx = squash(pageSrc);

describe("окно просмотра архива: слой и клики", () => {
  it("рисуется порталом в #overlay-root", () => {
    expect(jsx).toContain('import{createPortal}from"react-dom";');
    expect(jsx).toContain('import{getOverlayRoot}from"@/components/overlayHost";');
    expect(jsx).toContain("getOverlayRoot()??document.body");
  });

  it("у самого окна включены клики (иначе они уходят на страницу под ним)", () => {
    const overlay = ruleBody(read("arch.css"), ".arch-view-overlay");
    expect(overlay, "нет правила .arch-view-overlay в arch.css").not.toBe("");
    expect(overlay).toContain("pointer-events:auto");
    expect(overlay).toContain("position:fixed");
    expect(overlay).toContain("inset:0");
  });

  it("любой оверлей из #overlay-root включает pointer-events себе", () => {
    // #overlay-root специально «прозрачен» для кликов — каждый его потомок,
    // который что-то показывает, обязан вернуть события.
    expect(ruleBody(read("theme.css"), ".overlay-root")).toContain("pointer-events:none");
    const overlays: [string, string][] = [
      [".arch-view-overlay", "arch.css"],
      [".ms-ai-overlay", "notes.css"],
      [".graph-fs-backdrop", "notes.css"],
      [".mv-modal-backdrop", "movies.css"],
    ];
    for (const [sel, file] of overlays) {
      const body = ruleBody(read(file), sel);
      expect(body, `${sel} (${file}) не найден`).not.toBe("");
      expect(body, `${sel} (${file}) не вернул себе клики`).toContain("pointer-events:auto");
    }
  });
});

describe("окно просмотра архива: закрытие и выбор страницы", () => {
  it("крестик и клик по затемнению закрывают окно", () => {
    expect(jsx).toContain('<divclassName="arch-view-overlay"onClick={()=>setViewer(null)}>');
    expect(jsx).toContain('className="arch-view-close"');
    // Клик по самому окну не должен закрывать его (stopPropagation на .arch-view).
    expect(jsx).toContain('className="arch-view"');
    expect(jsx).toContain("onClick={(e)=>e.stopPropagation()}");
  });

  it("Esc закрывает окно слушателем окна (страховка к кликам)", () => {
    expect(jsx).toContain('if(e.key==="Escape")setViewer(null);');
    expect(jsx).toContain('window.addEventListener("keydown",onKey)');
    expect(jsx).toContain('window.removeEventListener("keydown",onKey)');
  });

  it("страница выбирается из списка слева и перезагружает фрейм", () => {
    expect(jsx).toContain('className={`arch-view-item${viewerPage===p.path?"is-active":""}`}');
    expect(jsx).toContain("setViewerPage(p.path);");
    expect(jsx).toContain("setFrameKey((k)=>k+1);");
  });

  it("список страниц прокручивается сам (свой скролл, а не страница)", () => {
    const list = ruleBody(read("arch.css"), ".arch-view-list");
    expect(list).toContain("overflow-y:auto");
    expect(list).toContain("min-height:0");
  });

  it("фрейм идёт с песочницей без скриптов", () => {
    // Значение атрибута (а не наличие слова в файле: оно встречается и в
    // комментарии-объяснении «песочница без allow-scripts»).
    const sandbox = jsx.match(/sandbox="([^"]*)"/)?.[1] ?? "";
    expect(sandbox).toBe("allow-same-origin");
  });

  it("ушли со страницы — окно закрывается (портал живёт вне .page-host)", () => {
    // Портал вне .page-host, поэтому правило `.page-host:not(.is-active) *` его
    // не спрячет: просмотрщик закрывается эффектом по usePageActive.
    expect(jsx).toContain("constisActive=usePageActive();");
    expect(jsx).toContain("if(!isActive)setViewer(null);");
  });
});
