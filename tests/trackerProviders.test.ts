import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRESET,
  TRACKER_PRESETS,
  normEngine,
  presetById,
  presetForEngine,
  trackerPresetList,
} from "../server/trackerProviders";

/**
 * Пресеты трекеров: rutracker (phpBB) и rutor (utf-8, без входа).
 *
 * Здесь проверяются именно ДАННЫЕ пресетов: адреса, кодировка, способ поиска и
 * требование входа. Ошибка в них не ломает сборку — она ломает поиск (например,
 * cp1251 вместо utf-8 даст пустую выдачу), поэтому наборы фиксируем проверками.
 * Разбор выдачи — tests/trackerParse.test.ts, сеть и сессия — tests/trackerScraper.test.ts.
 */
describe("trackerProviders — пресеты площадок", () => {
  it("содержит rutor и rutracker; первый (rutor) — по умолчанию", () => {
    // rutor стоит первым: он отвечает без Cloudflare, и вход для поиска не нужен.
    expect(TRACKER_PRESETS.map((p) => p.id)).toEqual(["rutor", "rutracker"]);
    expect(DEFAULT_PRESET.id).toBe("rutor");
    // Каждый пресет обязан быть самосогласованным: id = engine.
    for (const p of TRACKER_PRESETS) expect(p.engine).toBe(p.id);
  });

  it("rutracker: phpBB, cp1251, POST-поиск nm, вход обязателен", () => {
    const p = presetById("rutracker")!;
    expect(p.baseUrl).toBe("https://rutracker.org");
    expect(p.searchPath).toBe("/forum/tracker.php");
    expect(p.searchMethod).toBe("post");
    expect(p.searchParam).toBe("nm");
    expect(p.encoding).toBe("windows-1251");
    expect(p.requiresLogin).toBe(true);
    expect(p.loginCookies).toEqual(["bb_data"]);
    expect(p.torrentPath).toBe("/forum/dl.php?t={id}");
  });

  it("rutor: utf-8, запрос в ПУТИ, вход не нужен, .torrent на поддомене", () => {
    const p = presetById("rutor")!;
    expect(p.baseUrl).toBe("https://rutor.info");
    // {q} — признак того, что запрос подставляется в путь (см. sendSearch).
    expect(p.searchPath).toBe("/search/0/0/000/0/{q}");
    expect(p.searchPath).toContain("{q}");
    expect(p.searchMethod).toBe("get");
    expect(p.encoding).toBe("utf-8");
    expect(p.requiresLogin).toBe(false);
    expect(p.loginCookies).toEqual([]);
    expect(p.topicPath).toBe("/torrent/{id}");
    // Скачивание уходит на другой хост: шаблон обязан быть абсолютным URL.
    expect(p.torrentPath).toBe("https://d.rutor.info/download/{id}");
    expect(p.torrentPath.startsWith("https://")).toBe(true);
  });

  it("normEngine: неизвестное значение — rutracker (совместимость со старыми настройками)", () => {
    expect(normEngine("rutor")).toBe("rutor");
    expect(normEngine(" RuTor ")).toBe("rutor");
    expect(normEngine("rutracker")).toBe("rutracker");
    expect(normEngine("")).toBe("rutracker");
    expect(normEngine(undefined)).toBe("rutracker");
    expect(normEngine("nnmclub")).toBe("rutracker");
  });

  it("presetById не зависит от регистра и не падает на мусоре", () => {
    expect(presetById("RUTOR")?.id).toBe("rutor");
    expect(presetById(" rutracker ")?.id).toBe("rutracker");
    expect(presetById("nope")).toBeNull();
    expect(presetById(null)).toBeNull();
  });

  it("presetForEngine даёт осмысленные дефолты для частично заданных настроек", () => {
    expect(presetForEngine("rutor").baseUrl).toBe("https://rutor.info");
    expect(presetForEngine("rutor").encoding).toBe("utf-8");
    expect(presetForEngine("rutracker").baseUrl).toBe("https://rutracker.org");
    // Незаданный движок = пресет по умолчанию (rutor), а не пустые пути.
    expect(presetForEngine("").id).toBe("rutor");
  });

  it("список для UI отдаёт только id/label/baseUrl/requiresLogin", () => {
    const list = trackerPresetList();
    expect(list).toHaveLength(2);
    expect(Object.keys(list[0]).sort()).toEqual(["baseUrl", "id", "label", "requiresLogin"]);
    expect(list.find((p) => p.id === "rutor")).toMatchObject({
      label: "RuTor",
      baseUrl: "https://rutor.info",
      requiresLogin: false,
    });
    expect(list.find((p) => p.id === "rutracker")?.requiresLogin).toBe(true);
  });
});
