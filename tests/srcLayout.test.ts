import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Страж раскладки фронтенда (доменная схема «домен = папка»).
 *
 * Схема: страница и всё её локальное — в `src/pages/<домен>/` (страница,
 * `parts/` — её компоненты, `lib/` — её логика); реально общее — в
 * `src/components/` (UI), `src/lib/`, `src/api/`, `src/i18n/`; ВСЕ стили —
 * в одной папке `src/styles/`; оболочка приложения — в `src/app/`.
 *
 * Импорты внутри `src` идут только через alias `@/...`: иначе перенос файла
 * между папками требует пересчёта количества `../` во всех потребителях.
 */
const root = path.resolve(__dirname, "..");
const src = path.join(root, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(src);
const rel = (f: string): string => path.relative(src, f).split(path.sep).join("/");
const read = (f: string): string => fs.readFileSync(f, "utf8");

describe("раскладка src: домены, общее и стили", () => {
  it("все стили собраны в одной папке src/styles", () => {
    const css = files.filter((f) => f.endsWith(".css")).map(rel);
    expect(css.length).toBeGreaterThan(10);
    expect(css.filter((f) => !f.startsWith("styles/"))).toEqual([]);
  });

  it("в корне src/pages нет файлов — только доменные папки", () => {
    const stray = fs
      .readdirSync(path.join(src, "pages"), { withFileTypes: true })
      .filter((e) => !e.isDirectory())
      .map((e) => e.name);
    expect(stray).toEqual([]);
  });

  it("в корне каждого домена ровно одна страница (*Page.tsx)", () => {
    const pagesDir = path.join(src, "pages");
    const domains = fs
      .readdirSync(pagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(domains.length).toBeGreaterThan(10);

    for (const domain of domains) {
      // Исключение — под-приложения домена со своей страницей: myspace/canvas
      // (холст заметок — отдельный экран внутри страницы «Пространство»).
      const rootPages = fs
        .readdirSync(path.join(pagesDir, domain), { withFileTypes: true })
        .filter((e) => e.isFile() && /Page\.tsx$/.test(e.name))
        .map((e) => e.name);
      expect(rootPages, `${domain}: в корне домена должна быть ровно одна страница`).toHaveLength(
        1,
      );
    }
  });

  it("локальные части домена лежат в parts/ и lib/, а не в components/", () => {
    const domains = fs
      .readdirSync(path.join(src, "pages"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const domain of domains) {
      const nested = files
        .map(rel)
        .filter((f) => f.startsWith(`pages/${domain}/`) && f.includes("/"))
        .filter((f) => f.split("/").length > 3);
      // Разрешён максимум один уровень вложенности: parts/, lib/, canvas/.
      for (const f of nested) {
        expect(["parts", "lib", "canvas"], `${f}: лишний уровень вложенности`).toContain(
          f.split("/")[2],
        );
      }
    }
  });
});

describe("alias @/ — единый способ импорта фронтенда", () => {
  it("нет относительных импортов внутри src", () => {
    // Ищем именно инструкции импорта в начале строки: в комментариях и
    // примерах кода относительные пути упоминаться могут.
    const offenders: string[] = [];
    for (const file of files.filter((f) => /\.tsx?$/.test(f))) {
      const body = read(file);
      if (
        /^[ \t]*(?:import|export)\b[^\n]*?from[ \t]+"\.\.?\//m.test(body) ||
        /^[ \t]*import[ \t]+"\.\.?\//m.test(body)
      ) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("alias объявлен и в tsconfig, и в vite (иначе сборка и типы разойдутся)", () => {
    const tsconfig = read(path.join(root, "tsconfig.json"));
    expect(tsconfig).toMatch(/"paths"\s*:\s*\{\s*"@\/\*"/);
    expect(read(path.join(root, "vite.config.js"))).toMatch(/alias:\s*\{\s*"@":/);
  });

  it("index.html грузит точку входа из src/app", () => {
    expect(read(path.join(root, "index.html"))).toContain('src="/src/app/main.tsx"');
  });
});
