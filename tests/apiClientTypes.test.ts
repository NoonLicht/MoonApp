import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Единый источник типов API-клиента (src/api/client.ts).
 *
 * Регресс: в client.ts лежал блок `import type { ... } from "@/api/types"` (67 имён),
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
const compressorPage = fs.readFileSync(
  path.resolve(__dirname, "..", "src", "pages", "compressor", "CompressorPage.tsx"),
  "utf8",
);
const audioPanel = fs.readFileSync(
  path.resolve(__dirname, "..", "src", "pages", "lecture", "parts", "LectureAudioPanel.tsx"),
  "utf8",
);

/** Имена из `import type { ... } from "@/api/types";` */
function importedTypeNames(): string[] {
  const match = src.match(/import type \{([\s\S]*?)\} from "@\/api\/types";/);
  if (!match) throw new Error("в client.ts не найден импорт типов из @/api/types");
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Тело файла без самого импорта типов из @/api/types */
function bodyWithoutTypeImport(): string {
  return src.replace(/import type \{[\s\S]*?\} from "@\/api\/types";/, "");
}

describe("src/api/client.ts — типы берутся из @/api/types один раз", () => {
  it("импортирует типы из @/api/types", () => {
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

/**
 * Общие типы на фронтенде не дублируются локальными копиями одного и того же
 * набора полей:
 *
 * - CompressorPage держал `interface Params` — ручную копию 11 полей запуска
 *   задания; теперь это `Pick<CompressorJob, ...>`, и список полей нельзя
 *   рассинхронизировать с API;
 * - LectureAudioPanel держал inline-тип `onSave` — копию патча аудионастроек;
 *   теперь общий `LectureAudioPatch` из client.ts (сам client.ts использовал
 *   ровно тот же структурный тип в `lectureAudioSet`).
 */
describe("Локальные копии общих типов не возвращаются", () => {
  it("CompressorPage: поле параметров выведено из CompressorJob", () => {
    expect(
      compressorPage,
      "Params снова объявлен отдельным интерфейсом с копией полей",
    ).not.toMatch(/interface Params \{\s*codec:/);
    expect(compressorPage, "Params должен выводиться из CompressorJob").toMatch(
      /type Params = Pick<\s*CompressorJob,/,
    );
  });

  it("LectureAudioPanel: onSave принимает общий LectureAudioPatch", () => {
    expect(audioPanel, "в панели снова inline-копия полей аудиопатча").not.toMatch(
      /vad\?:\s*\{\s*rmsThreshold\?:/,
    );
    expect(audioPanel, "onSave должен принимать LectureAudioPatch").toMatch(
      /onSave:\s*\(patch: LectureAudioPatch\)/,
    );
  });

  it("client.ts: патч аудионастроек объявлен один раз и используется в API", () => {
    const declared = src.match(/type LectureAudioPatch/g) ?? [];
    expect(declared.length, "LectureAudioPatch должен быть объявлен ровно один раз").toBe(1);
    expect(src, "lectureAudioSet должен использовать LectureAudioPatch").toMatch(
      /lectureAudioSet: \(patch: LectureAudioPatch\)/,
    );
  });
});
