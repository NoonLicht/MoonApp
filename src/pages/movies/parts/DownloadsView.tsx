import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { Btn, Checkbox, EmptyHint, Glass, ProgressBar } from "@/components/ui";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TorrentDownload } from "@/api/types";
import { fmtBytes, fmtSpeed } from "@/pages/movies/lib/bytes";
import { fmtTime } from "@/pages/movies/lib/streamUrl";

/**
 * Вкладка «Скачанные» (справа от «Статистики»).
 *
 * Показывает РЕЕСТР загрузок плеера (server/ts/torrent.ts → listDownloads): что
 * качается сейчас, что остановлено и что уже скачано. Отсюда можно:
 *  - продолжить просмотр (открывает плеер на этой раздаче — окно восстанавливается,
 *    даже если его случайно закрыли);
 *  - поставить загрузку на паузу («Стоп») и возобновить её;
 *  - удалить раздачу вместе со скачанными файлами;
 *  - задать общую галочку «хранить скачанное после просмотра» и разово убрать
 *    ненужные завершённые загрузки (освободить место).
 *
 * Прогресс обновляется опросом раз в 2.5 с, пока есть активные раздачи.
 */
interface DownloadsViewProps {
  /** Открыть раздачу в плеере (то же окно, что и при клике по фильму). */
  onPlay: (d: TorrentDownload) => void;
  /** Счётчик для родителя (бейдж на вкладке) — необязательный. */
  onChanged?: (count: number) => void;
}

