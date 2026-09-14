import React from "react";
import { Clock, Film, Star, Check, Trash2 } from "lucide-react";
import { Glass, Btn, EmptyHint } from "../ui";
import { useI18n } from "../../i18n";
import type { MediaStats } from "../../api/types";

/**
 * Карточка личной статистики просмотров: часы, завершённые тайтлы, средний
 * рейтинг, любимые жанры и актёры, распределение оценок, активность по месяцам.
 * Все цифры считает бэкенд (GET /api/movies/stats) из локальной БД.
 */

interface MediaStatsCardProps {
  stats: MediaStats | null;
  onClear: () => void;
  busy?: boolean;
}

/** Горизонтальная метрика с процентом от максимума. */
function BarList({ title, items, tone }: { title: string; items: { name: string; count: number }[]; tone: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="mv-stat-block">
      <h4>{title}</h4>
      {items.length === 0 ? <div className="muted-sm">—</div> : (
        <div className="mv-bars">
          {items.map((it) => (
            <div key={it.name} className="mv-bar-row">
              <span className="mv-bar-name" title={it.name}>{it.name}</span>
              <div className="mv-bar-track">
                <div className={`mv-bar-fill tone-${tone}`} style={{ width: `${Math.round((it.count / max) * 100)}%` }} />
              </div>
              <span className="mv-bar-count">{it.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MediaStatsCard({ stats, onClear, busy }: MediaStatsCardProps) {
  const { t } = useI18n();

  if (!stats || stats.totalTitles === 0) {
    return (
      <Glass className="mv-stats">
        <EmptyHint icon={Film} text={t("movies.statsEmpty")} />
      </Glass>
    );
  }

  const maxMonth = Math.max(1, ...stats.monthly.map((m) => m.count));
  const maxHist = Math.max(1, ...stats.ratingHistogram.map((h) => h.count));

  return (
    <div className="mv-stats">
      {/* Верхние метрики */}
      <div className="mv-stat-tiles">
        <Glass className="mv-tile">
          <Clock size={16} />
          <div><b>{stats.totalHours}</b><span>{t("movies.hoursWatched")}</span></div>
        </Glass>
        <Glass className="mv-tile">
          <Check size={16} />
          <div><b>{stats.completed}</b><span>{t("movies.completed")}</span></div>
        </Glass>
        <Glass className="mv-tile">
          <Star size={16} />
          <div><b>{stats.avgRating || "—"}</b><span>{t("movies.avgRating", { n: stats.ratingCount })}</span></div>
        </Glass>
        <Glass className="mv-tile">
          <Film size={16} />
          <div><b>{stats.totalTitles}</b><span>{t("movies.titlesTracked")}</span></div>
        </Glass>
      </div>

      {/* Статусы списка просмотра */}
      <Glass className="mv-stats-block">
        <div className="mv-stat-status">
          <span><i className="mv-dot tone-teal" />{t("movies.statusPlan")}: <b>{stats.watchlist.plan}</b></span>
          <span><i className="mv-dot tone-violet" />{t("movies.statusWatching")}: <b>{stats.watchlist.watching}</b></span>
          <span><i className="mv-dot tone-amber" />{t("movies.statusWatched")}: <b>{stats.watchlist.watched}</b></span>
        </div>
      </Glass>

      <div className="mv-stats-grid">
        <Glass className="mv-stats-block">
          <BarList title={t("movies.topGenres")} items={stats.topGenres} tone="violet" />
        </Glass>
        <Glass className="mv-stats-block">
          <BarList title={t("movies.topActors")} items={stats.topActors} tone="teal" />
        </Glass>
        <Glass className="mv-stats-block">
          {/* Распределение оценок 1–10 */}
          <h4>{t("movies.ratingSpread")}</h4>
          <div className="mv-hist">
            {stats.ratingHistogram.map((h) => (
              <div key={h.value} className="mv-hist-col" title={`${h.value}: ${h.count}`}>
                <div className="mv-hist-bar" style={{ height: `${Math.round((h.count / maxHist) * 100)}%` }} />
                <span>{h.value}</span>
              </div>
            ))}
          </div>
        </Glass>
        <Glass className="mv-stats-block">
          {/* Активность по месяцам */}
          <h4>{t("movies.activity")}</h4>
          {stats.monthly.length === 0 ? <div className="muted-sm">—</div> : (
            <div className="mv-hist">
              {stats.monthly.map((m) => (
                <div key={m.month} className="mv-hist-col" title={`${m.month}: ${m.count}`}>
                  <div className="mv-hist-bar tone-teal" style={{ height: `${Math.round((m.count / maxMonth) * 100)}%` }} />
                  <span>{m.month.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </Glass>
      </div>

      <div className="mv-stats-foot">
        <Btn icon={Trash2} onClick={onClear} disabled={busy}>{t("movies.clearStats")}</Btn>
      </div>
    </div>
  );
}