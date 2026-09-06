import React, { useState, useEffect, useCallback } from "react";
import {
  Music2, Download, Search, RefreshCw, AlertTriangle, Check,
  FileAudio, Disc3, Headphones,
} from "lucide-react";
import { Glass, Btn, Badge, Select, SectionHead, EmptyHint, ProgressBar } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { MusicTrack, MusicFormats, MusicJobStatus } from "../api/types";

// Форматы/качества для выбора в тулбаре
const QUALITY_OPTIONS = ["320 kbps", "256 kbps", "192 kbps", "128 kbps", "FLAC", "OPUS", "WAV", "AAC"];

function fmtDuration(sec?: number | null): string {
  if (!sec && sec !== 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtSize(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

interface JobFile {
  name: string;
  size: number;
  key: string;
}

export default function MusicPage() {
  const { t } = useI18n();

  // Состояние поиска
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [searchError, setSearchError] = useState("");

  // Состояние скачивания
  const [downloadState, setDownloadState] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const [jobFiles, setJobFiles] = useState<JobFile[]>([]);

  // Выбранный трек для скачивания
  const [selectedTrack, setSelectedTrack] = useState<MusicTrack | null>(null);

  // Качество из тулбара
  const [quality, setQuality] = useState("320 kbps");

  // Качество по умолчанию берём из настроек (раздел «Музыка»).
  useEffect(() => {
    api.getSettings().then((s: any) => {
      if (s?.music?.defaultQuality) setQuality(s.music.defaultQuality);
    }).catch(() => {});
  }, []);
  const [fmtInfo, setFmtInfo] = useState<MusicFormats | null>(null);

  usePageToolbar(
    <Select value={quality} onChange={(e) => setQuality(e.target.value)} options={QUALITY_OPTIONS} />,
    [quality]
  );

  // Загружаем информацию о форматах при монтировании
  useEffect(() => {
    api.musicFormats().then(setFmtInfo).catch(() => {});
  }, []);

  // Опрос статуса джобы
  useEffect(() => {
    if (!downloadJobId) return;
    const timer = setInterval(async () => {
      try {
        const st = await api.musicJobStatus(downloadJobId);
        setDownloadProgress(st.progress || 0);
        if (st.state === "done") {
          setDownloadState("done");
          setJobFiles(st.files || []);
          clearInterval(timer);
        }
        if (st.state === "error") {
          setDownloadState("error");
          setDownloadError(st.error || "");
          clearInterval(timer);
        }
      } catch { /* пропускаем */ }
    }, 800);
    return () => clearInterval(timer);
  }, [downloadJobId]);

  // Поиск
  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearchState("searching");
    setSearchError("");
    setSelectedTrack(null);
    try {
      const result = await api.musicSearch(query.trim());
      setTracks(result.tracks || []);
      setSearchState(result.tracks?.length ? "done" : "done");
    } catch (e) {
      setSearchState("error");
      setSearchError((e as Error).message);
    }
  }, [query]);

  // Выбор трека
  const selectTrack = (track: MusicTrack) => {
    if (downloadState === "downloading") return;
    setSelectedTrack(track);
    setDownloadState("idle");
    setDownloadError("");
    setJobFiles([]);
  };

  // Скачивание
  const doDownload = async () => {
    if (!selectedTrack) return;
    setDownloadState("downloading");
    setDownloadProgress(0);
    setDownloadError("");
    setJobFiles([]);

    try {
      // Маппинг выбранного качества в параметры yt-dlp
      const known = fmtInfo?.qualityMap?.[quality];
      const format = known?.format || "mp3";
      const q = known?.quality ?? 0;
      const result = await api.musicDownload(selectedTrack.webpageUrl, format, q);
      setDownloadJobId(result.id);
    } catch (e) {
      setDownloadState("error");
      setDownloadError((e as Error).message);
    }
  };

  // Скачивание готового файла
  const dlFile = async (key: string) => {
    try {
      const { blob, name } = await api.musicDownloadFile(key);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      setDownloadState("error");
      setDownloadError((e as Error).message);
    }
  };

  // Определяем расширение по выбранному качеству
  const extByQuality = (): string => {
    const known = fmtInfo?.qualityMap?.[quality];
    if (known?.format === "mp3") return "MP3";
    if (known?.format === "m4a") return "M4A";
    if (known?.format === "flac") return "FLAC";
    if (known?.format === "opus") return "OPUS";
    if (known?.format === "wav") return "WAV";
    return "MP3";
  };

  // Показать интерфейс проигрывателя/результатов
  const showPlayer = searchState !== "idle" || selectedTrack;

  return (
    <div className="page">
      <SectionHead eyebrow={t("music.eyebrow")} title={t("music.title")} />

      {/* Поисковая строка */}
      <Glass className="url-bar">
        <Music2 size={16} />
        <input
          placeholder={t("music.paste")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
        />
        <Btn
          variant="primary"
          onClick={doSearch}
          disabled={searchState === "searching"}
        >
          {searchState === "searching" ? (
            <><RefreshCw size={14} className="spin" /> {t("common.loading")}</>
          ) : (
            <><Search size={14} /> {t("music.find")}</>
          )}
        </Btn>
      </Glass>

      {/* Результаты поиска */}
      {searchState === "searching" && (
        <Glass>
          <span className="muted-sm"><RefreshCw size={14} className="spin" /> {t("common.loading")}</span>
        </Glass>
      )}

      {searchState === "error" && searchError && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{searchError}</span>
        </Glass>
      )}

      {searchState === "done" && tracks.length === 0 && !selectedTrack && (
        <EmptyHint icon={Music2} text={t("music.empty")} />
      )}

      {/* Список результатов */}
      {searchState === "done" && tracks.length > 0 && !selectedTrack && (
        <div className="music-results">
          {tracks.map((track) => (
            <Glass
              key={track.id}
              className="music-track-row"
              onClick={() => selectTrack(track)}
              style={{ cursor: "pointer" }}
            >
              <div className="music-track-thumb">
                {track.thumbnail ? (
                  <img
                    src={track.thumbnail}
                    alt=""
                    style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8 }}
                  />
                ) : (
                  <Disc3 size={24} strokeWidth={1.5} />
                )}
              </div>
              <div className="music-track-info">
                <div className="music-track-title">{track.title}</div>
                <div className="muted-sm">
                  {track.artist} · {fmtDuration(track.duration)}
                </div>
              </div>
              <Btn
                variant="ghost"
                icon={Download}
                onClick={(e) => { e.stopPropagation(); selectTrack(track); }}
              />
            </Glass>
          ))}
        </div>
      )}

      {/* Панель выбранного трека */}
      {selectedTrack && (
        <Glass className="media-preview">
          <div className="media-thumb tone-violet">
            {selectedTrack.thumbnail ? (
              <img
                src={selectedTrack.thumbnail}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 10 }}
              />
            ) : (
              <Music2 size={24} strokeWidth={1.5} />
            )}
          </div>
          <div className="media-info">
            <div className="media-title">{selectedTrack.title}</div>
            <div className="muted-sm">
              {selectedTrack.artist} · {fmtDuration(selectedTrack.duration)}
            </div>

            {/* Бейджи формата / качества */}
            {downloadState !== "downloading" && downloadState !== "done" && (
              <div className="quality-row" style={{ marginTop: 4 }}>
                <Badge tone="violet" active>{quality}</Badge>
                <Badge tone="violet">{extByQuality()}</Badge>
              </div>
            )}

            {/* Кнопка скачивания */}
            {downloadState === "idle" && (
              <Btn variant="primary" icon={Download} onClick={doDownload} style={{ width: 200 }}>
                {t("music.download")}
              </Btn>
            )}

            {/* Прогресс */}
            {downloadState === "downloading" && (
              <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="muted-sm">
                  <RefreshCw size={14} className="spin" /> {t("video.downloading", { p: downloadProgress })}
                </div>
                <ProgressBar value={downloadProgress} />
              </div>
            )}

            {/* Ошибка */}
            {downloadState === "error" && downloadError && (
              <div className="source-placeholder" style={{ borderColor: "var(--coral)", padding: "8px 12px" }}>
                <AlertTriangle size={14} style={{ color: "var(--coral)" }} />
                <span>{downloadError}</span>
              </div>
            )}

            {/* Готово — кнопка "Скачать файл" */}
            {downloadState === "done" && jobFiles.length > 0 && (
              <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ color: "var(--success)", display: "flex", alignItems: "center", gap: 6 }}>
                  <Check size={16} /> {t("video.saved")}
                </div>
                {jobFiles.map((f) => (
                  <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <FileAudio size={16} className="muted-sm" />
                    <span className="muted-sm">{f.name} · {fmtSize(f.size)}</span>
                    <Btn variant="primary" icon={Download} onClick={() => dlFile(f.key)}>
                      {t("music.download")}
                    </Btn>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Glass>
      )}

      {/* Пустое состояние (idle) */}
      {!showPlayer && (
        <EmptyHint icon={Headphones} text={t("music.empty")} />
      )}
    </div>
  );
}