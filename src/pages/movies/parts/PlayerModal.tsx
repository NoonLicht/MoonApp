import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  HardDrive,
  Link2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
} from "lucide-react";
import { Glass, Btn, Badge, Field, Checkbox } from "@/components/ui";
import { usePageActive } from "@/components/Toolbar";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  FfmpegStatus,
  TorrentAddResult,
  TorrentFile,
  TorrentPlaybackPlan,
  TorrentStatus,
  TorrentTrackList,
} from "@/api/types";
import TrackerSearch from "@/pages/movies/parts/TrackerSearch";
import VideoPlayer from "@/pages/movies/parts/VideoPlayer";
import { subtitleUrl, fmtTime, isDirectPlayable } from "@/pages/movies/lib/streamUrl";
import { exactSeekLevel, lastRetryLevel, playbackMode, seekableSeconds, streamUrlFor } from "@/pages/movies/lib/playback";
import { fmtBytes, fmtSpeed } from "@/pages/movies/lib/bytes";

/**
 * Модальный плеер страницы «Фильмы».
 *
 * Два режима:
 *  1) Трейлер — встроенный YouTube-плеер (официальные видео TMDB).
 *  2) Торрент — воспроизведение раздачи, которую пользователь открыл САМ (magnet,
 *     .torrent или раздача из поиска). Бэкенд отдаёт поток через HTTP Range, а
 *     WebTorrent докачивает куски по мере просмотра: смотреть можно ВО ВРЕМЯ
 *     скачивания. Видео показывает СВОЙ плеер (VideoPlayer) — с полным набором
 *     кнопок и кнопками управления самой раздачей.
 *
 * Про загрузки: каждая раздача попадает в реестр (server/ts/torrent.ts), поэтому
 *   • окно, закрытое случайно, восстанавливается при повторном открытии фильма
 *     (или из вкладки «Скачанные»);
 *   • загрузку можно остановить (пауза) и возобновить, удалить вместе с файлами;
 *   • галочка «хранить после просмотра» решает, сохранять ли скачанное.
 */
