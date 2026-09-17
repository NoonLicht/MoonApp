import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import { LANGS } from "@/app/i18n";
import { PyEnvPanel } from "@/pages/voice/parts/PyEnvPanel";
import type { TtsPythonEnv } from "@/api/client";

/**
 * Панель Python-окружения студии озвучки (src/pages/voice/parts/PyEnvPanel.tsx).
 *
 * Две реальные жалобы, которые держит этот тест:
 *  1. «Стили кривые, панель занимает слишком много текста» — пояснение шло
 *     отдельной строкой во всю ширину, а подсказка на карточке сборки, объём
 *     загрузки и бейдж «Рекомендуется» стояли каждый на своей строке (четыре
 *     «ступеньки»). Теперь это две строки: заголовок + пояснение в шапке и
 *     `иконка + название + объём`, `подсказка + бейдж` в карточке.
 *  2. «Нет смысла писать “Не хватает: torch, torchaudio, f5_tts”» — строка
 *     состояния слово в слово повторяла красные бейджи модулей в шапке.
 */
const root = process.cwd();
const panel = fs.readFileSync(path.join(root, "src/pages/voice/parts/PyEnvPanel.tsx"), "utf8");
const css = fs.readFileSync(path.join(root, "src/styles/pages.css"), "utf8");
const block = (cls: string) => {
  // Селектор может быть списком (`.ab-py-dev-head, .ab-py-dev-sub { … }`), а
  // свойства класса могут лежать в нескольких правилах — собираем все.
  const re = new RegExp(`[^{}]*\\.${cls}(?![\\w-])[^{}]*\\{([^}]*)\\}`, "g");
  return (css.match(re) || []).join("\n");
};

describe("панель Python: состояние без дублирования бейджей", () => {
  it("строка состояния использует ключ без перечисления модулей", () => {
    expect(panel).toContain('t("ab.py.needModules")');
    expect(panel).not.toContain("ab.py.noModules");
    expect(panel).not.toContain("missing.join");
  });

  it.each(LANGS.map((l) => l.code))("%s: needModules есть и не перечисляет модули", (code) => {
    const dict = JSON.parse(fs.readFileSync(path.join(root, `src/i18n/${code}.json`), "utf8"));
    const text = dict.ab.py.needModules;
    expect(typeof text, `${code}.ab.py.needModules`).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    // Плейсхолдер вернул бы список модулей обратно в строку состояния.
    expect(text).not.toContain("{modules}");
  });

  it("старый ключ noModules вычищен из всех локалей", () => {
    for (const { code } of LANGS) {
      const dict = JSON.parse(fs.readFileSync(path.join(root, `src/i18n/${code}.json`), "utf8"));
      expect(dict.ab.py.noModules, `${code}.ab.py.noModules`).toBeUndefined();
    }
  });
});

describe("панель Python: живая разметка (SSR)", () => {
  /** Окружение, где движку F5 не хватает всех трёх модулей. */
  const env: TtsPythonEnv = {
    ok: true,
    error: "",
    detail: "",
    cmd: "python",
    python: "3.11.8",
    executable: "C:/Python311/python.exe",
    modules: { torch: false, torchaudio: false, f5_tts: false },
    missingF5: ["torch", "torchaudio", "f5_tts"],
    missingXtts: [],
    installF5: "",
    installXtts: "",
    checkedAt: 0,
    cached: false,
  };
  // Без I18nProvider t() отдаёт сам ключ — удобно проверять, какой ключ взят.
  const html = renderToString(
    React.createElement(PyEnvPanel, { engine: "f5", env, onChanged: () => {} }),
  );

  it("строка состояния не повторяет список модулей", () => {
    expect(html).toContain("ab.py.needModules");
    expect(html).not.toContain("ab.py.noModules");
    expect(html).not.toContain("torch, torchaudio");
    expect(html).not.toContain("{modules}");
  });

  it("какие модули отсутствуют, видно по красным бейджам", () => {
    expect(html).toContain("ab-py-modules");
    expect((html.match(/tone-coral/g) || []).length).toBeGreaterThanOrEqual(3);
    for (const m of ["torch", "torchaudio", "f5_tts"]) {
      expect(html).toMatch(new RegExp(`>\\s*${m}</`));
    }
  });

  it("карточки сборок собраны в две строки (голова + подпись)", () => {
    // Две сборки: CUDA 12.8 (cu128) и CPU.
    expect((html.match(/ab-py-dev-head/g) || []).length).toBe(2);
    expect((html.match(/ab-py-dev-sub/g) || []).length).toBe(2);
    expect(html).not.toContain("ab-py-dev-meta");
    // Заголовок и пояснение панели больше не разнесены по двум строкам-абзацам.
    expect(html).toMatch(/ab-py-head-text[^>]*>.*field-label/);
  });

  it("сборок две: CUDA и CPU (ключа deviceLegacy больше нет)", () => {
    expect(html).toContain("ab.py.deviceCuda");
    expect(html).toContain("ab.py.deviceCudaHint");
    expect(html).toContain("ab.py.deviceCpu");
    expect(html).not.toContain("ab.py.deviceLegacy");
  });
});

describe("i18n: сборки torch описаны во всех локалях", () => {
  it.each(LANGS.map((l) => l.code))("%s: подписи и подсказки каждой сборки", (code) => {
    const dict = JSON.parse(fs.readFileSync(path.join(root, `src/i18n/${code}.json`), "utf8"));
    for (const k of ["deviceCuda", "deviceCudaHint", "deviceCpu", "deviceCpuHint"]) {
      const text = dict.ab.py[k];
      expect(typeof text, `${code}.ab.py.${k}`).toBe("string");
      expect(text.length, `${code}.ab.py.${k}`).toBeGreaterThan(0);
    }
    // Версия в подписи — тот же индекс, что ставит сервер (cu128): иначе
    // пользователь скопирует «ручную» команду в консоли и промахнётся.
    expect(dict.ab.py.deviceCuda, `${code}.deviceCuda`).toContain("12.8");
    expect(dict.ab.py.deviceLegacy, `${code}.deviceLegacy`).toBeUndefined();
  });

  it("в панели перечислены обе сборки (третьей с cudaLegacy нет)", () => {
    expect(panel).toContain("DEVICES.map");
    expect(panel).toContain('id: "cuda"');
    expect(panel).toContain('id: "cpu"');
    expect(panel).not.toContain("cudaLegacy");
    expect(panel).not.toContain("CircuitBoard");
  });
});

describe("pages.css: компактная раскладка панели Python", () => {
  it("заголовок и пояснение идут одной строкой", () => {
    expect(block("ab-py-head")).toMatch(/display:\s*flex/);
    expect(block("ab-py-head-text")).toMatch(/display:\s*flex/);
    expect(block("ab-py-head-text")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("карточка сборки PyTorch — две строки вместо четырёх", () => {
    expect(panel).toContain("ab-py-dev-head");
    expect(panel).toContain("ab-py-dev-sub");
    expect(panel).toContain("ab-py-dev-size");
    expect(block("ab-py-dev-head")).toMatch(/width:\s*100%/);
    expect(block("ab-py-dev-sub")).toMatch(/flex-wrap:\s*wrap/);
    // Объём прижат вправо — цифры CUDA/CPU сравнимы с одного взгляда.
    expect(block("ab-py-dev-size")).toMatch(/margin-left:\s*auto/);
    // Прежний класс меты больше не нужен: объём и бейдж разошлись по строкам.
    expect(panel).not.toContain("ab-py-dev-meta");
    expect(css).not.toContain(".ab-py-dev-meta");
  });
});
