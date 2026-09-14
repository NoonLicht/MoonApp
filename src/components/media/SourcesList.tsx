import React from "react";
import { Play, Zap, ExternalLink, Tv } from "lucide-react";
import { Btn, EmptyHint } from "../ui";
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

/** Строка площадок одной категории (подписка/аренда/покупка). */
function ProviderRow({ label, items }: { label: string; items: MediaProvider[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mv-providers-row">
      <span className="mv-providers-label">{label}</span>
      <div className="mv-providers-list">
        {items.map((p) => (
          <div key={p.id} className="mv-provider" title={p.name}>
            {p.logo ? <img src={imgUrl(p.logo)} alt={p.name} loading="lazy" /> : <Tv size={16} />}
            <span>{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SourcesList({ providers, hasTrailer, onTrailer, onTorrent }: SourcesListProps) {
  const { t } = useI18n();
  const hasAny = providers && (providers.flatrate.length || providers.rent.length || providers.buy.length);

  return (
    <div className="mv-sources">
      <div className="mv-sources-head">
        <h4>{t("movies.whereToWatch")}</h4>
        {providers?.link && (
          <a className="mv-providers-link" href={providers.link} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={13} /> TMDB
          </a>
        )}
      </div>

      {hasAny ? (
        <>
          <ProviderRow label={t("movies.subscription")} items={providers!.flatrate} />
          <ProviderRow label={t("movies.rent")} items={providers!.rent} />
          <ProviderRow label={t("movies.buy")} items={providers!.buy} />
        </>
      ) : (
        <EmptyHint icon={Tv} text={t("movies.noProviders")} />
      )}

      <div className="mv-sources-actions">
        {hasTrailer && <Btn icon={Play} onClick={onTrailer}>{t("movies.watchTrailer")}</Btn>}
        <Btn icon={Zap} onClick={onTorrent}>{t("movies.openPlayer")}</Btn>
      </div>
    </div>
  );
}