export default function DownloadsView({ onPlay, onChanged }: DownloadsViewProps) {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [items, setItems] = useState<TorrentDownload[]>([]);
  const [keepDefault, setKeepDefault] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.moviesTorrentDownloads();
      setItems(res.items);
      setKeepDefault(res.keepDefault);
      onChanged?.(res.items.length);
    } catch (e) {
      setError({ text: (e as Error).message || t("movies.errGeneric") });
    } finally {
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  // Опрос прогресса только пока что-то реально качается.
  useEffect(() => {
    if (!items.some((d) => d.active)) return undefined;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [items, load]);

  /** Обёртка действия: блокировка на строку и понятная ошибка вместо «сырой». */
  const act = useCallback(
    async (infoHash: string, fn: () => Promise<unknown>) => {
      setBusy(infoHash);
      setError(null);
      try {
        await fn();
        await load();
      } catch (e) {
        setError({ text: (e as Error).message || t("movies.errGeneric") });
      } finally {
        setBusy(null);
      }
    },
    [load, t],
  );

  /** Общая галочка «хранить скачанное после просмотра» (settings.movies). */
  const toggleKeepDefault = useCallback(
    async (next: boolean) => {
      setBusy("__keep__");
      setError(null);
      try {
        const res = await api.moviesTorrentKeep({ keep: next, saveDefault: true });
        setKeepDefault(res.keepDefault);
        await load();
      } catch (e) {
        setError({ text: (e as Error).message || t("movies.errGeneric") });
      } finally {
        setBusy(null);
      }
    },
    [load, t],
  );

  const stateLabel = (d: TorrentDownload): string =>
    d.state === "done"
      ? t("movies.dlDone")
      : d.state === "paused"
        ? t("movies.dlPaused")
        : t("movies.dlDownloading");

  /** Текст ошибки для плашки (читаем состояние явно — иначе JSX не сужает тип). */
  const errorText = error?.text || "";

  if (!loaded) {
    return <div className="mv-downloads muted-sm">{t("movies.dlLoading")}</div>;
  }

  return (
    <div className="mv-downloads">
      <div className="mv-dl-head">
        <span className="mv-dl-keep">
          <Checkbox checked={keepDefault} onClick={() => void toggleKeepDefault(!keepDefault)} />
          <span>{t("movies.dlKeepDefault")}</span>
        </span>
        <span className="muted-sm">{t("movies.dlKeepHint")}</span>
        <span className="mv-vp-spacer" />
        <Btn
          icon={RefreshCw}
          disabled={busy !== null}
          onClick={() => void load()}
          title={t("movies.refresh")}
        />
        <Btn
          icon={Trash2}
          disabled={busy !== null}
          onClick={() =>
            void act("__cleanup__", async () => {
              await api.moviesTorrentCleanup();
            })
          }
          title={t("movies.dlCleanup")}
        >
          {t("movies.dlCleanup")}
        </Btn>
      </div>

      {errorText ? (
        <div className="mv-error-inline">
          <AlertTriangle size={15} style={{ color: "var(--coral)" }} /> {errorText}
        </div>
      ) : null}

      {items.length === 0 && <EmptyHint icon={Download} text={t("movies.dlEmpty")} />}

      {items.map((d) => (
        <Glass
          key={d.infoHash}
          className="mv-dl-item"
          onContextMenu={(e) =>
            menu.open(e, [
              {
                label: d.position > 30 ? t("movies.dlContinue") : t("movies.trackerOpen"),
                icon: Play,
                onClick: () => onPlay(d),
              },
              { separator: true },
              d.active
                ? {
                    label: t("movies.dlStop"),
                    icon: Pause,
                    onClick: () => void act(d.infoHash, () => api.moviesTorrentStop(d.infoHash)),
                  }
                : {
                    label: t("movies.dlResume"),
                    icon: RefreshCw,
                    onClick: () => void act(d.infoHash, () => api.moviesTorrentResume(d.infoHash)),
                  },
              {
                label: t("ctx.copyName"),
                icon: Copy,
                onClick: () => void copyToClipboard(d.title || d.name || ""),
              },
              { separator: true },
              {
                label: t("movies.dlDelete"),
                icon: Trash2,
                danger: true,
                onClick: () =>
                  void act(d.infoHash, () =>
                    api.moviesTorrentRemove(d.infoHash, { files: true }),
                  ),
              },
            ])
          }
        >
          <div className="mv-dl-title" title={d.title || d.name}>
            {d.title || d.name}
            {d.title && d.name && <span className="muted-sm mv-dl-sub">{d.name}</span>}
          </div>

          <div className="mv-dl-meta">
            <span className={d.state === "done" ? "is-ok" : d.active ? "is-live" : ""}>
              {d.state === "done" ? (
                <CheckCircle2 size={12} />
              ) : d.active ? (
                <Zap size={12} />
              ) : (
                <Pause size={12} />
              )}{" "}
              {stateLabel(d)}
            </span>
            <span className="muted-sm">
              <HardDrive size={12} /> {fmtBytes(d.length)}
            </span>
            {d.active && (
              <>
                <span className="muted-sm">
                  <Zap size={12} /> {fmtSpeed(d.downloadSpeed)}
                </span>
                <span className="muted-sm">
                  <Users size={12} /> {d.peers}
                </span>
              </>
            )}
            {d.position > 30 && (
              <span className="muted-sm">
                {t("movies.dlPosition", { time: fmtTime(d.position) })}
              </span>
            )}
          </div>

          <div className="mv-dl-progress">
            <ProgressBar value={Math.round(d.progress * 100)} />
            <span className="muted-sm">
              {Math.round(d.progress * 100)}% · {fmtBytes(d.downloaded)} / {fmtBytes(d.length)}
            </span>
          </div>

          <div className="mv-dl-actions">
            <Btn variant="primary" icon={Play} disabled={busy !== null} onClick={() => onPlay(d)}>
              {d.position > 30 ? t("movies.dlContinue") : t("movies.trackerOpen")}
            </Btn>
            {d.active ? (
              <Btn
                icon={Pause}
                disabled={busy !== null}
                onClick={() => void act(d.infoHash, () => api.moviesTorrentStop(d.infoHash))}
              >
                {t("movies.dlStop")}
              </Btn>
            ) : (
              <Btn
                icon={RefreshCw}
                disabled={busy !== null}
                onClick={() => void act(d.infoHash, () => api.moviesTorrentResume(d.infoHash))}
              >
                {t("movies.dlResume")}
              </Btn>
            )}
            <Btn
              icon={Trash2}
              disabled={busy !== null}
              onClick={() =>
                void act(d.infoHash, () => api.moviesTorrentRemove(d.infoHash, { files: true }))
              }
              title={t("movies.dlDeleteHint")}
            >
              {t("movies.dlDelete")}
            </Btn>
            <span className="mv-dl-keep">
              <Checkbox
                checked={d.kept}
                onClick={() =>
                  void act(d.infoHash, () =>
                    api.moviesTorrentKeep({ infoHash: d.infoHash, keep: !d.kept }),
                  )
                }
              />
              <span className="muted-sm">{t("movies.dlKeep")}</span>
            </span>
          </div>
        </Glass>
      ))}
    </div>
  );
}