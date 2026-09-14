import React from "react";
import { Play, Zap, ExternalLink, Tv } from "lucide-react";
import { Btn } from "../ui";
import { useI18n } from "../../i18n";
import { imgUrl } from "./mediaImg";
import type { MediaProviders, MediaProvider } from "../../api/types";

/**
 * Блок «Источники воспроизведения» в карточке тайтла.
 *
 * Легальная часть — площадки из TMDB watch/providers (Netflix/Prime/Кинопоиск
 * и т.п.) по региону пользователя, с диплинком на страницу тайтла.
 * Отдельно — кнопки «трейлер» и «торрент»: торрент пользователь открывает сам
 * (magnet/.torrent), приложение не ищет раздачи.
 */

interface SourcesListProps {
  providers: MediaProviders | null;
  hasTrailer: boolean;
  onTrailer: () => void;
  onTorrent: () => void;
}

/** Максимум видимых площадок: остальные сворачиваются в «+N ещё». */
const CHIP_LIMIT = 6;

type ChipKind = "flat" | "rent" | "buy";
interface Chip { provider: MediaProvider; kind: ChipKind }

/**
 * Компактная полоска площадок: одна строка с чипами «логотип + название».
 * Тип (подписка/аренда/покупка) кодируется рамкой и подсказкой, а не отдельной
 * строкой с подписью — раньше три ряда растягивали футер карточки.
 */
export default function SourcesList({ providers, hasTrailer, onTrailer, onTorrent }: SourcesListProps) {
  const { t } = useI18n();

  const all: Chip[] = [
    ...(providers?.flatrate || []).map((p) => ({ provider: p, kind: "flat" as ChipKind })),
    ...(providers?.rent || []).map((p) => ({ provider: p, kind: "rent" as ChipKind })),
    ...(providers?.buy || []).map((p) => ({ provider: p, kind: "buy" as ChipKind })),
  ];
  const shown = all.slice(0, CHIP_LIMIT);
  const rest = all.slice(CHIP_LIMIT);
  /** Подпись типа площадки для подсказки. */
  const kindLabel = (k: ChipKind) => t(`movies.${k === "flat" ? "subscription" : k}`);

  return (
    <div className="mv-sources">
      <span className="mv-sources-label">{t("movies.whereToWatch")}</span>

      <div className="mv-watch-row">
        {all.length === 0 && <span className="muted-sm">{t("movies.noProviders")}</span>}
        {shown.map((c) => (
          <span
            key={`${c.kind}-${c.provider.id}`}
            className={`mv-chip is-${c.kind}`}
            title={`${kindLabel(c.kind)}: ${c.provider.name}`}
          >
            {c.provider.logo ? <img src={imgUrl(c.provider.logo)} alt="" loading="lazy" /> : <Tv size={12} />}
            <span className="mv-chip-name">{c.provider.name}</span>
          </span>
        ))}
        {rest.length > 0 && (
          <span
            className="mv-chip is-more"
            title={rest.map((c) => `${kindLabel(c.kind)}: ${c.provider.name}`).join(", ")}
          >
            {t("movies.providersMore", { n: rest.length })}
          </span>
        )}
        {providers?.link && (
          <a className="mv-sources-link" href={providers.link} target="_blank" rel="noreferrer noopener" title="TMDB">
            <ExternalLink size={12} />
          </a>
        )}
      </div>

      <div className="mv-sources-actions">
        {hasTrailer && <Btn icon={Play} onClick={onTrailer}>{t("movies.watchTrailer")}</Btn>}
        <Btn icon={Zap} onClick={onTorrent}>{t("movies.openPlayer")}</Btn>
      </div>
    </div>
  );
}