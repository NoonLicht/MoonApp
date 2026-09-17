import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Окна-модалки рисуются порталом в #overlay-root (см. src/components/overlayHost.ts),
 * а у самого хоста в theme.css стоит `pointer-events: none` — иначе пустой узел
 * на весь экран перехватывал бы клики обычных страниц. Поэтому КАЖДЫЙ
 * полноэкранный слой, который туда попадает, обязан включить клики себе.
 *
 * Реальная жалоба пользователя: «страница архива открылась, но слева страницу
 * не выбрать, окно не закрыть, а колесо мыши прокручивает список архивов ПОД
 * окном». Причина — у `.arch-view-overlay` не было `pointer-events: auto`:
 * клики и колесо проходили сквозь окно на страницу под ним. Тот же дефект был
 * у окна ИИ-настроек My Space (`.ms-ai-overlay`).
 */
const root = process.cwd();

/** Разбор CSS на правила «селектор → тело» (плоский, без вложенности @media). */
function rules(cssFile: string): Array<{ sel: string; body: string }> {
  const css = fs.readFileSync(path.join(root, cssFile), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ sel: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}

/** Тело правила, в селекторе которого встречается искомый класс. */
function bodyOf(cssFile: string, cls: string): string[] {
  const re = new RegExp(`\\.${cls}(?![\\w-])`);
  return rules(cssFile)
    .filter((r) => re.test(r.sel))
    .map((r) => r.body);
}

/** Полноэкранные слои, которые рендерятся порталом в #overlay-root. */
const PORTALED = [
  {
    src: "src/pages/archiver/ArchiverPage.tsx",
    css: "src/styles/arch.css",
    cls: "arch-view-overlay",
  },
  { src: "src/pages/myspace/MyspacePage.tsx", css: "src/styles/notes.css", cls: "ms-ai-overlay" },
  {
    src: "src/pages/myspace/MyspacePage.tsx",
    css: "src/styles/notes.css",
    cls: "graph-fs-backdrop",
  },
  {
    src: "src/pages/movies/parts/MediaDetailModal.tsx",
    css: "src/styles/movies.css",
    cls: "mv-modal-backdrop",
  },
  {
    src: "src/pages/movies/parts/MediaDetailModal.tsx",
    css: "src/styles/movies.css",
    cls: "mv-lightbox",
  },
  {
    src: "src/pages/movies/parts/PlayerModal.tsx",
    css: "src/styles/movies.css",
    cls: "mv-modal-backdrop",
  },
];

describe("портальные окна: клики не проходят сквозь окно", () => {
  it("хост #overlay-root сам клики не перехватывает", () => {
    const bodies = bodyOf("src/styles/theme.css", "overlay-root");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join("\n")).toMatch(/pointer-events:\s*none/);
  });

  it.each(PORTALED)("$cls включает клики себе", ({ css, cls }) => {
    const bodies = bodyOf(css, cls);
    expect(bodies.length, `${css}: .${cls} не найден`).toBeGreaterThan(0);
    expect(bodies.join("\n"), `${css}: .${cls} без pointer-events: auto`).toMatch(
      /pointer-events:\s*auto/,
    );
  });

  it.each(PORTALED)("$cls действительно рендерится порталом в #overlay-root", ({ src, cls }) => {
    const code = fs.readFileSync(path.join(root, src), "utf8");
    expect(code).toContain(cls);
    expect(code).toMatch(/getOverlayRoot\(\)/);
  });

  it("новых порталов в #overlay-root без проверки не появилось", () => {
    const covered = new Set(PORTALED.map((p) => p.src));
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name)) {
          const code = fs.readFileSync(path.join(root, rel), "utf8");
          if (code.includes("getOverlayRoot()") && !rel.endsWith("components/overlayHost.ts")) {
            users.push(rel.replace(/\\/g, "/"));
          }
        }
      }
    };
    walk("src");
    expect(users.filter((f) => !covered.has(f))).toEqual([]);
  });
});
