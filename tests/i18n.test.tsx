import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider, useI18n, LANGS } from "../src/i18n";

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
    </I18nProvider>
  );
}

describe("i18n — 6 официальных языков ООН", () => {
  it("поддерживает все 6 языков", () => {
    expect(LANGS.map((l) => l.code).sort().join(",")).toBe("ar,en,es,fr,ru,zh");
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