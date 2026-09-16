import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Единый источник типов API-клиента (src/api/client.ts).
 *
 * Регресс: в client.ts лежал блок `import type { ... } from "./types"` (67 имён),
 * а сразу за ним — второй блок `export type { ... }` с теми же 57 именами. Список
 * приходилось править в двух местах, и они уже разошлись (10 имён были только в
 * импорте). Ни один потребитель этот реэкспорт не использовал: все берут типы
 * либо из api/types напрямую, либо из локальных объявлений client.ts.
 *
 * Тесты следят, чтобы список не начали снова дублировать и чтобы импорт не
 * раздувался неиспользуемыми именами (tsc с noUnusedLocals это тоже ловит, но
 * тест даёт понятное сообщение и не требует полной сборки).
 */
const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "api", "client.ts"), "utf8");

/** Имена из `import type { ... } from "./types";` */
function importedTypeNames(): string[] {
  const match = src.match(/import type \{([\s\S]*?)\} from "\.\/types";/);
  if (!match) throw new Error("в client.ts не найден импорт типов из ./types");
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Тело файла без самого импорта типов из ./types */
function bodyWithoutTypeImport(): string {
  return src.replace(/import type \{[\s\S]*?\} from "\.\/types";/, "");
}

describe("src/api/client.ts — типы берутся из ./types один раз", () => {
  it("импортирует типы из ./types", () => {
    expect(importedTypeNames().length).toBeGreaterThan(10);
  });

  it("не содержит блока реэкспорта типов (второго перечисления списка)", () => {
    // `export type { ... };` без `from` — это реэкспорт уже импортированных имён,
    // то есть дубль списка. Объявления вида `export type Foo = ...` разрешены.
    expect(src, "вернулся дублирующий блок export type { ... }").not.toMatch(
      /export type \{[\s\S]*?\};/,
    );
  });

  it("каждое импортированное имя действительно используется в теле файла", () => {
    const body = bodyWithoutTypeImport();
    const unused = importedTypeNames().filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
    expect(unused, `неиспользуемые типы в импорте: ${unused.join(", ")}`).toEqual([]);
  });
});
