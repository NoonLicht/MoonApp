import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X, Link2, Upload, Subtitles, HardDrive, Users, AlertTriangle,
  Film, Zap, Download,
} from "lucide-react";
import { Glass, Btn, Badge, Field, Select } from "../ui";
import { usePageActive } from "../Toolbar";
import { getOverlayRoot } from "../overlayHost";
import { useI18n } from "../../i18n";
import { api } from "../../api/client";
import type { TorrentAddResult, TorrentStatus, TorrentFile } from "../../api/types";

/**
 * Модальный плеер страницы «Фильмы и Сериалы».
 *
 * Два режима:
 *  1) Трейлер — встроенный YouTube-плеер (официальные видео TMDB).
 *  2) Торрент — воспроизведение торрента, который пользователь открыл САМ
 *     (magnet-ссылка или .torrent). Бэкенд отдаёт поток через HTTP Range, а
 *     WebTorrent докачивает нужные куски по мере воспроизведения. Приложение
 *     НЕ ищет торренты и не парсит трекеры.
 *
 * Встроенные фичи: статус (прогресс/скорость/пиры), выбор файла из раздачи,
 * выбор скорости, загрузка внешних субтитров (.srt/.vtt), выбор аудиодорожки
 * (если контейнер её отдаёт браузеру).
 */

interface PlayerModalProps {
  onClose: () => void;
  trailerKey?: string | null;
}

