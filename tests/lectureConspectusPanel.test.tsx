import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import LectureConspectusPanel from "../src/components/LectureConspectusPanel";
import { I18nProvider } from "../src/i18n";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";
import es from "../src/i18n/es.json";
import fr from "../src/i18n/fr.json";
import zh from "../src/i18n/zh.json";
import ar from "../src/i18n/ar.json";

/**
 * Блок «Нарезка расшифровки».
 *
 * Реальная жалоба: «совсем не понятно, что есть что» — на картинке подписи и
 * числа разъехались («Шов» прилип к чужому 6000, «Лимит» встал между 600 и 60).
 * Причина была в разметке: три пары «подпись + поле» лежали плоским списком в
 * одном .leca-row, и flex переносил их как попало — число оказывалось рядом с
 * чужой подписью.
 *
 * Теперь каждое поле — своя группа .leca-field, внутри .leca-pair подпись и
 * поле склеены намертво (перенос возможен только перед единицей измерения),
 * плюс у поля есть единица измерения и доступное имя (aria-label).
 */
const DICTS: Record<string, typeof en> = { en, ru, es, fr, zh, ar };
const LANGS = Object.keys(DICTS);

/** Локаль блока «Нарезка» — по её тексту находим нужный блок в HTML. */
function dict(lang: string): Record<string, string> {
  return (DICTS[lang].lecture as { conspectusPanel: Record<string, string> }).conspectusPanel;
}

/** Рендер панели в конкретном языке (inline — без оверлея, проще читать HTML). */
function renderPanel(lang: string): string {
  return renderToString(
    React.createElement(
      I18nProvider,
      { lang },
      React.createElement(LectureConspectusPanel, { inline: true }),
    ),
  );
}

/**
 * Разбор полей блока «Нарезка».
 *
 * Шаблон подписи намеренно «склеенный»: подпись и поле обязаны идти вплотную
 * внутри .leca-pair. Если разметку снова распустят в плоский список, шаблон
 * перестанет совпадать и glued = false — тест это заметит.
 */
function fields(html: string, lang: string) {
  return [...cutBlock(html, lang).matchAll(/<div class="leca-field">([\s\S]*?)<\/div>/g)].map(
    (m) => {
      const inner = m[1];
      const glued =
        /class="leca-pair"><span class="lecs-dim leca-label">([^<]*)<\/span>(<input[^>]*>)/.exec(
          inner,
        );
      const input = glued?.[2] ?? "";
      return {
        label: glued?.[1] ?? "",
        glued: !!glued,
        unit: /class="lecs-dim leca-unit">([^<]*)</.exec(inner)?.[1] ?? "",
        value: /\bvalue="([^"]*)"/.exec(input)?.[1] ?? "",
        aria: /aria-label="([^"]*)"/.exec(input)?.[1] ?? "",
      };
    },
  );
}

/**
 * Кусок HTML с блоком «Нарезка»: от его заголовка до заголовка следующего
 * блока. Якорь — ТЕКСТ заголовка («Нарезка расшифровки»): панель содержит
 * другие .leca-field (выбор модели в блоке «Провайдер»), и поиск по первому
 * полю больше не годится.
 */
function cutBlock(html: string, lang: string): string {
  const start = html.indexOf(`lecs-block-label">${dict(lang).advanced}<`);
  if (start === -1) return "";
  const next = html.indexOf('class="lecs-block-label"', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}
describe("Панель конспекта — блок «Нарезка» читается однозначно", () => {
  const html = renderPanel("ru");
  const f = fields(html, "ru");

  it("три поля: размер блока, перекрытие, максимум блоков — в этом порядке", () => {
    expect(f).toHaveLength(3);
    expect(f.map((x) => x.label)).toEqual(["Размер блока", "Перекрытие", "Максимум блоков"]);
  });

  it("значения по умолчанию совпадают с серверными: 6000, 600, 60", () => {
    // Сервер: conspectusChunkChars 6000 / conspectusOverlapChars 600 / maxChunks 60.
    expect(f.map((x) => Number(x.value))).toEqual([6000, 600, 60]);
  });

  it("подпись и поле склеены в .leca-pair — разъехаться не могут", () => {
    for (const field of f) expect(field.glued, field.label).toBe(true);
  });

  it("у каждого поля есть своя единица измерения и доступное имя", () => {
    expect(f.map((x) => x.unit)).toEqual(["символов", "символов контекста", "за прогон"]);
    // aria-label = подпись: имя поля читается и скринридером, и тестами.
    for (const field of f) expect(field.aria, field.label).toBe(field.label);
  });

  it("в самом блоке больше нет плоского списка .leca-row", () => {
    expect(cutBlock(html, "ru")).not.toContain("leca-row");
  });

  it("подписи и единицы уникальны (число не перепутаешь с соседним)", () => {
    expect(new Set(f.map((x) => x.label)).size).toBe(3);
    expect(new Set(f.map((x) => x.unit)).size).toBe(3);
  });
});
describe("Панель конспекта — переводы блока «Нарезка» на 6 языках", () => {
  const KEYS = [
    "advanced",
    "chunkChars",
    "overlapChars",
    "maxChunks",
    "chunkCharsUnit",
    "overlapCharsUnit",
    "maxChunksUnit",
  ];

  it("все ключи заполнены в каждой локали (иначе UI показал бы сам ключ)", () => {
    for (const lang of LANGS) {
      const block = dict(lang);
      for (const key of KEYS) {
        expect(block[key], `${lang} → ${key}`).toBeTruthy();
        // Сырой ключ вместо текста начинается с «lecture.» — это и ловим.
        expect(block[key], `${lang} → ${key}`).not.toMatch(/^lecture\./);
      }
    }
  });

  it("рендер во всех языках: поля есть, сырых ключей нет", () => {
    for (const lang of LANGS) {
      const html = renderPanel(lang);
      expect(html, lang).not.toContain("lecture.conspectusPanel.");
      expect(fields(html, lang), lang).toHaveLength(3);
    }
  });

  it("языки действительно отличаются (перевод берётся, а не фолбэк)", () => {
    const en = fields(renderPanel("en"), "en").map((x) => x.label);
    const ru = fields(renderPanel("ru"), "ru").map((x) => x.label);
    expect(en).toEqual(["Block size", "Overlap", "Max blocks"]);
    expect(ru).not.toEqual(en);
  });
});
