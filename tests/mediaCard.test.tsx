import { describe, it, expect, beforeAll } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import os from "os";
import path from "path";

import { I18nProvider } from "@/app/i18n";
import MediaCard, { posterOf } from "@/pages/movies/parts/MediaCard";
import type { MediaCardProps } from "@/pages/movies/parts/MediaCard";
import type { MediaSummary } from "@/api/types";

/**
 * Общая карточка тайтла TMDB (src/pages/movies/parts/MediaCard.tsx).
 *
 * До фазы 1 разметку `mv-card` держали четыре места: локальный MediaCard в
 * каталоге, полный список подборки (MediaBrowse), «Похожие» в карточке тайтла
 * (MediaDetailModal) и результаты поиска (MoviesPage). Копии разошлись размером
 * иконки и запасным изображением, из-за чего карточка на одной странице
 * выглядела по-разному. Тесты фиксируют:
 *  1) поведение самого компонента (запасное изображение, бейджи, что уходит в
 *     onSelect);
 *  2) контракт по исходникам: копипаста разметки не вернулась.
 */
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-mediacard-"));
});

const srcDir = path.resolve(__dirname, "..", "src");
const read = (rel: string): string => fs.readFileSync(path.join(srcDir, rel), "utf8");

/** SSR-рендер в русской локали: эффекты не выполняются, сетевых вызовов нет. */
function renderRu(node: React.ReactElement): string {
  return renderToString(React.createElement(I18nProvider, { lang: "ru" }, node));
}

function title(over: Partial<MediaSummary> = {}): MediaSummary {
  return {
    kind: "movie",
    id: 1,
    title: "Тестовый тайтл",
    originalTitle: "Test",
    overview: "",
    poster: null,
    backdrop: null,
    year: 2024,
    date: null,
    voteAverage: 0,
    voteCount: 0,
    popularity: 0,
    genreIds: [],
    adult: false,
    ...over,
  };
}

function card(item: MediaSummary, props: Partial<MediaCardProps> = {}): string {
  return renderRu(React.createElement(MediaCard, { item, onSelect: () => {}, ...props }));
}

describe("MediaCard: запасное изображение", () => {
  it("берёт постер, а при его отсутствии — кадр", () => {
    expect(posterOf(title({ poster: "/p.jpg", backdrop: "/b.jpg" }))).toBe("/p.jpg");
    expect(posterOf(title({ poster: null, backdrop: "/b.jpg" }))).toBe("/b.jpg");
  });

  it("когда ни постера, ни кадра нет — карточка показывает иконку, а не пустоту", () => {
    expect(posterOf(title())).toBeNull();
    const html = card(title());
    // Иконка Film из lucide-react: в SSR она отдаёт <svg class="lucide lucide-film".
    expect(html).toContain("lucide-film");
    expect(html).not.toContain("<img");
  });
});

describe("MediaCard: бейджи и содержимое", () => {
  it("без флагов рисует только название и год (компактный вариант)", () => {
    const html = card(title({ year: 2011, voteAverage: 7.9, kind: "tv" }));
    expect(html).toContain("Тестовый тайтл");
    expect(html).toContain("2011");
    expect(html).not.toContain("mv-card-score");
    expect(html).not.toContain("mv-card-kind");
  });

  it("showScore показывает рейтинг с одним знаком после запятой", () => {
    expect(card(title({ voteAverage: 7.94 }), { showScore: true })).toContain("7.9");
  });

  it("showScore не показывает нулевой рейтинг: «0.0» выглядит как оценка", () => {
    expect(card(title({ voteAverage: 0 }), { showScore: true })).not.toContain("mv-card-score");
  });

  it("showKind различает фильм и сериал", () => {
    expect(card(title({ kind: "movie" }), { showKind: true })).toContain("Фильм");
    expect(card(title({ kind: "tv" }), { showKind: true })).toContain("Сериал");
  });

  it("год отсутствует — на месте года прочерк, а не пустая строка", () => {
    expect(card(title({ year: null }))).toContain("—");
  });
});

describe("контракт: общая разметка карточки вместо четырёх копий", () => {
  /** Кто рисует карточки тайтлов: каталог, подборка, «Похожие», поиск. */
  const consumers = [
    "pages/movies/parts/MediaCatalog.tsx",
    "pages/movies/parts/MediaBrowse.tsx",
    "pages/movies/parts/MediaDetailModal.tsx",
    "pages/movies/MoviesPage.tsx",
  ];

  it("разметка mv-card-art живёт только в MediaCard", () => {
    for (const rel of consumers) {
      expect(read(rel), `${rel}: вернулась локальная разметка карточки`).not.toContain(
        "mv-card-art",
      );
    }
    // В каталоге есть отдельная плитка «Все» — это не карточка тайтла.
    expect(read("pages/movies/parts/MediaCard.tsx")).toContain(
      'className="mv-card-art tone-violet"',
    );
  });

  it("каждый список использует общий MediaCard, а не свой компонент", () => {
    for (const rel of consumers) {
      const src = read(rel);
      expect(src, `${rel}: нет импорта MediaCard`).toMatch(/import MediaCard from ".*MediaCard"/);
      expect(src, `${rel}: объявлен собственный MediaCard`).not.toMatch(/function MediaCard\s*\(/);
    }
  });

  it("постер с запасным кадром больше не считается в каждом файле отдельно", () => {
    for (const rel of consumers) {
      expect(read(rel), `${rel}: осталась локальная копия posterOf`).not.toMatch(
        /function posterOf\s*\(/,
      );
    }
  });

  it("флаги включены там, где карточка раньше была подробнее", () => {
    // В подборке был рейтинг, в каталоге — плашка «Фильм»/«Сериал».
    expect(read("pages/movies/parts/MediaBrowse.tsx")).toContain("showScore");
    expect(read("pages/movies/parts/MediaCatalog.tsx")).toContain("showKind");
  });

  it("скелеты загрузки остались у списка, а не переехали в MediaCard", () => {
    expect(read("pages/movies/parts/MediaBrowse.tsx")).toContain("mv-card is-skeleton");
    expect(read("pages/movies/parts/MediaCard.tsx")).not.toContain("is-skeleton");
  });
});
