import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import en from "@/i18n/en.json";
import ru from "@/i18n/ru.json";
import es from "@/i18n/es.json";
import fr from "@/i18n/fr.json";
import zh from "@/i18n/zh.json";
import ar from "@/i18n/ar.json";

/**
 * Кнопки ИИ-оформления в редакторе заметок (страница «Моё пространство»).
 *
 * Реальный риск таких кнопок — «немая» ошибка: сервер отдаёт код
 * notes_ai_not_configured, страница его не знает и показывает пользователю
 * служебную строку. Поэтому контракт проверяется по трём стыкам:
 *   1) коды, которые бросает server/ts/notesAi.ts, мапятся роутом (400) либо
 *      осознанно остаются 500;
 *   2) каждый бросаемый код известен странице (notesAiError);
 *   3) каждый ключ myspace.ai.*, который страница использует, заполнен в 6 локалях.
 */
const root = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

const pageSrc = read("src/pages/myspace/MyspacePage.tsx");
const moduleSrc = read("server/ts/notesAi.ts");
const routeSrc = read("server/routes/myspace.js");

const DICTS: Record<string, any> = { en, ru, es, fr, zh, ar };
const LANGS = Object.keys(DICTS);

/** Коды notes_ai_*, которые модуль реально бросает (без упоминаний в текстах). */
function thrownCodes(): string[] {
  return [
    ...new Set([...moduleSrc.matchAll(/new Error\("(notes_ai_[a-z_]+)/g)].map((m) => m[1])),
  ];
}

/** Коды notes_ai_*, которые роут переводит в 400 (список в aiStatus). */
function routeStatusCodes(): string[] {
  const m = routeSrc.match(/notes_ai_\(([^)]*)\)/);
  return (m ? m[1] : "")
    .split("|")
    .filter(Boolean)
    .map((s) => "notes_ai_" + s);
}

describe("ИИ-оформление заметок — коды ошибок доходят до подсказок", () => {
  it("модуль бросает не меньше семи кодов (иначе проверять нечего)", () => {
    expect(thrownCodes().length).toBeGreaterThanOrEqual(7);
  });

  it("роут знает каждый код: список 400-статусов совпадает с кодами модуля", () => {
    const mapped = routeStatusCodes();
    expect(mapped.length).toBeGreaterThanOrEqual(6);
    // Опечатка в regex роута (или новый код в модуле) ломает этот тест.
    for (const code of mapped) expect(thrownCodes(), code).toContain(code);
  });

  it("единственный «пятисотый» код — сбой модели, и он осознанно не в списке 400", () => {
    const mapped = routeStatusCodes();
    const rest = thrownCodes().filter((c) => !mapped.includes(c));
    expect(rest).toEqual(["notes_ai_empty_response"]);
  });

  it("страница переводит каждый бросаемый код (нет сырых сообщений в UI)", () => {
    for (const code of thrownCodes()) {
      expect(pageSrc, code).toContain(code);
      // И у кода есть свой ключ подсказки — общая строка «не получилось» тут
      // не годится: пользователю нужен конкретный шаг (ключ, модель, исходник).
      const key = pageSrc.match(new RegExp(code + "[\\s\\S]{0,120}?t\\(\"([a-zA-Z.]+)\""));
      expect(key?.[1], code).toMatch(/^myspace\.ai\./);
    }
  });

  it("каждый ключ myspace.ai.* из страницы заполнен во всех 6 локалях", () => {
    const used = [
      ...new Set(
        [...pageSrc.matchAll(/"(myspace\.ai\.[a-zA-Z]+)"/g)].map((m) => m[1].split(".")[2]),
      ),
    ];
    expect(used.length).toBeGreaterThanOrEqual(9);
    for (const key of used) {
      for (const lang of LANGS) {
        const value = DICTS[lang].myspace?.ai?.[key];
        expect(typeof value === "string" && value.length > 0, `${lang} → myspace.ai.${key}`).toBe(
          true,
        );
      }
    }
  });

  it("набор ключей одинаков во всех локалях (нет «забыли перевести»)", () => {
    const base = Object.keys(DICTS.en.myspace.ai).sort();
    expect(base.length).toBeGreaterThanOrEqual(17);
    for (const lang of LANGS) {
      expect(Object.keys(DICTS[lang].myspace.ai).sort(), lang).toEqual(base);
    }
  });
});

describe("ИИ-оформление заметок — кнопки в хедере редактора", () => {
  it("две операции: «оформить» и «регенерировать» (полная замена из исходника)", () => {
    expect(pageSrc).toContain('runNotesAi("format")');
    expect(pageSrc).toContain('runNotesAi("regenerate")');
    expect(pageSrc).toContain("<Sparkles");
    expect(pageSrc).toContain("<RefreshCw");
  });

  it("«Оформить» сохраняет правки перед запросом, а результат не пере-сохраняется", () => {
    // Иначе модель оформит старую версию файла, а debounce-save перезапишет
    // готовый текст старым содержимым вкладки.
    expect(pageSrc).toMatch(/mode === "format"\) await api\.myspaceWrite/);
    expect(pageSrc).toMatch(/modified: false/);
  });

  it("ответ ИИ не попадает в чужую вкладку (пользователь мог переключиться)", () => {
    expect(pageSrc).toContain("activeTabRef.current === target");
  });
});
