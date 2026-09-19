import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Контракт контекстного меню: клик ВНЕ меню обязан его закрывать.
 *
 * Реальная жалоба: «меню открывается по правой кнопке и висит — клик в любом
 * месте его не закрывает». Причина: закрытие висело на `window.addEventListener
 * ("click")` во всплывающей фазе, а модалки и карточки страниц глушат всплытие
 * (`Glass onClick={(e) => e.stopPropagation()}`) — событие до window не доходило.
 * Плюс верхняя панель приложения объявлена как `-webkit-app-region: drag`, а в
 * Electron drag-полоса перехватывает мышь: клик по ней не даёт события вообще.
 *
 * Проверяем по исходникам (DOM-тестов в проекте нет — как в tests/graphFullscreen).
 */
const root = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(root, "src", "components", "ContextMenu.tsx"), "utf8");
const theme = fs.readFileSync(path.join(root, "src", "styles", "theme.css"), "utf8");
/** Убирает пробелы — сравнение не зависит от переносов Prettier. */
const squash = (s: string): string => s.replace(/\s+/g, "");

describe("контекстное меню: закрытие кликом вне меню", () => {
  it("есть прозрачная подложка на весь экран, клик по ней закрывает меню", () => {
    const jsx = squash(src);
    expect(jsx).toContain('className="ctx-backdrop"');
    expect(jsx).toContain("onMouseDown={()=>setSt(null)}");
    expect(jsx).toContain("onClick={()=>setSt(null)}");
    expect(jsx).toContain("onContextMenu={(e)=>{e.preventDefault();setSt(null);}}");
    // Подложка ниже меню, но выше интерфейса страниц.
    const backdrop = /\.ctx-backdrop\s*\{([^}]*)\}/s.exec(theme)?.[1] || "";
    expect(backdrop).toMatch(/position:\s*fixed/);
    expect(backdrop).toMatch(/inset:\s*0/);
    const menuZ = Number(/\.ctx-menu\s*\{[^}]*z-index:\s*(\d+)/s.exec(theme)?.[1] || 0);
    const backZ = Number(/\.ctx-backdrop\s*\{[^}]*z-index:\s*(\d+)/s.exec(theme)?.[1] || 0);
    expect(backZ).toBeLessThan(menuZ);
  });

  it("клик вне меню ловится в capture-фазе (stopPropagation его не съест)", () => {
    const jsx = squash(src);
    for (const evt of ["pointerdown", "mousedown", "click", "contextmenu"]) {
      expect(jsx, `нет capture-слушателя ${evt}`).toContain(
        `window.addEventListener("${evt}",outside,true)`,
      );
      expect(jsx, `нет снятия слушателя ${evt}`).toContain(
        `window.removeEventListener("${evt}",outside,true)`,
      );
    }
    // Клик ВНУТРИ меню не должен закрывать его до выполнения пункта.
    expect(jsx).toContain("if(t&&ref.current&&ref.current.contains(t))return;");
  });

  it("пока меню открыто, верхняя панель не перехватывает мышь как drag-регион", () => {
    expect(src).toContain('document.body.classList.add("ctx-open")');
    expect(src).toContain('document.body.classList.remove("ctx-open")');
    expect(theme).toMatch(
      /body\.ctx-open\s+\.titlebar-drag\s*\{[^}]*-webkit-app-region:\s*no-drag/,
    );
  });
});
