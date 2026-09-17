import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import { I18nProvider, useI18n, LANGS } from "@/app/i18n";

function Probe() {
  const { t } = useI18n();
  return (
    <span>
      {t("nav.store")}|{t("settings.performance")}|{t("aichat.newChat")}|{t("store.tabAll")}
    </span>
  );
}

function renderFor(lang: string) {
  return renderToString(
    <I18nProvider lang={lang}>
      <Probe />
    </I18nProvider>,
  );
}

describe("i18n — 6 официальных языков ООН", () => {
  it("поддерживает все 6 языков", () => {
    expect(
      LANGS.map((l) => l.code)
        .sort()
        .join(","),
    ).toBe("ar,en,es,fr,ru,zh");
  });

  it("переводит ключи на каждый язык", () => {
    const cases: Record<string, string[]> = {
      en: ["Store", "Performance", "New chat", "All"],
      ru: ["Магазин", "Производительность", "Новый чат", "Все"],
      es: ["Tienda", "Rendimiento", "Nuevo chat", "Todos"],
      fr: ["Boutique", "Performances", "Nouveau chat", "Tous"],
      zh: ["商店", "性能", "新建聊天", "全部"],
      ar: ["المتجر", "الأداء", "محادثة جديدة", "الكل"],
    };
    for (const [lang, expected] of Object.entries(cases)) {
      const html = renderFor(lang);
      for (const needle of expected) {
        expect(html, `${lang} → ${needle}`).toContain(needle);
      }
    }
  });

  it("откатывается на английский для отсутствующих ключей", () => {
    const html = renderFor("de"); // not a declared language
    expect(html).toContain("Store");
  });
});

/**
 * Предупреждения движка приходят с сервера строками: whisperEngine.engineSummary()
 * кладёт коды (cuda_without_nvidia, cuda_blackwell, prompt_unusable) в warnings, а
 * панель настроек показывает t(`lecture.setup.warn.${код}`). Код без перевода
 * выводится пользователю как сырая строка вида «lecture.setup.warn.prompt_unusable»,
 * поэтому набор предупреждений держим согласованным со всеми 6 локалями.
 */
describe("i18n — предупреждения движка лектория", () => {
  const WARN_CODES = ["cuda_without_nvidia", "cuda_blackwell", "prompt_unusable"];
  const i18nDir = path.resolve(__dirname, "..", "src", "i18n");

  it.each(LANGS.map((l) => l.code))("%s: у каждого кода есть непустой перевод", (code) => {
    const dict = JSON.parse(fs.readFileSync(path.join(i18nDir, `${code}.json`), "utf8"));
    const warn = dict.lecture.setup.warn;
    for (const key of WARN_CODES) {
      expect(typeof warn[key], `${code}.${key}`).toBe("string");
      expect(warn[key].length, `${code}.${key}`).toBeGreaterThan(0);
    }
  });
});