interface PlayerModalProps {
  onClose: () => void;
  trailerKey?: string | null;
  /** Название открытого фильма: по нему восстанавливается прежняя загрузка. */
  query?: string | null;
  /** Открыть конкретную загрузку из вкладки «Скачанные». */
  download?: { infoHash: string; title?: string } | null;
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

export default function PlayerModal({ onClose, trailerKey, query, download }: PlayerModalProps) {
  const { t } = useI18n();
  // keep-alive: на скрытой странице плеер не показываем (портал вне .page-host).
  const active = usePageActive();
  const [mode, setMode] = useState<"trailer" | "torrent" | "search">(
    trailerKey && !download ? "trailer" : "torrent",
  );

  // --- состояние торрент-режима ---
  const [magnet, setMagnet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; code: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [added, setAdded] = useState<TorrentAddResult | null>(null);
  const [fileIndex, setFileIndex] = useState(-1);
  const [status, setStatus] = useState<TorrentStatus | null>(null);
  /** Раздача остановлена (пауза) — показываем «Продолжить» вместо «Стоп». */
  const [paused, setPaused] = useState(false);
  /** Галочка «хранить скачанный торрент после просмотра». */
  const [keep, setKeep] = useState(true);
  /** Секунда просмотра: сохраняется в реестр и используется для продолжения. */
  const [position, setPosition] = useState(0);
  const positionRef = useRef(0);
  /**
   * Порядковый номер перемотки/пересоздания потока: применяем только результат
   * самого свежего запроса (медленный ответ на старую перемотку не должен
   * перебивать новую).
   */
  const seekSeq = useRef(0);

  // --- субтитры и дорожки ---
  const [tracks, setTracks] = useState<TorrentTrackList | null>(null);
  /** Почему нет выбора дорожек: нет ffmpeg (ffmpeg_missing) или сбой чтения. */
  const [tracksError, setTracksError] = useState<{ code: string; message: string } | null>(null);
  const [audioIndex, setAudioIndex] = useState(0);
  /** Позиция старта remux-потока: перемотка = новый запрос с &start=. */
  const [pendingStart, setPendingStart] = useState(0);
  /**
   * Старт уже выровнен по ключевому кадру (ответ /torrent/seek) — в URL потока
   * уходит aligned=1, и бэкенд НЕ переспрашивает ffprobe. Без этого сервер
   * выравнивал секунду повторно и сдвигал старт (в логах: запрос 1174 с, поток
   * с 1172.546) — звук и шкала расходились с картинкой.
   */
  const [pendingAligned, setPendingAligned] = useState(false);
  const [subTrack, setSubTrack] = useState("");
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  /**
   * Лестница фолбэков потока: 0 — режим из плана, 1 и 2 — ступени ниже
   * (remux → transcode). Сброс при смене файла, раздачи и аудиодорожки.
   */
  const [retryLevel, setRetryLevel] = useState(0);
  /** Ручное «Пересоздать поток»: тот же режим, но новый запрос к бэкенду. */
  const [retryNonce, setRetryNonce] = useState(0);
  /** Новый файл/раздача/дорожка — лестницу фолбэков проходим заново. */
  const resetStream = useCallback(() => {
    setRetryLevel(0);
    setRetryNonce(0);
  }, []);

  /**
   * Честная секунда старта потока.
   *
   * Копирование видео при перемотке невозможно: при `-ss` ffmpeg позиционируется на
   * ключевой кадр СТРОГО до секунды реза, а звук режет ровно по ней — картинка уходит
   * вперёд звука на длину GOP (живой замер: 2.294 с). Поэтому плеер всегда перематывает
   * точным seek (copy=0 → видео перекодируется, см. exactSeekLevel) и берёт у сервера
   * подтверждённую секунду старта: шкала, субтитры и сохранённая позиция показывают то,
   * что реально на экране. Начало фильма — реза нет, старт точен и без запросов.
   */
  const alignStart = useCallback(
    async (
      target: { infoHash: string; index: number },
      atSec: number,
    ): Promise<{ startSec: number; keyframe: boolean }> => {
      const targetSec = Math.max(0, Math.floor(Number(atSec) || 0));
      if (targetSec <= 0 || !target.infoHash || target.index < 0)
        return { startSec: targetSec, keyframe: true };
      try {
        // copy=0 — точный seek: видео перекодируется, секунда точная (exact).
        const info = await api.moviesTorrentSeek(target.infoHash, target.index, targetSec, false);
        if (!info.exact) {
          // Сервер ответил, что точный старт не получится (например файла ещё нет):
          // говорим об этом честно, а вызывающий решает про ступень.
          setNotice(t("movies.playerExactSeek"));
        }
        return { startSec: info.startSec, keyframe: info.exact || info.keyframe };
      } catch {
        // Раздача только добавилась или бэкенд занят. Стартуем с запрошенной секунды:
        // поток всё равно перекодируется, поэтому старт остаётся точным.
        setNotice(t("movies.playerExactSeek"));
        return { startSec: targetSec, keyframe: false };
      }
    },
    [t],
  );
  /** Восстановление прежней загрузки выполняем один раз за открытие окна. */
  const restored = useRef(false);

  /** Понятный текст ошибки по коду. */
  const errText = (code: string, msg: string): string => {
    if (code === "engine_missing") return t("movies.torrentNoEngine");
    if (code === "bad_source") return t("movies.torrentBadSource");
    if (code === "metadata_timeout") return t("movies.torrentNoPeers");
    return msg || t("movies.errGeneric");
  };
  /** Запомнить позицию: в реестр её пишет savePosition (периодически/на паузе). */
  const trackPosition = useCallback((sec: number) => {
    positionRef.current = sec;
    setPosition(sec);
  }, []);

  /** Сохранить позицию в реестр (при закрытии окна и перед пересозданием потока). */
  const savePosition = useCallback(
    (infoHash: string, sec: number) => {
      void api.moviesTorrentPosition(infoHash, Math.max(0, Math.floor(sec))).catch(() => {});
    },
    [],
  );

  /** Добавить раздачу по magnet-ссылке. */
  const addTorrent = useCallback(async () => {
    const m = magnet.trim();
    if (!m) return;
    setBusy(true);
    setError(null);
    setNotice("");
    setAdded(null);
    setStatus(null);
    setFileIndex(-1);
    setTracks(null);
    setTracksError(null);
    try {
      // title — название фильма: по нему окно восстановится при повторном открытии.
      const res = await api.moviesTorrentAdd({ magnet: m, title: String(query || "").trim() });
      setAdded(res);
      setFileIndex(pickMainFile(res.files));
      setPaused(false);
      resetStream();
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      setError({ text: errText(code, (e as Error).message), code });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magnet, query]);

  /** Открыть локальный .torrent-файл. */
  const openTorrentFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice("");
    setAdded(null);
    setStatus(null);
    setFileIndex(-1);
    setTracks(null);
    setTracksError(null);
    try {
      const b64 = await readBase64(file);
      const res = await api.moviesTorrentAdd({ torrent: b64, title: String(query || "").trim() });
      setAdded(res);
      setFileIndex(pickMainFile(res.files));
      setPaused(false);
      resetStream();
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      setError({ text: errText(code, (e as Error).message), code });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  /**
   * Открыть загрузку из реестра: возобновляем раздачу (по .torrent-метафайлу или
   * magnet) и получаем список файлов. Именно этот путь восстанавливает окно, если
   * пользователь случайно его закрыл.
   */
  const openDownload = useCallback(
    async (d: { infoHash: string; title?: string }) => {
      setBusy(true);
      setError(null);
      setMode("torrent");
      try {
        const res = await api
          .moviesTorrentResume(d.infoHash)
          .catch(() => api.moviesTorrentFiles({ infoHash: d.infoHash }));
        setTracks(null);
        setTracksError(null);
        setSubTrack("");
        setAdded(res);
        setFileIndex(pickMainFile(res.files));
        resetStream();
        const list = await api.moviesTorrentDownloads().catch(() => null);
        const entry = list?.items.find((x) => x.infoHash === d.infoHash) || null;
        if (entry) {
          setPaused(false); // resume уже поставил загрузку в работу
          setKeep(entry.kept);
          // Продолжаем с сохранённой секунды, но честно: при переупаковке старт
          // сдвигается к ключевому кадру (иначе звук разъезжается с картинкой).
          const idx = pickMainFile(res.files);
          const file = res.files.find((f) => f.index === idx) || null;
          const aligned = await alignStart({ infoHash: res.infoHash, index: idx }, entry.position);
          trackPosition(aligned.startSec);
          setPendingAligned(aligned.keyframe);
          // Возобновляем с середины фильма: копирование там развело бы звук с картинкой
          // на длину GOP, поэтому сразу ставим ступень точного seek. План в этот момент
          // ещё не посчитан (его даёт /torrent/tracks), поэтому судим по контейнеру:
          // не-passthrough (MKV/AVI) → перекодирование. Старт с нуля ступень не меняет.
          if (aligned.startSec > 0 && !isDirectPlayable(file?.name)) {
            setRetryLevel((n) => Math.max(n, 1));
          }
          if (aligned.startSec > 30) {
            setPendingStart(aligned.startSec);
            setNotice(t("movies.dlContinueFrom", { time: fmtTime(aligned.startSec) }));
          }
        }
        setPaused(false);
      } catch (e) {
        const code = (e as { code?: string }).code || "";
        setError({ text: errText(code, (e as Error).message), code });
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, trackPosition, alignStart],
  );

  // Восстановление загрузки при открытии окна: явная раздача из «Скачанных» или
  // прежняя загрузка того же фильма (окно могли закрыть случайно).
  useEffect(() => {
    if (restored.current) return;
    if (download?.infoHash) {
      restored.current = true;
      void openDownload(download);
      return;
    }
    const q = String(query || "").trim();
    if (!q) return;
    restored.current = true;
    void (async () => {
      const list = await api.moviesTorrentDownloads().catch(() => null);
      const hit = list?.items.find((x) => x.title.trim().toLowerCase() === q.toLowerCase());
      if (hit) {
        await openDownload({ infoHash: hit.infoHash, title: hit.title });
        // Явно объясняем, почему плеер открылся на прежней загрузке, а не на трейлере.
        if (hit.position <= 30) setNotice(t("movies.dlRestored", { title: hit.title || hit.name }));
      }
    })();
  }, [download, query, openDownload, t]);
// Опрос статуса торрента (прогресс/скорость/пиры) во время загрузки.
  useEffect(() => {
    if (!added || paused) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const st = await api.moviesTorrentStatus(added.infoHash);
        if (!alive) return;
        setStatus(st);
        // Раздача докачалась, а хранить её не просили — освобождаем место.
        if (st.done && !keep) void api.moviesTorrentCleanup().catch(() => {});
      } catch {
        /* временная ошибка — ждём следующий тик */
      }
    };
    void tick();
    const timer = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [added, paused, keep]);

  /** Проверка ffmpeg для плеера: кнопка «Проверить снова» пересобирает кэш. */
  const checkFfmpeg = useCallback(async (force: boolean) => {
    try {
      setFfmpeg(await api.moviesFfmpeg(force));
    } catch {
      /* статус не критичен: дорожки просто будут недоступны */
    }
  }, []);

  useEffect(() => {
    void checkFfmpeg(false);
  }, [checkFfmpeg]);

  /**
   * Дорожки файла (ffprobe): аудио и субтитры. Ошибку показываем ЧЕСТНО: раньше
   * любой сбой выглядел как «FFmpeg не установлен», хотя причина могла быть в
   * неготовом стриме (раздача только добавилась) или в самом контейнере.
   */
  useEffect(() => {
    if (!added || fileIndex < 0) return undefined;
    let alive = true;
    void (async () => {
      try {
        const res = await api.moviesTorrentTracks(added.infoHash, fileIndex);
        if (!alive) return;
        setTracks(res);
        setTracksError(null);
        setAudioIndex(res.defaultAudio || 0);
      } catch (e) {
        if (!alive) return;
        const code = (e as { code?: string }).code || "";
        setTracks(null);
        setTracksError({ code, message: (e as Error).message || "" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [added, fileIndex]);

  /** Переключить файл раздачи (серию): бэкенд приоритезирует его куски. */
  const switchFile = useCallback(
    (next: number) => {
      if (!added || next === fileIndex) return;
      api.moviesTorrentSelect(added.infoHash, next).catch(() => {});
      // Смена файла пересоздаёт поток — сбрасываем дорожки, позицию и субтитры.
      setTracks(null);
      setTracksError(null);
      setPendingStart(0);
      setSubTrack("");
      trackPosition(0);
      setFileIndex(next);
      resetStream();
    },
    [added, fileIndex, trackPosition, resetStream],
  );

  /** Раздача выбрана в поиске — открываем её в этом же плеере. */
  const openRelease = useCallback(
    (res: TorrentAddResult & { noMedia: boolean }) => {
      setAdded(res);
      setFileIndex(pickMainFile(res.files));
      // Другая раздача: дорожки/позиция/субтитры прошлой больше не актуальны.
      setTracks(null);
      setTracksError(null);
      setPendingStart(0);
      setSubTrack("");
      trackPosition(0);
      setPaused(false);
      setError(null);
      setNotice("");
      setMode("torrent");
      resetStream();
    },
    [trackPosition, resetStream],
  );

  /** Галочка «хранить скачанный торрент после просмотра» (для этой раздачи). */
  const toggleKeep = useCallback(
    async (next: boolean) => {
      setKeep(next);
      if (added) {
        await api.moviesTorrentKeep({ infoHash: added.infoHash, keep: next }).catch(() => {});
        if (!next) await api.moviesTorrentCleanup().catch(() => {});
      }
    },
    [added],
  );

  /** Остановить загрузку (пауза): канал освобождается, файлы остаются. */
  const stopDownload = useCallback(async () => {
    if (!added) return;
    savePosition(added.infoHash, positionRef.current);
    await api.moviesTorrentStop(added.infoHash).catch(() => {});
    setPaused(true);
    setStatus(null);
    setNotice(t("movies.dlStopped"));
  }, [added, savePosition, t]);

  /** Продолжить остановленную загрузку. */
  const resumeDownload = useCallback(async () => {
    if (!added) return;
    setBusy(true);
    try {
      await api.moviesTorrentResume(added.infoHash);
      setPaused(false);
      setNotice("");
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      setError({ text: errText(code, (e as Error).message), code });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [added]);

  /** Удалить раздачу вместе со скачанными файлами и закрыть окно. */
  const removeDownload = useCallback(async () => {
    if (!added) return;
    setBusy(true);
    try {
      await api.moviesTorrentRemove(added.infoHash, { files: true });
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      setError({ text: errText(code, (e as Error).message), code });
      setBusy(false);
    }
  }, [added, onClose]);
/**
   * Закрыть окно. Что происходит с раздачей:
   *  - галочка «хранить» включена — загрузка идёт в фоне, раздача видна во вкладке
   *    «Скачанные» (скачанное остаётся на диске);
   *  - выключена — завершённую раздачу удаляем вместе с файлами, а незавершённую
   *    останавливаем и оставляем: случайно закрытое окно можно вернуть.
   * Позицию просмотра сохраняем в любом случае.
   */
  const closeAll = useCallback(async () => {
    const info = added;
    if (info) {
      savePosition(info.infoHash, positionRef.current);
      if (keep) {
        await api.moviesTorrentKeep({ infoHash: info.infoHash, keep: true }).catch(() => {});
      } else {
        const st = await api.moviesTorrentStatus(info.infoHash).catch(() => null);
        if (!st || st.done || st.progress > 0.95) {
          await api.moviesTorrentRemove(info.infoHash, { files: true }).catch(() => {});
        } else {
          await api.moviesTorrentStop(info.infoHash).catch(() => {});
        }
      }
    }
    onClose();
  }, [added, keep, onClose, savePosition]);

  /* --- производные значения для разметки --- */

  const audioTracksList = tracks?.audio || [];
  const audioChanged = audioTracksList.length > 0 && audioIndex !== (tracks?.defaultAudio ?? 0);
  const currentFile = added?.files.find((f) => f.index === fileIndex) || null;
  /**
   * План воспроизведения. Основной источник — бэкенд (ffprobe): он видит кодеки
   * и знает, что Chromium не читает MKV/AC3/HEVC. Пока ответ не пришёл (или
   * ffprobe не смог), решаем по расширению: MKV/AVI → переупаковка через ffmpeg.
   * Именно из-за отсутствия этого выбора прямая отдача MKV в <video> падала с
   * ошибкой даже у полностью скачанного фильма.
   */
  const plan: TorrentPlaybackPlan = tracks?.plan || {
    mode: currentFile && isDirectPlayable(currentFile.name) ? "direct" : "remux",
    videoCopy: true,
    reason: "guess",
  };
  /**
   * Лестница фолбэков (direct → remux → transcode) живёт в lib/playback.ts:
   * правила выбора потока покрыты тестами, компонент только подставляет данные.
   */
  const playMode = playbackMode(plan, retryLevel, audioChanged);
  const nativeSeek = playMode === "direct";
  /** URL потока: прямой стрим, переупаковка или перекодирование. */
  const streamSrc = added
    ? streamUrlFor(added.infoHash, fileIndex, {
        mode: playMode,
        audio: audioIndex,
        startSec: pendingStart,
        // Секунда уже выровнена (/torrent/seek) — серверу не выравнивать повторно.
        aligned: pendingAligned,
        nonce: retryNonce,
      })
    : null;
  const subInfo =
    (tracks?.subtitles || []).find(
      (s) => (s.external ? `f${s.fileIndex}` : `t${s.index}`) === subTrack,
    ) || null;
  const serverSubUrl =
    added && fileIndex >= 0 && subInfo
      ? subtitleUrl(added.infoHash, fileIndex, {
          track: subInfo.external ? undefined : subInfo.index,
          file: subInfo.external ? subInfo.fileIndex : undefined,
        })
      : null;
  const subtitleProp = serverSubUrl
    ? {
        src: serverSubUrl,
        label: subInfo?.label || t("movies.subtitles"),
        lang: (subInfo?.language || "ru").slice(0, 2).toLowerCase(),
      }
    : null;
  /** Дорожки субтитров — селект живёт в настройках плеера (шестерёнка). */
  const subtitleOptions = [
    { value: "", label: t("movies.subtitlesOff") },
    ...(tracks?.subtitles || []).map((s) => ({
      value: s.external ? `f${s.fileIndex}` : `t${s.index}`,
      label: s.label,
    })),
  ];
  /**
   * Докуда можно перематывать: доля скачанного файла раздачи. Последовательная
   * стратегия качает куски по порядку, поэтому «скачано N%» = «доступно N%
   * фильма», и это ровно то, что показывает светлая полоса на шкале.
   */
  const fileProgress =
    status?.files?.find((f) => f.index === fileIndex)?.progress ?? status?.progress ?? 0;
  const seekableSec = seekableSeconds({
    durationSec: tracks?.durationSec,
    progress: fileProgress,
    position,
  });
  /** Перемотка за пределы скачанного: честно говорим границу, а не уводим в начало. */
  const onSeekBlocked = useCallback(
    (maxSec: number) => setNotice(t("movies.playerSeekLimit", { time: fmtTime(maxSec) })),
    [t],
  );

  /**
   * Перемотка: сначала честная секунда старта у бэкенда, потом пересоздание потока.
   * С середины фильма перемотка идёт перекодированием (копирование развело бы звук с
   * картинкой на длину GOP), поэтому секунда из шкалы совпадает с кадром на экране.
   */
  const handleSeek = useCallback(
    (sec: number) => {
      const info = added;
      if (!info) return;
      const target = Math.max(0, Math.floor(Number(sec) || 0));
      const seq = ++seekSeq.current;
      void alignStart({ infoHash: info.infoHash, index: fileIndex }, target).then((aligned) => {
        if (seq !== seekSeq.current) return; // пришла более новая перемотка
        setPendingStart(aligned.startSec);
        setPendingAligned(aligned.keyframe);
        // Перемотка — всегда точный seek (перекодирование): копирование начинает видео
        // с ключевого кадра ДО секунды реза и разводит его со звуком на длину GOP
        // (замер: 2.294 с). См. exactSeekLevel в lib/playback.ts.
        setRetryLevel((n) => Math.max(n, exactSeekLevel(plan.mode, aligned.startSec)));
        // Поток живого ffmpeg не seekable: перемотка — это новый запрос. Нонс
        // гарантирует пересоздание даже когда секунда совпала с прежним стартом
        // (иначе URL не изменился бы и перемотка «не сработала бы»).
        setRetryNonce((n) => n + 1);
        trackPosition(aligned.startSec);
      });
    },
    [added, alignStart, fileIndex, plan.mode, trackPosition],
  );

  /**
   * Смена аудиодорожки: после неё режим пересчитывается с нулевой ступени, и
   * «прямой» файл тоже уходит в переупаковку. С середины фильма переупаковка
   * обязана быть точным seek: копирование развело бы новую дорожку с картинкой на
   * длину GOP — тот же рассинхрон, что и при перемотке.
   */
  const switchAudio = useCallback(
    (next: number) => {
      const target = Math.max(0, Math.floor(positionRef.current));
      const seq = ++seekSeq.current;
      void alignStart({ infoHash: added?.infoHash || "", index: fileIndex }, target).then(
        (aligned) => {
          if (seq !== seekSeq.current) return;
          setPendingStart(aligned.startSec);
          setPendingAligned(aligned.keyframe);
          setAudioIndex(next);
          resetStream();
          // Смена дорожки пересчитывает режим с нулевой ступени, поэтому ступень
          // точного seek (нужна не с начала фильма) ставим ПОСЛЕ resetStream.
          setRetryLevel((n) => Math.max(n, exactSeekLevel(plan.mode, aligned.startSec)));
        },
      );
    },
    [added, alignStart, fileIndex, plan.mode, resetStream],
  );

  /**
   * Поток не открылся: сначала сами спускаемся на ступень ниже, а на последней
   * ступени просто пересоздаём поток тем же режимом (руками — кнопкой).
   */
  const onStreamError = useCallback(
    (atSec?: number) => {
      // Продолжаем с той секунды, где поток оборвался (а не сначала фильма).
      const at =
        Number.isFinite(Number(atSec)) && Number(atSec) > 0
          ? Number(atSec)
          : Math.max(0, Math.floor(positionRef.current));
      if (retryLevel < lastRetryLevel(plan)) {
        // Если поток оборвался не в начале фильма, ступень обязана быть точным seek:
        // переупаковка с копированием снова развела бы звук с картинкой.
        const next = Math.max(retryLevel + 1, exactSeekLevel(plan.mode, at));
        const nextMode = playbackMode(plan, next, audioChanged);
        setRetryLevel(next);
        setNotice(
          nextMode === "remux"
            ? t("movies.playerFallbackRemux")
            : t("movies.playerFallbackTranscode"),
        );
        // Продолжаем с той же секунды: честную секунду старта снова подтверждает бэкенд.
        void alignStart({ infoHash: added?.infoHash || "", index: fileIndex }, at).then(
          (aligned) => {
            setPendingStart(aligned.startSec);
            setPendingAligned(aligned.keyframe);
          },
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan.mode, retryLevel, t, audioChanged, added, fileIndex, alignStart],
  );
  /** Кнопка «Пересоздать поток»: новый запрос к бэкенду с текущей позиции. */
  const recreateStream = useCallback(() => {
    const target = Math.max(0, Math.floor(positionRef.current));
    const seq = ++seekSeq.current;
    // Поток пересоздаём с честной секунды (её подтверждает /torrent/seek), а не с
    // позиции на глаз: иначе после «Пересоздать поток» шкала и звук разошлись бы.
    void alignStart({ infoHash: added?.infoHash || "", index: fileIndex }, target).then((aligned) => {
      if (seq !== seekSeq.current) return;
      setPendingStart(aligned.startSec);
      setPendingAligned(aligned.keyframe);
      setRetryLevel((n) => Math.max(n, exactSeekLevel(plan.mode, aligned.startSec)));
      setRetryNonce((n) => n + 1);
      setNotice(t("movies.playerRecreated"));
    });
  }, [added, alignStart, fileIndex, plan.mode, t]);
  const badge =
    status && !status.done && !paused
      ? t("movies.dlBadge", {
          percent: Math.round(status.progress * 100),
          speed: fmtSpeed(status.downloadSpeed),
        })
      : null;
  const progress = status ? Math.round(status.progress * 100) : 0;
  const ffmpegOk = !!ffmpeg?.ffprobe;

  if (!active) return null;
return createPortal(
    <div className="app-modal-backdrop mv-modal-backdrop" onClick={() => void closeAll()}>
      <Glass className="mv-player glass-solid" onClick={(e) => e.stopPropagation()}>
        <div className="mv-player-head">
          <div className="mv-player-tabs">
            {trailerKey && (
              <button
                className={mode === "trailer" ? "is-active" : ""}
                onClick={() => setMode("trailer")}
              >
                <Film size={14} /> {t("movies.trailer")}
              </button>
            )}
            <button
              className={mode === "torrent" ? "is-active" : ""}
              onClick={() => setMode("torrent")}
            >
              <Zap size={14} /> {t("movies.torrent")}
            </button>
            {/* Поиск раздач на площадке — та же вкладка плеера, чтобы выбранную
                раздачу сразу можно было открыть в этом окне. */}
            <button
              className={mode === "search" ? "is-active" : ""}
              onClick={() => setMode("search")}
            >
              <Search size={14} /> {t("movies.trackerSearch")}
            </button>
          </div>
          <button className="mv-close" onClick={() => void closeAll()} title={t("common.close")}>
            <X size={16} />
          </button>
        </div>

        {mode === "search" && (
          <TrackerSearch
            onOpenRelease={openRelease}
            initialQuery={query}
            movieTitle={String(query || "")}
          />
        )}

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
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addTorrent();
                    }}
                  />
                  <Btn
                    variant="primary"
                    icon={Link2}
                    disabled={busy || !magnet.trim()}
                    onClick={() => void addTorrent()}
                  >
                    {t("movies.openSource")}
                  </Btn>
                </div>
              </Field>
              <label className="mv-file-btn">
                <Upload size={14} /> {t("movies.openTorrentFile")}
                <input
                  type="file"
                  accept=".torrent,application/x-bittorrent"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void openTorrentFile(f);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            </div>

            {busy && <div className="mv-torrent-busy">{t("movies.torrentConnecting")}</div>}
            {notice && !error && <div className="muted-sm mv-dl-notice">{notice}</div>}

            {/* Как играем прямо сейчас: MKV/AC3 Chromium не читает, поэтому честно
                говорим про переупаковку/перекодирование, а не молчим в тишине. */}
            {added && fileIndex >= 0 && (!streamSrc || playMode !== "direct") && (
              <div className="muted-sm mv-dl-notice">
                {plan.mode === "unsupported"
                  ? t("movies.playerNeedsFfmpeg")
                  : playMode === "transcode"
                    ? t("movies.playerTranscodeHint")
                    : t("movies.playerRemuxHint")}
              </div>
            )}

            {error && (
              <div className="mv-error-inline">
                <AlertTriangle size={15} style={{ color: "var(--coral)" }} />
                <span>{error.text}</span>
                {error.code === "engine_missing" && (
                  <span className="muted-sm">{t("movies.torrentEngineHint")}</span>
                )}
              </div>
            )}
{streamSrc && currentFile && (
              <VideoPlayer
                src={streamSrc}
                title={currentFile.name}
                baseSec={pendingStart}
                nativeSeek={nativeSeek}
                duration={tracks?.durationSec || null}
                seekableSec={seekableSec || null}
                startAt={position}
                onSeek={handleSeek}
                onSeekBlocked={onSeekBlocked}
                onError={onStreamError}
                onRetry={recreateStream}
                subtitles={subtitleProp}
                subtitleOptions={subtitleOptions}
                subtitleValue={subTrack}
                onSubtitleChange={setSubTrack}
                audioTracks={audioTracksList.map((a) => ({ index: a.index, label: a.label }))}
                audioIndex={audioIndex}
                onAudioChange={switchAudio}
                onPosition={trackPosition}
                badge={badge}
                actions={
                  <>
                    {paused ? (
                      <Btn icon={Play} disabled={busy} onClick={() => void resumeDownload()}>
                        {t("movies.dlResume")}
                      </Btn>
                    ) : (
                      <Btn icon={Pause} disabled={busy} onClick={() => void stopDownload()}>
                        {t("movies.dlStop")}
                      </Btn>
                    )}
                    <Btn
                      icon={Trash2}
                      disabled={busy}
                      onClick={() => void removeDownload()}
                      title={t("movies.dlDeleteHint")}
                    >
                      {t("movies.dlDelete")}
                    </Btn>
                  </>
                }
              />
            )}

            {/* Галочка «хранить скачанный торрент после просмотра» */}
            {added && (
              <div className="mv-keeprow">
                <Checkbox checked={keep} onClick={() => void toggleKeep(!keep)} />
                <span>{t("movies.dlKeepAfter")}</span>
                <span className="muted-sm">{t("movies.dlKeepAfterHint")}</span>
              </div>
            )}

            {/* Субтитры и аудиодорожки переехали в настройки плеера (шестерёнка):
                под плеером дублировать их не нужно. */}
{/* FFmpeg: найден — показываем путь и версию; не найден — куда положить
                бинарь и кнопку повторной проверки (кэш определения — 12 секунд). */}
            {added && (
              <div className="mv-ffmpeg-note">
                {ffmpegOk ? (
                  <span className="muted-sm is-ok">
                    <CheckCircle2 size={12} />{" "}
                    {t("movies.ffmpegReady", {
                      path: ffmpeg?.path || "",
                      version: ffmpeg?.version || "",
                    })}
                  </span>
                ) : (
                  <>
                    <span className="muted-sm">
                      <AlertTriangle size={12} />{" "}
                      {t("movies.ffmpegMissingPath", { dir: "storage/ffmpeg" })}
                    </span>
                    <Btn icon={RefreshCw} onClick={() => void checkFfmpeg(true)}>
                      {t("movies.ffmpegRecheck")}
                    </Btn>
                  </>
                )}
                {!tracks && tracksError && (
                  <span className="muted-sm">
                    {tracksError.code === "ffmpeg_missing"
                      ? t("movies.tracksFfmpeg")
                      : t("movies.tracksProbeFailed", {
                          message: tracksError.message.slice(0, 160),
                        })}
                  </span>
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
                    onClick={() => switchFile(f.index)}
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
                  <div className="mv-status-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="mv-status-meta">
                  <span>
                    <Download size={12} /> {progress}%
                  </span>
                  <span>
                    <Zap size={12} /> {fmtSpeed(status.downloadSpeed)}
                  </span>
                  <span>
                    <Users size={12} /> {status.peers}
                  </span>
                  <span>
                    <HardDrive size={12} /> {fmtBytes(status.downloaded)} /{" "}
                    {fmtBytes(status.length)}
                  </span>
                  {status.done && (
                    <span className="is-ok">
                      <CheckCircle2 size={12} /> {t("movies.dlDone")}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Glass>
    </div>,
    getOverlayRoot() ?? document.body,
  );
}