import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Контракт страницы «Настройки» — проверки по исходнику (DOM-тестов в проекте нет:
 * SSR-рендер не выполняет useEffect, поэтому строки секций не отрисовываются).
 *
 * Что защищаем:
 *  1) в Настройках НЕТ панелей «Модель и ускорение», «ИИ-конспект» и «Говорящие» —
 *     они дублировали панели страницы «Лекторий» и были убраны (0.2.2). Вернуть их
 *     случайным рефакторингом нельзя: настройки этих панелей должны быть в одном
 *     месте — рядом с самой записью;
 *  2) в Настройках есть настройки лекций, которых НЕТ на странице лектория:
 *     язык Whisper, подсказка для него, потоки CPU и тайминги VAD-нарезки;
 *  3) у обновлений нет выключателя (обновления обязательны, см. electron/main.js) —
 *     ни кнопки toggle, ни канала updates:toggle;
 *  4) каждый статический ключ t("...") страницы существует во ВСЕХ 6 локалях:
 *     отсутствующий ключ печатает сам себя («settings.foo») прямо в интерфейсе.
 */
const LANG_CODES = ["en", "ru", "es", "fr", "zh", "ar"];
const settingsSrc = fs.readFileSync(
  path.resolve(__dirname, "..", "src", "pages", "settings", "SettingsPage.tsx"),
  "utf8",
);
const dicts = Object.fromEntries(
  LANG_CODES.map((l) => [
    l,
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "src", "i18n", `${l}.json`), "utf8")),
  ]),
);

function resolveKey(dict: any, key: string): unknown {
  return key
    .split(".")
    .reduce<any>((acc, k) => (acc && typeof acc === "object" ? acc[k] : null), dict);
}

describe("Страница «Настройки»: состав разделов и локализация", () => {
  it("не дублирует панели страницы лектория (модель, конспект, говорящие)", () => {
    for (const panel of ["LectureEnginePanel", "LectureConspectusPanel", "LectureDiarizePanel"]) {
      expect(settingsSrc, `панель ${panel} вернулась в Настройки`).not.toContain(panel);
    }
  });

  it("содержит настройки лекций, которых нет на странице лектория", () => {
    // Язык Whisper, подсказка и потоки CPU. Тайминги VAD (значения в ms) из
    // настроек убраны: это внутренние параметры нарезки, дублирующие панель
    // лектория, и держать их в двух местах смысла нет.
    const keys = [
      "lectureSttTitle",
      "lectureLangLabel",
      "lectureLangHint",
      "lectureLangAuto",
      "lecturePromptLabel",
      "lecturePromptHint",
      "lecturePromptPlaceholder",
      "lectureThreadsLabel",
      "lectureThreadsHint",
    ];
    for (const k of keys) {
      expect(settingsSrc, `нет ссылки на settings.${k}`).toContain(`settings.${k}`);
    }
    // Пути настроек — те, что читает сервер (server/settings.js → lecture.*).
    for (const p of ["lecture.language", "lecture.initialPrompt", "lecture.threads"]) {
      expect(settingsSrc, `нет изменения ${p}`).toContain(`"${p}"`);
    }
    // VAD-тайминги в настройках больше не показываем.
    expect(settingsSrc).not.toContain("lecture.vadSilenceMs");
    expect(settingsSrc).not.toContain("lecture.vadPadMs");
  });

  it("не дублирует настройки, которые живут на своих страницах", () => {
    // Эти блоки были дублями панелей соответствующих страниц (окно, конвертер,
    // книги, дефолты чата и голоса, путь yt-dlp) и убраны из настроек.
    for (const gone of [
      '"window.width"',
      '"converter.ffmpegPath"',
      '"media.ytdlpPath"',
      '"chat.provider"',
      '"chat.temperature"',
      '"chat.maxTokens"',
      '"voice.engine"',
      '"voice.exaggeration"',
      // Язык озвучки: ключ убран на сервере (движок всегда русский), а селект в
      // настройках остался — правки молча отбрасывал sanitizePatch. Удалён.
      '"voice.defaultLanguage"',
      '"appearance.fontSize"',
      't("settings.books")',
      't("settings.window")',
      't("settings.converter")',
    ]) {
      expect(settingsSrc, `дубль вернулся в Настройки: ${gone}`).not.toContain(gone);
    }
    // Бейджи-плашки в шапках блоков тоже убраны (смысловые статусы остались).
    expect(settingsSrc).not.toContain("BADGE_KEYS");
  });

  it("не даёт выключить обновления", () => {
    expect(settingsSrc).not.toContain("toggleAutoUpdate");
    expect(settingsSrc).not.toContain("updatesEnable");
    expect(settingsSrc).not.toContain("updatesDisable");
    // Ручные кнопки остались: проверка и скачивание.
    expect(settingsSrc).toContain("checkUpdatesNow");
    expect(settingsSrc).toContain("downloadUpdateNow");
  });

  it('каждый статический ключ t("...") есть во всех шести локалях', () => {
    const keys = new Set<string>();
    for (const m of settingsSrc.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) keys.add(m[1]);
    expect(keys.size).toBeGreaterThan(100);

    const missing: string[] = [];
    for (const key of keys) {
      for (const lang of LANG_CODES) {
        const val = resolveKey(dicts[lang], key);
        if (typeof val !== "string") missing.push(`${lang}:${key}`);
      }
    }
    expect(missing.join(", ")).toBe("");
  });
});
