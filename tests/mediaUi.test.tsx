import { describe, it, expect, beforeAll } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import os from "os";
import path from "path";

import { I18nProvider } from "../src/i18n";
import SourcesList from "../src/components/media/SourcesList";
import MediaBrowse from "../src/components/media/MediaBrowse";
import type { MediaProvider, MediaProviders } from "../src/api/types";

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-mediaui-"));
});

/** SSR-рендер в русской локали (эффекты не выполняются — сетевых вызовов нет). */
function renderRu(node: React.ReactElement): string {
  return renderToString(React.createElement(I18nProvider, { lang: "ru" }, node));
}

function provider(id: number, name: string): MediaProvider {
  return { id, name, logo: `/logo${id}.png` };
}

function providersOf(flat: number, rent: number, buy: number): MediaProviders {
  const make = (n: number, offset: number) =>
    Array.from({ length: n }, (_, i) => provider(offset + i, `P${offset + i}`));
  return {
    region: "RU",
    link: "https://www.themoviedb.org/movie/1/watch",
    flatrate: make(flat, 1),
    rent: make(rent, 100),
    buy: make(buy, 200),
  };
}

/**
 * «Где смотреть» стало компактным: одна строка чипов «логотип + название»
 * вместо трёх рядов с подписями, лишние площадки сворачиваются в «+N ещё».
 */
describe("SourcesList (компактное «Где смотреть»)", () => {
  it("рисует одну строку чипов и сворачивает лишние в «+N ещё»", () => {
    const html = renderRu(
      React.createElement(SourcesList, {
        providers: providersOf(3, 3, 3),
        hasTrailer: true,
        onTrailer: () => {},
        onTorrent: () => {},
      }),
    );
    // Компактная полоска вместо трёх рядов с подписями.
    expect(html).toContain("mv-watch-row");
    expect(html).not.toContain("mv-providers-row");
    expect(html).not.toContain("mv-providers-label");
    // 6 видимых чипов + «+3 ещё» (всего 9 площадок).
    expect((html.match(/class="mv-chip is-flat"/g) || []).length).toBe(3);
    expect((html.match(/class="mv-chip is-rent"/g) || []).length).toBe(3);
    expect((html.match(/class="mv-chip is-buy"/g) || []).length).toBe(0);
    expect(html).toContain("mv-chip is-more");
    expect(html).toContain("+3 ещё");
    // Ссылка на TMDB и кнопки действий на месте.
    expect(html).toContain("mv-sources-link");
    expect(html).toContain("mv-sources-actions");
  });

  it("показывает все площадки, когда их немного", () => {
    const html = renderRu(
      React.createElement(SourcesList, {
        providers: providersOf(2, 1, 0),
        hasTrailer: false,
        onTrailer: () => {},
        onTorrent: () => {},
      }),
    );
    expect(html).not.toContain("mv-chip is-more");
    expect((html.match(/class="mv-chip is-flat"/g) || []).length).toBe(2);
    expect((html.match(/class="mv-chip is-rent"/g) || []).length).toBe(1);
    // Трейлера нет — кнопки «Трейлер» в футере тоже нет.
    expect(html).not.toContain("Трейлер");
  });

  it("без площадок показывает подсказку, а не пустую полоску", () => {
    const html = renderRu(
      React.createElement(SourcesList, {
        providers: null,
        hasTrailer: false,
        onTrailer: () => {},
        onTorrent: () => {},
      }),
    );
    expect(html).not.toContain("mv-chip is-flat");
    expect(html).toContain("mv-watch-row");
  });
});

/**
 * Полный список подборки («Все популярные» и т.п.) открывается плиткой «Все»
 * в конце карусели: шапка с возвратом в каталог и сетка карточек.
 */
describe("MediaBrowse (полный список подборки)", () => {
  it("рисует шапку с возвратом, заголовок и скелеты при загрузке", () => {
    const html = renderRu(
      React.createElement(MediaBrowse, {
        kind: "movie",
        category: "popular",
        title: "Популярное",
        onBack: () => {},
        onSelect: () => {},
      }),
    );
    expect(html).toContain("mv-browse");
    expect(html).toContain("mv-browse-back");
    expect(html).toContain("Назад в каталог");
    expect(html).toContain("Популярное");
    expect(html).toContain("mv-browse-grid");
    expect((html.match(/mv-card is-skeleton/g) || []).length).toBe(12);
  });

  /**
   * 20 тайтлов — это одна страница TMDB, а не «весь список». Пока первая
   * страница не пришла, счётчик и «это весь список» показывать нельзя,
   * иначе получается «0 тайтлов» и ложный финал.
   */
  it("до загрузки первой страницы не показывает счётчик и финал списка", () => {
    const html = renderRu(
      React.createElement(MediaBrowse, {
        kind: "movie",
        category: "popular",
        title: "Популярное",
        onBack: () => {},
        onSelect: () => {},
      }),
    );
    expect(html).not.toContain("mv-browse-end");
    expect(html).not.toContain("mv-browse-sentinel");
    expect(html).not.toContain("тайтлов");
  });
});
