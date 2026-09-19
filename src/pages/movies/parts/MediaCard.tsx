import { Copy, Film, Play, Star } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { useContextMenu, copyToClipboard, type CtxItem } from "@/components/ContextMenu";
import { imgUrl } from "@/pages/movies/lib/mediaImg";
import type { MediaKind, MediaSummary } from "@/api/types";

/**
 * Карточка тайтла TMDB — общая разметка для всех списков «Фильмов и Сериалов».
 *
 * До этого разметку `mv-card` держали четыре места: каталог (локальный
 * MediaCard), полный список подборки (MediaBrowse), «Похожие» в карточке тайтла
 * (MediaDetailModal) и результаты поиска (MoviesPage). Копии уже разошлись
 * размером иконки (20/22) и запасным изображением, хотя карточка обязана
 * выглядеть одинаково на одной странице. Различия, которые были осознанными,
 * вынесены во флаги:
 *   • showScore — бейдж рейтинга (в каталоге и списке подборки есть, в
 *     «Похожих» и поиске нет: там карточки компактнее);
 *   • showKind — плашка «Фильм»/«Сериал» (нужна в каталоге, где типы смешаны).
 */

/**
 * Постер, а при его отсутствии — кадр: пустая карточка выглядит сломанной.
 * Вынесено из каталога, чтобы все списки использовали одно правило.
 */
export function posterOf(item: MediaSummary): string | null {
  return item.poster || item.backdrop || null;
}

export interface MediaCardProps {
  item: MediaSummary;
  onSelect: (kind: MediaKind, id: number, summary?: MediaSummary) => void;
  /** Бейдж рейтинга TMDB. */
  showScore?: boolean;
  /** Плашка типа тайтла («Фильм»/«Сериал»). */
  showKind?: boolean;
  /**
   * Доп. пункты контекстного меню (правая кнопка) — например «Открыть раздачу»
   * или «В список просмотра» там, где родитель умеет это делать. Общие пункты
   * (открыть, копировать название/оригинальное название) добавляются сами.
   */
  menuExtra?: (item: MediaSummary) => (CtxItem | false | null | undefined)[];
}

export default function MediaCard({
  item,
  onSelect,
  showScore = false,
  showKind = false,
  menuExtra,
}: MediaCardProps) {
  const { t } = useI18n();
  const menu = useContextMenu();
  const img = posterOf(item);
  return (
    <button
      className="mv-card"
      onClick={() => onSelect(item.kind, item.id, item)}
      title={item.title}
      onContextMenu={(e) =>
        menu.open(e, [
          { label: t("ctx.open"), icon: Play, onClick: () => onSelect(item.kind, item.id, item) },
          { separator: true },
          {
            label: t("ctx.copyName"),
            icon: Copy,
            onClick: () => void copyToClipboard(item.title || ""),
          },
          item.originalTitle && item.originalTitle !== item.title
            ? {
                label: t("ctx.copyOriginal"),
                icon: Copy,
                onClick: () => void copyToClipboard(item.originalTitle),
              }
            : null,
          ...(menuExtra ? menuExtra(item) : []),
        ])
      }
    >
      <div className="mv-card-art tone-violet">
        {img ? (
          <img src={imgUrl(img)} alt="" loading="lazy" />
        ) : (
          <Film size={22} strokeWidth={1.5} />
        )}
        {showScore && item.voteAverage > 0 && (
          <span className="mv-card-score">
            <Star size={11} strokeWidth={2.4} />
            {item.voteAverage.toFixed(1)}
          </span>
        )}
        {showKind && (
          <span className="mv-card-kind">
            {item.kind === "tv" ? t("movies.series") : t("movies.movie")}
          </span>
        )}
      </div>
      <div className="mv-card-title">{item.title}</div>
      <div className="mv-card-meta">{item.year || "—"}</div>
    </button>
  );
}