function fmtBytes(n?: number | null): string {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtSpeed(bps?: number | null): string {
  return `${fmtBytes(bps || 0)}/s`;
}

/** Прочитать файл как base64 (для отправки .torrent на бэкенд). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || "");
      resolve(s.includes(",") ? s.slice(s.indexOf(",") + 1) : s);
    };
    fr.onerror = () => reject(new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

/** Самый крупный проигрываемый файл в раздаче. */
function pickMainFile(files: TorrentFile[]): number {
  const playable = files.filter((f) => f.playable);
  const list = playable.length ? playable : files;
  return list.slice().sort((a, b) => b.length - a.length)[0]?.index ?? -1;
}

export default function PlayerModal({ onClose, trailerKey }: PlayerModalProps) {
  const { t } = useI18n();
  // keep-alive: на скрытой странице плеер не показываем (портал вне .page-host).
  const active = usePageActive();
  const [mode, setMode] = useState<"trailer" | "torrent">(trailerKey ? "trailer" : "torrent");

  // --- состояние торрент-режима ---
  const [magnet, setMagnet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; code: string } | null>(null);
  const [added, setAdded] = useState<TorrentAddResult | null>(null);
  const [fileIndex, setFileIndex] = useState(-1);
  const [status, setStatus] = useState<TorrentStatus | null>(null);
  const [speed, setSpeed] = useState(1);

  // --- субтитры (.srt/.vtt, локальный файл пользователя) ---
  const [subUrl, setSubUrl] = useState<string | null>(null);
  const [subLabel, setSubLabel] = useState("");
  const [audioTracks, setAudioTracks] = useState<{ id: string; label: string }[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  /** Понятный текст ошибки по коду. */
  const errText = (code: string, msg: string): string => {
    if (code === "engine_missing") return t("movies.torrentNoEngine");
    if (code === "bad_source") return t("movies.torrentBadSource");
    if (code === "metadata_timeout") return t("movies.torrentNoPeers");
    return msg || t("movies.errGeneric");
  };

  const addTorrent = useCallback(async () => {
    const m = magnet.trim();
    if (!m) return;
    setBusy(true);
    setError(null);
    setAdded(null);
    setStatus(null);
    setFileIndex(-1);
    try {
      const res = await api.moviesTorrentAdd({ magnet: m });
      setAdded(res);
      setFileIndex(pickMainFile(res.files));
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      setError({ text: errText(code, (e as Error).message), code });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magnet]);

  /** Открыть локальный .torrent-файл. */
  const openTorrentFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setAdded(null);
    setFileIndex(-1);
    try {
      const b64 = await readBase64(file);
      const res = await api.moviesTorrentAdd({ torrent: b64 });
      setAdded(res);
      setFileIndex(pickMainFile(res.files));
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      setError({ text: errText(code, (e as Error).message), code });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Загрузить внешние субтитры пользователя. */
  const loadSubs = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const blob = new Blob([text], { type: "text/vtt" });
      if (subUrl) URL.revokeObjectURL(subUrl);
      setSubUrl(URL.createObjectURL(blob));
      setSubLabel(file.name);
    } catch { /* игнорируем: субтитры не критичны */ }
  }, [subUrl]);

  // Опрос статуса торрента (прогресс/скорость/пиры) во время загрузки.
  useEffect(() => {
    if (!added) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const st = await api.moviesTorrentStatus(added.infoHash);
        if (alive) setStatus(st);
      } catch { /* временная ошибка — ждём следующий тик */ }
    };
    void tick();
    const timer = window.setInterval(tick, 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [added]);

  // Скорость воспроизведения + выбор аудиодорожек (если браузер их отдаёт).
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, fileIndex, added]);

  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { id: string; label: string; enabled: boolean } } }) | null;
    if (!v || !v.audioTracks) { setAudioTracks([]); return; }
    const list: { id: string; label: string }[] = [];
    for (let i = 0; i < v.audioTracks.length; i++) {
      const tr = v.audioTracks[i];
      list.push({ id: tr.id, label: tr.label || `Track ${i + 1}` });
    }
    setAudioTracks(list);
  }, [fileIndex, added]);

  // При закрытии освобождаем blob-url субтитров и снимаем торрент.
  useEffect(() => () => {
    if (subUrl) URL.revokeObjectURL(subUrl);
  }, [subUrl]);

  const closeAll = () => {
    if (added) api.moviesTorrentRemove(added.infoHash).catch(() => {});
    onClose();
  };

  const streamUrl = added && fileIndex >= 0 ? api.moviesTorrentStreamUrl(added.infoHash, fileIndex) : null;
  const currentFile = added?.files.find((f) => f.index === fileIndex) || null;

  if (!active) return null;

  return createPortal(
    <div className="mv-modal-backdrop" onClick={closeAll}>
      <Glass className="mv-player glass-solid" onClick={(e) => e.stopPropagation()}>
        <div className="mv-player-head">
          <div className="mv-player-tabs">
            {trailerKey && (
              <button className={mode === "trailer" ? "is-active" : ""} onClick={() => setMode("trailer")}>
                <Film size={14} /> {t("movies.trailer")}
              </button>
            )}
            <button className={mode === "torrent" ? "is-active" : ""} onClick={() => setMode("torrent")}>
              <Zap size={14} /> {t("movies.torrent")}
            </button>
          </div>
          <button className="mv-close" onClick={closeAll} title={t("common.close")}><X size={16} /></button>
        </div>

        {mode === "trailer" && trailerKey && (
          <div className="mv-video-frame">
            <iframe
              src={`https://www.youtube.com/embed/${trailerKey}`}
              title={t("movies.trailer")}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
        )}

        {mode === "torrent" && (
          <div className="mv-torrent">
            {/* Источник задаёт пользователь: magnet или .torrent */}
            <div className="mv-torrent-src">
              <Field label={t("movies.magnet")}>
                <div className="mv-magnet-row">
                  <input
                    className="text-input"
                    value={magnet}
                    onChange={(e) => setMagnet(e.target.value)}
                    placeholder="magnet:?xt=urn:btih:…"
                    onKeyDown={(e) => { if (e.key === "Enter") void addTorrent(); }}
                  />
                  <Btn variant="primary" icon={Link2} disabled={busy || !magnet.trim()} onClick={() => void addTorrent()}>
                    {t("movies.openSource")}
                  </Btn>
                </div>
              </Field>
              <label className="mv-file-btn">
                <Upload size={14} /> {t("movies.openTorrentFile")}
                <input
                  type="file" accept=".torrent,application/x-bittorrent" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void openTorrentFile(f); e.currentTarget.value = ""; }}
                />
              </label>
              <div className="muted-sm">{t("movies.torrentNotice")}</div>
            </div>

            {busy && <div className="mv-torrent-busy">{t("movies.torrentConnecting")}</div>}

            {error && (
              <div className="mv-error-inline">
                <AlertTriangle size={15} style={{ color: "var(--coral)" }} />
                <span>{error.text}</span>
                {error.code === "engine_missing" && <span className="muted-sm">{t("movies.torrentEngineHint")}</span>}
              </div>
            )}

            {/* Видео: HTML5-плеер поверх HTTP Range-стрима торрента */}
            {streamUrl && currentFile && (
              <div className="mv-video-frame">
                <video ref={videoRef} key={streamUrl} src={streamUrl} controls autoPlay playsInline>
                  {subUrl && <track kind="subtitles" src={subUrl} srcLang="ru" label={subLabel || "subtitles"} default />}
                </video>
              </div>
            )}

            {/* Управление: скорость, субтитры, аудиодорожка */}
            {streamUrl && (
              <div className="mv-player-controls">
                <Field label={t("player.speed")} w={110}>
                  <Select
                    value={String(speed)}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    options={[
                      { value: "0.5", label: "0.5x" }, { value: "0.75", label: "0.75x" },
                      { value: "1", label: "1x" }, { value: "1.25", label: "1.25x" },
                      { value: "1.5", label: "1.5x" }, { value: "2", label: "2x" },
                    ]}
                  />
                </Field>
                <label className="mv-file-btn">
                  <Subtitles size={14} /> {subLabel || t("movies.subtitles")}
                  <input
                    type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadSubs(f); e.currentTarget.value = ""; }}
                  />
                </label>
                {audioTracks.length > 1 && (
                  <Field label={t("movies.audioTrack")} w={170}>
                    <Select
                      value={audioTracks[0].id}
                      onChange={(e) => {
                        const v = videoRef.current as (HTMLVideoElement & { audioTracks?: any }) | null;
                        if (!v?.audioTracks) return;
                        for (let i = 0; i < v.audioTracks.length; i++) {
                          v.audioTracks[i].enabled = v.audioTracks[i].id === e.target.value;
                        }
                      }}
                      options={audioTracks.map((a) => ({ value: a.id, label: a.label }))}
                    />
                  </Field>
                )}
              </div>
            )}

            {/* Файлы раздачи (если их несколько) */}
            {added && added.files.length > 1 && (
              <div className="mv-file-list">
                <div className="mv-file-list-label">{t("movies.files")}</div>
                {added.files.map((f) => (
                  <button
                    key={f.index}
                    className={`mv-file-item ${f.index === fileIndex ? "is-active" : ""}`}
                    onClick={() => setFileIndex(f.index)}
                  >
                    <Film size={14} />
                    <span className="mv-file-name">{f.name}</span>
                    <span className="muted-sm">{fmtBytes(f.length)}</span>
                    {!f.playable && <Badge tone="neutral">{t("movies.notPlayable")}</Badge>}
                  </button>
                ))}
              </div>
            )}

            {/* Статус загрузки: прогресс, скорость, пиры, объём */}
            {status && (
              <div className="mv-status">
                <div className="mv-status-bar">
                  <div className="mv-status-fill" style={{ width: `${Math.round(status.progress * 100)}%` }} />
                </div>
                <div className="mv-status-meta">
                  <span><Download size={12} /> {Math.round(status.progress * 100)}%</span>
                  <span><Zap size={12} /> {fmtSpeed(status.downloadSpeed)}</span>
                  <span><Users size={12} /> {status.peers}</span>
                  <span><HardDrive size={12} /> {fmtBytes(status.downloaded)} / {fmtBytes(status.length)}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </Glass>
    </div>,
    getOverlayRoot() ?? document.body
  );
}