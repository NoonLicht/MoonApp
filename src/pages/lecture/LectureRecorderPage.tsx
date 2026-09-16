import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  Square,
  Download,
  Sparkles,
  Trash2,
  ChevronDown,
  Cpu,
  Radio,
  Save,
  Play,
  Pause,
  Settings2,
  Volume2,
  SearchCheck,
  AlertTriangle,
  Users,
} from "lucide-react";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
import type {
  LectureChunk,
  LectureCreateResult,
  LectureEngineStatus,
  LectureSession,
  LectureStatus,
  LectureAudioSettings,
  LectureConspectusState,
  LectureConspectusSettings,
  LectureDiarizeState,
} from "@/api/client";
import { useI18n } from "@/app/i18n";
import type { TranslateFn } from "@/app/i18n";
import { usePageBusy } from "@/components/Toolbar";
import LectureEnginePanel from "@/pages/lecture/parts/LectureEnginePanel";
import LectureAudioPanel, { LevelMeter } from "@/pages/lecture/parts/LectureAudioPanel";
import LectureConspectusPanel from "@/pages/lecture/parts/LectureConspectusPanel";
import LectureDiarizePanel from "@/pages/lecture/parts/LectureDiarizePanel";

/**
 * Lecture Recorder — реалтайм-запись лекции и академический speech-to-text.
 *
 * Поток (fail-safe архитектура):
 *   getUserMedia → AudioContext → ScriptProcessorNode
 *     ├─ даунсэмпл →16k + Int16 → POST /api/lecture/:id/ingest (~каждые 500 мс)
 *     │     └─ на сервере: непрерывный raw.wav + VAD-чанки → whisper.cpp
 *     └─ локальный waveform-визуализатор (canvas)
 *
 * Транскрипт приходит поллингом GET /api/lecture/:id — чанки с таймкодами,
 * click-to-edit. Ctrl+B / F2 — маркер «важного». AI-конспект — через провайдера
 * чата (DeepSeek и др.), чанками по блокам расшифровки.
 */

const TARGET_RATE = 16000;
const SEND_INTERVAL_MS = 500;

function fmtTs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return [h, m, sec].map((x) => String(x).padStart(2, "0")).join(":");
}

/**
 * Человеческая подпись пустой/пропущенной строки транскрипта.
 *
 * Раньше на всё было одно «тишина/шум — отброшено VAD», и понять, что случилось
 * (шум на входе? тихий микрофон? Whisper не разобрал?), было невозможно.
 * Теперь показываем РЕАЛЬНУЮ причину и измеренный уровень в dBFS.
 */
/**
 * Метка говорящего по диаризации: «№2» — второй голос на этой дорожке.
 * «?» — в чанке звучали двое (доля доминирующего голоса < 55%): честнее
 * показать сомнение, чем приписать реплику не тому человеку.
 */
function speakerBadge(c: LectureChunk): string {
  const sp = String(c.speaker || "");
  if (!sp) return "";
  const n = Number(sp.split("_")[1]);
  if (!Number.isFinite(n)) return "";
  return `№${n + 1}${Number(c.speakerRatio ?? 1) < 0.55 ? "?" : ""}`;
}

function chunkNote(t: TranslateFn, c: LectureChunk): string {
  const db = typeof c.rms_db === "number" ? t("lecture.diag.db", { db: c.rms_db }) : "";
  const peak =
    typeof c.rms_peak_db === "number" ? t("lecture.diag.peak", { db: c.rms_peak_db }) : "";
  switch (c.reason) {
    case "noise":
      return t("lecture.diag.noise", { db: peak || db });
    case "hum":
      return t("lecture.diag.hum", { db: peak || db });
    case "noise_burst":
      return t("lecture.diag.noiseBurst", { db: peak || db });
    case "low_speech_ratio":
      return t("lecture.diag.lowSpeech", { db: peak || db });
    case "whisper_empty":
      return t("lecture.diag.whisperEmpty", { db: peak || db });
    default:
      break;
  }
  if (c.status === "vad_skip") return t("lecture.diag.vadSkip", { db: peak || db });
  if (c.status === "empty") return t("lecture.diag.whisperEmpty", { db: peak || db });
  return c.error || t("lecture.chunkEmpty");
}

/**
 * Ошибки бэкенда — это коды (session_not_found, whisper_not_installed, …), а
 * браузера — DOMException'ы. Показываем пользователю понятный текст, а не код.
 */
function lectureError(t: TranslateFn, e: unknown): string {
  const msg = String((e as Error)?.message || e || "");
  if (/no_system_audio/.test(msg)) return t("lecture.errSystemAudio");
  if (/NotAllowedError|PermissionDenied|permission denied|NotAllowed/i.test(msg))
    return t("lecture.errMic");
  if (/NotFoundError|Requested device|no_mic/i.test(msg)) return t("lecture.errNoMic");
  if (/session_not_found/.test(msg)) return t("lecture.errSession");
  if (/whisper_not_installed|whisper_model_missing/.test(msg)) return t("lecture.errWhisper");
  if (/no_transcript_yet/.test(msg)) return t("lecture.errNoTranscript");
  // Конспект идёт через провайдера чата: нет ключа/провайдера или модель не
  // найдена — это разные подсказки пользователю (сохранить ключ vs выбрать модель).
  if (/conspectus_not_configured/.test(msg))
    return t("lecture.errConspectusKey", { provider: msg.split(": ")[1] || "" });
  if (/conspectus_provider_unknown/.test(msg))
    return t("lecture.errConspectusProvider", { provider: msg.split(": ")[1] || "" });
  if (/conspectus_model_missing/.test(msg)) return t("lecture.errConspectusModel");
  if (/conspectus_busy/.test(msg)) return t("lecture.errConspectusBusy");
  if (/conspectus_empty_response/.test(msg)) return t("lecture.errConspectusEmpty");
  if (/HTTP \d+/.test(msg)) return t("lecture.errServer", { code: msg.replace(/^HTTP\s+/, "") });
  return msg || t("lecture.errGeneric");
}

/** Текст прогресса сборки конспекта: заметки по блокам → сведение в конспект. */
function conspectusProgressText(t: TranslateFn, st: LectureConspectusState): string {
  if (st.phase === "merge") return t("lecture.conspectusMerge");
  return t("lecture.conspectusNotes", { done: st.progress, total: st.total });
}

/** Даунсэмпл Float32 → Int16 16 кГц (линейная интерполяция). */
function downsampleToInt16(input: Float32Array, inputRate: number, outputRate: number): Int16Array {
  const ratio = inputRate / outputRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const s0 = input[i0] ?? 0;
    const s1 = input[i0 + 1] ?? s0;
    const v = (s0 + (s1 - s0) * frac) * 32767;
    out[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : Math.round(v);
  }
  return out;
}

/** Устройство ввода по умолчанию: явный выбор → дефолт системы. */
async function acquireMic(deviceId: string, agc: boolean): Promise<MediaStream> {
  const base: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    // AGC браузера по умолчанию ВЫКЛ: он «качает» уровень, из-за чего VAD
    // видит то тишину, то всплеск — а для лекции нужен ровный сигнал.
    autoGainControl: agc === true,
  };
  if (deviceId) base.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: base });
  } catch (e) {
    // Устройство могло отключиться между выбором и стартом — падать нельзя,
    // иначе лекция не начнётся вообще. Возвращаемся к системному дефолту.
    if (
      deviceId &&
      /NotFoundError|OverconstrainedError|NotReadableError/i.test(String((e as Error)?.message))
    ) {
      delete base.deviceId;
      return navigator.mediaDevices.getUserMedia({ audio: base });
    }
    throw e;
  }
}

/**
 * Системный звук онлайн-лекции: WASAPI-loopback через Electron.
 *
 * РАНЬШЕ: getDisplayMedia({video:true, audio:true}) — без
 * setDisplayMediaRequestHandler Electron отдавал видео (скрин/окно), а аудио
 * приходило от выбранного источника или отсутствовало: в запись уходил шум и
 * «звук с камер», а не звук системы. Теперь main-процесс по IPC ставит
 * обработчик с audio: "loopback" и отдаёт НАСТОЯЩИЙ звук устройства вывода.
 */
async function acquireSystemAudio(): Promise<MediaStream> {
  const bridge = window.appBridge;
  await bridge?.setCaptureMode?.("loopback");
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    const audioTracks = display.getAudioTracks();
    if (!audioTracks.length) {
      display.getTracks().forEach((tr) => tr.stop());
      throw new Error("no_system_audio");
    }
    // Видео нужно было только как «носитель» аудио — сразу отпускаем.
    display.getVideoTracks().forEach((tr) => tr.stop());
    return new MediaStream(audioTracks);
  } finally {
    // Обработчик живёт только на время захвата, иначе он подменил бы обычный
    // выбор экрана всем остальным страницам приложения.
    await bridge?.setCaptureMode?.("default");
  }
}

export default function LectureRecorderPage() {
  const { t } = useI18n();

  const [engine, setEngine] = useState<LectureEngineStatus | null>(null);
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [session, setSession] = useState<LectureCreateResult | null>(null);
  const [status, setStatus] = useState<LectureStatus | null>(null);
  const [title, setTitle] = useState("");
  const [systemAudio, setSystemAudio] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ chunkId: number; text: string } | null>(null);
  const [notes, setNotes] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const [conspectusBusy, setConspectusBusy] = useState(false);
  // Прогресс конспекта: «Заметки 3/12» / «Сводим в конспект…». Без него на
  // длинной лекции непонятно, идёт работа или всё зависло.
  const [conspectusNote, setConspectusNote] = useState("");
  const [showSessions, setShowSessions] = useState(false);
  const [playingChunk, setPlayingChunk] = useState(0); // id звучащего чанка (0 — тишина)
  const [busy, setBusy] = useState(""); // "export:md" | "audio" — блокировка кнопок
  const [showEngine, setShowEngine] = useState(false); // панель «Модель и ускорение»
  const [showAudio, setShowAudio] = useState(false); // панель «Аудио» (микрофон, гейн, VAD)
  const [showConspectus, setShowConspectus] = useState(false); // панель «ИИ-конспект»
  const [showDiarize, setShowDiarize] = useState(false); // панель «Говорящие»
  // Настройки конспекта (провайдер, модель, режим запуска): нужны в шапке, чтобы
  // показать, что авто-конспект включён, а не «просто кнопка».
  const [conspectusCfg, setConspectusCfg] = useState<LectureConspectusSettings | null>(null);
  // Состояние сборки конспекта — источник для бейджа «устарел» и прогресса
  // авто-сборки, которая идёт БЕЗ нажатия кнопки (после остановки записи).
  const [conspectusSt, setConspectusSt] = useState<LectureConspectusState | null>(null);
  // Прогресс фоновой диаризации: авто-режим может идти при ЗАКРЫТОЙ панели
  // «Говорящие», и пользователь должен видеть, что работа идёт (минуты CPU).
  const [diarizeSt, setDiarizeSt] = useState<LectureDiarizeState | null>(null);
  // Заметки: авто-конспект дописывает их на сервере, поэтому держим «серверную»
  // версию отдельно. Иначе нажатие «Сохранить заметки» затирало бы конспект.
  const [notesStale, setNotesStale] = useState(false);
  const [audio, setAudio] = useState<LectureAudioSettings | null>(null);
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [levelDb, setLevelDb] = useState(-100); // текущий уровень входа, dBFS
  const [calibrating, setCalibrating] = useState(false);
  const [recheckBusy, setRecheckBusy] = useState(false);

  // Заметки: «серверная» версия и признак ручной правки (см. applyServerNotes).
  const serverNotesRef = useRef("");
  const notesDirtyRef = useRef(false);

  // Запись лекции и разбор в конспект — задачи: страницу нельзя выгружать (keep-alive).
  usePageBusy(recording || conspectusBusy || calibrating || recheckBusy);

  const audioRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    processor: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
    gain: GainNode;
    track: "mic" | "sys";
  } | null>(null);
  const resampleBuf = useRef<Float32Array[]>([]);
  const resampleLen = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const autoscroll = useRef(true);
  // Уровень сигнала держим в ref: audioprocess вызывается ~85 мс, и через
  // setState это давало 12 ре-рендеров страницы в секунду + перезапуск
  // requestAnimationFrame-цикла визуализатора на каждом из них.
  const levelRef = useRef(0);
  const ingestFailRef = useRef(0); // подряд неудачных отправок PCM
  const chunkAudioRef = useRef<HTMLAudioElement | null>(null);
  const chunkUrlRef = useRef(""); // object URL звучащего чанка

  /* ---- Инициализация: движок + список сессий ---- */
  const refreshMeta = useCallback(() => {
    api
      .lectureEngine()
      .then(setEngine)
      .catch(() => setEngine(null));
    api
      .lectureSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  /* ---- Аудиовход: настройки, список микрофонов, уровень входа ---- */

  const loadAudio = useCallback(() => {
    api
      .lectureAudio()
      .then(setAudio)
      .catch(() => setAudio(null));
  }, []);
  useEffect(() => {
    loadAudio();
  }, [loadAudio]);

  /**
   * Список микрофонов. ЯРЛЫКИ устройств Chromium отдаёт только после выдачи
   * разрешения, поэтому при пустых label делаем короткий «пробный» запрос —
   * без него пользователь видел бы «Микрофон 1/2/3» и не мог выбрать нужный.
   */
  const loadDevices = useCallback(async () => {
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      let inputs = list.filter((d) => d.kind === "audioinput");
      if (inputs.length && inputs.every((d) => !d.label)) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
          probe.getTracks().forEach((tr) => tr.stop());
          list = await navigator.mediaDevices.enumerateDevices();
          inputs = list.filter((d) => d.kind === "audioinput");
        } catch {
          /* без разрешения оставим системные подписи */
        }
      }
      setDevices(
        inputs.map((d, i) => ({
          id: d.deviceId,
          label: d.label || t("lecture.audio.micFallback", { n: i + 1 }),
        })),
      );
    } catch {
      setDevices([]);
    }
  }, [t]);

  useEffect(() => {
    void loadDevices();
    const md = navigator.mediaDevices;
    const onChange = () => {
      void loadDevices();
    };
    md?.addEventListener?.("devicechange", onChange);
    return () => md?.removeEventListener?.("devicechange", onChange);
  }, [loadDevices]);

  // Индикатор уровня: levelRef обновляется в audioprocess, а в состояние
  // переводим реже (5 раз в секунду) — иначе 12 ре-рендеров в секунду.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const rms = levelRef.current;
      setLevelDb(rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -100);
    }, 200);
    return () => clearInterval(id);
  }, [recording]);

  /**
   * Подтянуть заметки с сервера (авто-конспект, маркер «важного»).
   *
   * Почему отдельной функцией: конспект дописывается в заметки НА СЕРВЕРЕ, а в
   * textarea лежит локальная копия. Если серверная версия изменилась, а
   * пользователь поле не правил — обновляем textarea. Если правил — его ввод не
   * трогаем, но помечаем конфликт (notesStale), чтобы конспект не потерялся.
   */
  const applyServerNotes = useCallback((raw?: string) => {
    const text = String(raw || "");
    if (serverNotesRef.current === text) return;
    serverNotesRef.current = text;
    if (notesDirtyRef.current) {
      setNotesStale(true);
      return;
    }
    setNotes(text);
    setNotesStale(false);
  }, []);

  const refreshStatus = useCallback(
    (id: number) => {
      api
        .lectureStatus(id)
        .then((st) => {
          setStatus(st);
          // Авто-конспект (или маркер) мог дописать заметки на сервере. Подтягиваем
          // их, пока пользователь сам не начал править поле — иначе «Сохранить
          // заметки» затирало бы только что собранный конспект.
          applyServerNotes(st?.lecture?.notes);
        })
        .catch(() => {
          /* сессия могла быть удалена */
        });
    },
    [applyServerNotes],
  );

  /** Обновить данные открытой лекции (панели движка/аудио/говорящих → onChanged). */
  const refreshStatusAll = useCallback(() => {
    if (session) refreshStatus(session.id);
  }, [session, refreshStatus]);

  /* ---- Поллинг статуса активной сессии ---- */
  useEffect(() => {
    if (!session) return;
    const id = session.id;
    refreshStatus(id);
    const timer = setInterval(() => refreshStatus(id), 1800);
    return () => clearInterval(timer);
  }, [session, refreshStatus]);

  /* ---- Настройки ИИ-конспекта: провайдер, модель, режим запуска ---- */
  const refreshConspectusCfg = useCallback(() => {
    void api
      .lectureConspectusSettings()
      .then(setConspectusCfg)
      .catch(() => {
        /* панель покажет «нет данных» */
      });
  }, []);
  useEffect(() => {
    refreshConspectusCfg();
  }, [refreshConspectusCfg]);

  /* ---- Состояние конспекта: прогресс АВТО-сборки после остановки записи ----
   * Авто-конспект (smart/auto) запускается сервером без кнопки, поэтому UI обязан
   * сам замечать, что сборка идёт — иначе «конспекта нет» и «конспект собирается»
   * выглядели бы одинаково, и пользователь жал кнопку повторно. */
  useEffect(() => {
    if (!session) return;
    const id = session.id;
    let alive = true;
    const tick = () => {
      void api
        .lectureConspectusState(id)
        .then((st) => {
          if (!alive) return;
          setConspectusSt(st);
          if (st.state === "working") setConspectusNote(conspectusProgressText(t, st));
          else setConspectusNote((prev) => (prev ? "" : prev));
        })
        .catch(() => {
          /* состояние — необязательная роскошь */
        });
    };
    tick();
    // Пока сборка идёт — опрашиваем часто, иначе редко (бейдж «устарел»).
    const timer = setInterval(tick, conspectusSt?.state === "working" ? 1200 : 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session, conspectusSt?.state, t]);

  /* ---- Состояние диаризации: прогресс фонового разбора говорящих ---- */
  useEffect(() => {
    if (!session) {
      setDiarizeSt(null);
      return;
    }
    const id = session.id;
    let alive = true;
    const tick = () => {
      void api
        .lectureDiarizeState(id)
        .then((s) => {
          if (alive) setDiarizeSt(s);
        })
        .catch(() => {
          /* состояние — необязательная роскошь */
        });
    };
    tick();
    // Пока разбор идёт — опрашиваем часто (минуты CPU), иначе редко.
    const timer = setInterval(tick, diarizeSt?.state === "working" ? 1500 : 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session, diarizeSt?.state]);

  /* ---- Автоскролл телепромтера ---- */
  useEffect(() => {
    if (autoscroll.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [status?.chunks.length]);

  /* ---- Запись ---- */

  /** Освободить микрофон/граф (без обращений к серверу). */
  const releaseAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try {
        a.processor.disconnect();
        a.source.disconnect();
        a.gain.disconnect();
      } catch {
        /* ignore */
      }
      a.stream.getTracks().forEach((tr) => tr.stop());
      void a.ctx.close().catch(() => {
        /* ignore */
      });
      audioRef.current = null;
    }
    levelRef.current = 0;
    setLevelDb(-100);
    setRecording(false);
  }, []);

  const stopRecording = useCallback(async () => {
    releaseAudio();
    if (!session) return;
    try {
      const st = await api.lectureStop(session.id);
      setStatus(st);
      refreshMeta();
    } catch (e) {
      setError(lectureError(t, e));
    }
  }, [releaseAudio, refreshMeta, session, t]);

  const startRecording = useCallback(async () => {
    setError("");
    let created: LectureCreateResult | null = null;
    let streamLocal: MediaStream | null = null;
    try {
      // Порядок важен: сначала получаем аудио и только потом создаём сессию.
      // Иначе отмена диалога «поделиться звуком» или отказ в доступе к
      // микрофону оставляли на сервере вечную запись в статусе recording.
      streamLocal = systemAudio
        ? await acquireSystemAudio()
        : await acquireMic(String(audio?.micDeviceId || ""), audio?.micAgc === true);
      created = await api.lectureCreate(title || t("lecture.defaultTitle"));
      const sessionId = created.id;

      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(streamLocal);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      // Гейн входа: тихий микрофон — главная причина «тишина/шум» в чанках.
      // Гейн применяем в графе ДО ScriptProcessor, чтобы на сервер уходил уже
      // усиленный сигнал (иначе VAD честно видит тишину).
      const gain = ctx.createGain();
      gain.gain.value = systemAudio ? 1 : Number(audio?.micGain ?? 1);
      // Дорожка: sys — системный звук (эфир лектора), mic — микрофон/аудитория.
      const track: "mic" | "sys" = systemAudio ? "sys" : "mic";
      resampleBuf.current = [];
      resampleLen.current = 0;
      ingestFailRef.current = 0;

      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        levelRef.current = Math.sqrt(sum / input.length);
        // Копируем кадр: массив getChannelData живёт только внутри обработчика
        // (Chromium переиспользует буфер), а мы копим ~500 мс до отправки.
        resampleBuf.current.push(input.slice());
        resampleLen.current += input.length;
        // Накопили ~500 мс → отправляем на сервер (fail-safe raw + VAD).
        const targetSamples = ctx.sampleRate * (SEND_INTERVAL_MS / 1000);
        if (resampleLen.current >= targetSamples) {
          const merged = new Float32Array(resampleLen.current);
          let off = 0;
          for (const b of resampleBuf.current) {
            merged.set(b, off);
            off += b.length;
          }
          resampleBuf.current = [];
          resampleLen.current = 0;
          const pcm = downsampleToInt16(merged, ctx.sampleRate, TARGET_RATE);
          api
            .lectureIngest(sessionId, pcm.buffer as ArrayBuffer, track)
            .then(() => {
              ingestFailRef.current = 0;
            })
            .catch(() => {
              // Связь с сервером потеряна: fail-safe WAV и VAD не пополняются.
              // После трёх неудач подряд останавливаем запись, чтобы не
              // создавать видимость работающего процесса.
              ingestFailRef.current++;
              if (ingestFailRef.current >= 3) {
                // Стоп по ЯВНОМУ id: stopRecording() из этого замыкания видит
                // session === null (состояние обновится лишь в следующем
                // рендере) и не дёрнул бы сервер — сессия осталась бы в
                // статусе recording.
                setError(t("lecture.errIngest"));
                releaseAudio();
                api
                  .lectureStop(sessionId)
                  .then((s) => {
                    setStatus(s);
                    refreshMeta();
                  })
                  .catch(() => {
                    /* сервер недоступен — сессию добьёт recoverInterrupted */
                  });
              }
            });
        }
      };
      const mute = ctx.createGain();
      mute.gain.value = 0; // ScriptProcessor требует подключение к графу — глушим
      src.connect(gain);
      gain.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);

      audioRef.current = { ctx, stream: streamLocal, processor, source: src, gain, track };
      setSession(created);
      setStatus(null);
      setNotes("");
      // Новая запись: заметок нет ни локально, ни на сервере — сбрасываем
      // «серверную» версию и признак ручных правок от прошлой лекции.
      serverNotesRef.current = "";
      notesDirtyRef.current = false;
      setNotesStale(false);
      setConspectusSt(null);
      setEditing(null);
      setRecording(true);
    } catch (e) {
      setError(lectureError(t, e));
      try {
        streamLocal?.getTracks().forEach((tr) => tr.stop());
      } catch {
        /* ignore */
      }
      // Сессия могла успеть создаться — финализируем её, иначе она навсегда
      // останется в архиве как «записывается».
      if (created) {
        try {
          await api.lectureStop(created.id);
          refreshMeta();
        } catch {
          /* ignore */
        }
      }
    }
  }, [refreshMeta, releaseAudio, systemAudio, t, title]);

  // Страховка на размонтирование (keep-alive выгрузка/перезапуск): не держим
  // микрофон и звук фрагмента.
  useEffect(
    () => () => {
      const a = audioRef.current;
      if (a) {
        try {
          a.processor.disconnect();
          a.source.disconnect();
        } catch {
          /* ignore */
        }
        a.stream.getTracks().forEach((tr) => tr.stop());
        void a.ctx.close().catch(() => {
          /* ignore */
        });
        audioRef.current = null;
      }
      chunkAudioRef.current?.pause();
      if (chunkUrlRef.current) URL.revokeObjectURL(chunkUrlRef.current);
    },
    [],
  );
  /* ---- Waveform-визуализатор ---- */
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    // Цвета берём из темы (акцент + приглушённый), а не жёстко: страница
    // следует выбранному акценту и корректно выглядит в светлой/OLED-теме.
    const canvas0 = canvasRef.current;
    const css = canvas0 ? getComputedStyle(canvas0) : null;
    const accent = css?.getPropertyValue("--amber").trim() || "#f59e0b";
    const idle = css?.getPropertyValue("--text-tertiary").trim() || "#555";
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx2d = canvas?.getContext("2d");
      if (canvas && ctx2d) {
        const w = canvas.width,
          h = canvas.height;
        ctx2d.clearRect(0, 0, w, h);
        const bars = 48;
        const amp = Math.min(1, levelRef.current * 6);
        for (let i = 0; i < bars; i++) {
          const bh = Math.max(
            2,
            amp * h * (0.4 + 0.6 * Math.abs(Math.sin(i * 1.7 + Date.now() / 400))),
          );
          ctx2d.fillStyle = amp > 0.03 ? accent : idle;
          ctx2d.fillRect((i * w) / bars + 2, h - bh, w / bars - 4, bh);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  /* ---- Действия ---- */

  /**
   * Сохранить настройки аудиовхода. Значения применяются к СЛЕДУЮЩЕЙ записи:
   * VAD-опции читаются в момент создания сессии (server/lecture.js).
   */
  const saveAudio = useCallback(
    async (patch: Parameters<typeof api.lectureAudioSet>[0]) => {
      try {
        setAudio(await api.lectureAudioSet(patch));
      } catch (e) {
        setError(lectureError(t, e));
      }
    },
    [t],
  );

  /**
   * Калибровка по тишине: 3 секунды меряем ФОН и ставим порог = фон × 3.
   * Это главный ручной инструмент против «шум выше порога → мусорные чанки»:
   * вместо угадывания порога берётся реальный шумовой пол этой комнаты/микрофона.
   */
  const calibrate = useCallback(async () => {
    setCalibrating(true);
    setError("");
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      stream = await acquireMic(String(audio?.micDeviceId || ""), audio?.micAgc === true);
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      const samples: number[] = [];
      proc.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        samples.push(Math.sqrt(sum / input.length));
      };
      await new Promise((r) => setTimeout(r, 3000));
      proc.onaudioprocess = null;
      try {
        proc.disconnect();
        src.disconnect();
        mute.disconnect();
      } catch {
        /* ignore */
      }
      await ctx.close().catch(() => {
        /* ignore */
      });
      ctx = null;
      const sorted = samples.slice().sort((a, b) => a - b);
      const noise = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
      // Порог = фон × 3 (≈ +10 дБ), но не ниже абсолютного минимума движка.
      const threshold = Math.min(0.2, Math.max(0.0005, noise * 3));
      await saveAudio({ vad: { rmsThreshold: threshold } });
    } catch (e) {
      setError(lectureError(t, e));
    } finally {
      try {
        stream?.getTracks().forEach((tr) => tr.stop());
      } catch {
        /* ignore */
      }
      try {
        if (ctx) await ctx.close();
      } catch {
        /* ignore */
      }
      setCalibrating(false);
    }
  }, [audio, saveAudio, t]);

  /** «Проверить пропуски»: до-расшифровка участков, потерянных VAD/Whisper. */
  const runRecheck = useCallback(async () => {
    if (!session) return;
    setRecheckBusy(true);
    setError("");
    try {
      await api.lectureRecheck(session.id);
      refreshStatus(session.id);
    } catch (e) {
      setError(lectureError(t, e));
    } finally {
      setRecheckBusy(false);
    }
  }, [refreshStatus, session, t]);
  const saveEdit = useCallback(async () => {
    if (!editing) return;
    try {
      await api.lectureEditChunk(editing.chunkId, editing.text);
      setEditing(null);
      if (session) refreshStatus(session.id);
    } catch (e) {
      setError(lectureError(t, e));
    }
  }, [editing, refreshStatus, session, t]);

  /** Сохранить заметки лекции (раньше кнопка добавляла маркер вместо сохранения). */
  const saveNotes = useCallback(async () => {
    if (!session) return;
    setError("");
    try {
      const saved = await api.lectureSetNotes(session.id, notes);
      setNotes(saved.notes || "");
      // Пользователь сохранил свою версию — она теперь и есть «серверная»,
      // конфликт с авто-конспектом снят.
      serverNotesRef.current = saved.notes || "";
      notesDirtyRef.current = false;
      setNotesStale(false);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 1500);
      refreshStatus(session.id);
    } catch (e) {
      setError(lectureError(t, e));
    }
  }, [notes, refreshStatus, session, t]);

  /** Прослушать фрагмент: WAV чанка тянем blob'ом (нужен токен) и играем. */
  const playChunk = useCallback(
    async (c: LectureChunk) => {
      const audio = chunkAudioRef.current;
      if (playingChunk === c.id && audio) {
        audio.pause();
        setPlayingChunk(0);
        return;
      }
      setError("");
      try {
        const blob = await api.lectureChunkAudio(c.id);
        if (chunkUrlRef.current) URL.revokeObjectURL(chunkUrlRef.current);
        const url = URL.createObjectURL(blob);
        chunkUrlRef.current = url;
        if (!audio) {
          chunkAudioRef.current = new Audio();
        }
        const el = chunkAudioRef.current as HTMLAudioElement;
        el.src = url;
        el.onended = () => setPlayingChunk(0);
        await el.play();
        setPlayingChunk(c.id);
      } catch (e) {
        setPlayingChunk(0);
        setError(lectureError(t, e));
      }
    },
    [playingChunk, t],
  );

  /** Экспорт расшифровки (md/srt/vtt) — через fetch с токеном, см. saveBlob. */
  const downloadExport = useCallback(
    async (format: "md" | "srt" | "vtt") => {
      if (!session) return;
      setBusy(`export:${format}`);
      setError("");
      try {
        const { blob, name } = await api.lectureDownloadExport(session.id, format, {
          // Двухдорожечная разметка: эфир (sys) — лектор, микрофон — аудитория.
          // Подписи переводим на клиенте: сервер не знает языка интерфейса.
          mic: t("lecture.audio.speaker.audience"),
          sys: t("lecture.audio.speaker.lecturer"),
        });
        saveBlob(blob, name);
      } catch (e) {
        setError(lectureError(t, e));
      } finally {
        setBusy("");
      }
    },
    [session, t],
  );

  /** Скачать fail-safe WAV всей лекции. */
  const downloadAudio = useCallback(async () => {
    if (!session) return;
    setBusy("audio");
    setError("");
    try {
      const { blob, name } = await api.lectureDownloadAudio(session.id);
      saveBlob(blob, name);
    } catch (e) {
      setError(lectureError(t, e));
    } finally {
      setBusy("");
    }
  }, [session, t]);

  const runConspectus = useCallback(async () => {
    if (!session) return;
    setConspectusBusy(true);
    setError("");
    setConspectusNote("");
    // Конспект длинной лекции — это десятки запросов к модели, поэтому рядом с
    // шипящим спиннером показываем РЕАЛЬНЫЙ прогресс (блоки 3/12, сведение).
    const id = session.id;
    const timer = setInterval(() => {
      void api
        .lectureConspectusState(id)
        .then((st) => {
          if (st.state === "working") setConspectusNote(conspectusProgressText(t, st));
          else setConspectusNote("");
        })
        .catch(() => {
          /* прогресс — необязательная роскошь */
        });
    }, 1000);
    try {
      const r = await api.lectureConspectus(id);
      setNotes(r.markdown);
      // Конспект сервер уже дописал в заметки, локальная копия его содержит —
      // поэтому «Сохранить заметки» не затрёт результат, конфликт снят.
      notesDirtyRef.current = false;
      setNotesStale(false);
      void api
        .lectureConspectusState(id)
        .then(setConspectusSt)
        .catch(() => {
          /* необязательно */
        });
      if (r.truncated)
        setConspectusNote(t("lecture.conspectusTruncated", { blocks: r.blocks, of: r.ofTotal }));
      refreshStatus(id);
    } catch (e) {
      setError(lectureError(t, e));
    } finally {
      clearInterval(timer);
      setConspectusNote("");
      setConspectusBusy(false);
    }
  }, [refreshStatus, session, t]);

  /** Открыть прошлую сессию (просмотр/доделка экспорта). */
  const openSession = useCallback(async (id: number) => {
    setSession(null);
    const st = await api.lectureStatus(id).catch(() => null);
    if (!st) return;
    setSession({
      id,
      sampleRate: st.lecture.sample_rate,
      channels: st.lecture.channels,
      vad: null as never,
      whisper: st.whisper,
    });
    setStatus(st);
    setNotes(st.lecture.notes || "");
    // Открыли другую лекцию — «серверная» версия заметок теперь её, ручных
    // правок нет, конспект этой лекции читаем отдельно (режим/устарел).
    serverNotesRef.current = st.lecture.notes || "";
    notesDirtyRef.current = false;
    setNotesStale(false);
    void api
      .lectureConspectusState(id)
      .then(setConspectusSt)
      .catch(() => setConspectusSt(null));
    setEditing(null);
    setShowSessions(false);
  }, []);

  const deleteSession = useCallback(
    async (id: number) => {
      // Если звучал фрагмент удаляемой лекции — глушим плеер.
      if (playingChunk) {
        chunkAudioRef.current?.pause();
        setPlayingChunk(0);
      }
      try {
        await api.lectureDelete(id);
      } catch (e) {
        setError(lectureError(t, e));
        return;
      }
      if (session?.id === id) {
        setSession(null);
        setStatus(null);
        setNotes("");
        serverNotesRef.current = "";
        notesDirtyRef.current = false;
        setNotesStale(false);
        setConspectusSt(null);
      }
      refreshMeta();
    },
    [playingChunk, refreshMeta, session, t],
  );

  /* ---- Рендер ---- */
  const chunks: LectureChunk[] = status?.chunks ?? [];

  return (
    <div className="page lec-page">
      {/* Шапка: статус движка + контролы */}
      <div className="lec-header">
        <div className="lec-engine">
          <Cpu size={16} />
          <span className={engine?.ready ? "lec-ok" : "lec-warn"}>
            {engine?.ready
              ? t("lecture.engineReady", { backend: engine.backend || "cpu" })
              : t("lecture.engineMissing")}
          </span>
          <span className="lec-sep">·</span>
          <span className="lec-dim">{engine?.model ? engine.model.split(/[\\/]/).pop() : "—"}</span>
        </div>
        <div className="lec-actions">
          {recording && (
            <LevelMeter db={levelDb} thresholdDb={audio?.vad.thresholdDb ?? -42} t={t} />
          )}
          {/* Кнопки-иконки, без подписей: ряд больше не распирает шапку, поэтому
              последняя кнопка не уезжает за край узкого окна. Смысл кнопки —
              в title (подсказка) и aria-label (скринридер). */}
          <button
            className={`lec-btn ghost icon${showSessions ? " on" : ""}`}
            onClick={() => setShowSessions((v) => !v)}
            title={t("lecture.archive")}
            aria-label={t("lecture.archive")}
            aria-expanded={showSessions}
          >
            <ChevronDown size={16} />
          </button>
          <button
            className="lec-btn ghost icon"
            onClick={() => setShowAudio(true)}
            title={t("lecture.audio.btnHint")}
            aria-label={t("lecture.audio.btn")}
          >
            <Volume2 size={16} />
          </button>
          <button
            className="lec-btn ghost icon"
            onClick={() => setShowConspectus(true)}
            title={t("lecture.conspectusPanel.btnHint")}
            aria-label={t("lecture.conspectusPanel.btn")}
          >
            <Sparkles size={16} />
          </button>
          <button
            className="lec-btn ghost icon"
            onClick={() => setShowDiarize(true)}
            title={t("lecture.diarizePanel.btnHint")}
            aria-label={t("lecture.diarizePanel.btn")}
          >
            <Users size={16} />
          </button>
          {/* Фоновый разбор говорящих: показываем только ход расчёта, иначе
              «ничего не происходит» и «идёт расчёт» выглядят одинаково.
              Сколько говорящих нашлось, рядом с кнопкой не пишем — это видно
              в самой панели «Говорящие». */}
          {diarizeSt?.state === "working" && (
            <span className="lecs-dim lecs-hint">
              {t("lecture.diarizePanel.running")} {diarizeSt.progress}%
            </span>
          )}
          <button
            className="lec-btn ghost icon"
            onClick={() => setShowEngine(true)}
            title={t("lecture.setupBtnHint")}
            aria-label={t("lecture.setupBtn")}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </div>

      {showEngine && (
        <LectureEnginePanel onClose={() => setShowEngine(false)} onChanged={refreshMeta} />
      )}

      {showAudio && (
        <LectureAudioPanel
          onClose={() => setShowAudio(false)}
          settings={audio}
          devices={devices}
          levelDb={levelDb}
          metrics={status?.vad?.mic || null}
          recording={recording}
          calibrating={calibrating}
          onSave={saveAudio}
          onCalibrate={calibrate}
          onRefreshDevices={loadDevices}
        />
      )}

      {showConspectus && (
        <LectureConspectusPanel
          onClose={() => setShowConspectus(false)}
          onChanged={refreshConspectusCfg}
        />
      )}

      {showDiarize && (
        <LectureDiarizePanel
          onClose={() => setShowDiarize(false)}
          sessionId={session?.id || 0}
          onChanged={refreshStatusAll}
        />
      )}

      {showSessions && (
        <div className="lec-sessions">
          {sessions.length === 0 && <div className="lec-dim">{t("lecture.noSessions")}</div>}
          {sessions.map((s) => (
            <div key={s.id} className="lec-session-row">
              <button className="lec-session-open" onClick={() => void openSession(s.id)}>
                <span className="lec-session-title">{s.title}</span>
                <span className="lec-dim">
                  {s.status === "interrupted" ? `${t("lecture.interrupted")} · ` : ""}
                  {s.started_at} · {fmtTs(s.duration_ms || 0)}
                </span>
              </button>
              <button
                className="icon-btn"
                title={t("common.delete")}
                onClick={() => void deleteSession(s.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="lec-controls">
        <input
          className="lec-title-input"
          placeholder={t("lecture.titlePlaceholder")}
          value={title}
          disabled={recording}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="lec-check">
          <input
            type="checkbox"
            checked={systemAudio}
            disabled={recording}
            onChange={(e) => setSystemAudio(e.target.checked)}
          />
          <Radio size={14} /> {t("lecture.systemAudio")}
        </label>
        {!recording ? (
          <button className="lec-btn primary" onClick={() => void startRecording()}>
            <Mic size={16} /> {t("lecture.start")}
          </button>
        ) : (
          <button className="lec-btn danger" onClick={() => void stopRecording()}>
            <Square size={16} /> {t("lecture.stop")}
          </button>
        )}
        {session && (
          <button
            className="lec-btn ghost"
            disabled={!!busy || recheckBusy || recording}
            onClick={() => void runRecheck()}
            title={t("lecture.recheck.hint")}
          >
            <SearchCheck size={16} /> {t("lecture.recheck.btn")}
          </button>
        )}

        {recording && (
          <span className="lec-rec-time">{fmtTs((status?.recordingSec || 0) * 1000)}</span>
        )}
      </div>

      {error && <div className="lec-error">{error}</div>}
      {status?.lastError && (
        <div className="lec-error">
          {t("lecture.lastError")}: {status.lastError}
        </div>
      )}
      {status?.live && (
        <div className="lec-live-strip">
          {t("lecture.queue", { n: status.queue })}
          {status.transcribing ? ` · ${t("lecture.transcribing")}` : ""}
          {status.vadStats
            ? ` · ${t("lecture.vadStats", { speech: status.vadStats.speechFrames, frames: status.vadStats.frames })}`
            : ""}
          {status.vad?.mic
            ? ` · ${t("lecture.audio.liveThreshold", { db: status.vad.mic.thresholdDb, noise: status.vad.mic.noiseFloorDb })}`
            : ""}
          {status.vad?.mic?.stats?.skippedMs
            ? ` · ${t("lecture.audio.skipped", { sec: Math.round(status.vad.mic.stats.skippedMs / 1000) })}`
            : ""}
        </div>
      )}

      {/* Прогресс «Проверить пропуски»: идёт по raw.wav, поэтому может длиться минуты */}
      {status?.recheck && status.recheck.state !== "idle" && (
        <div className="lec-live-strip">
          {status.recheck.state === "working"
            ? t("lecture.recheck.working", {
                progress: status.recheck.progress,
                total: status.recheck.total,
              })
            : status.recheck.state === "done"
              ? t("lecture.recheck.done", {
                  found: status.recheck.found,
                  restored: status.recheck.restored,
                })
              : t("lecture.recheck.error", { error: status.recheck.error })}
          {status.recheck.truncated ? ` · ${t("lecture.recheck.truncated")}` : ""}
        </div>
      )}

      {/* Сплит-скрин: телепромтер / конспект */}
      <div className="lec-split">
        <div
          className="lec-feed"
          ref={feedRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            autoscroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {chunks.length === 0 && <div className="lec-empty">{t("lecture.emptyFeed")}</div>}
          {chunks.map((c) => (
            <div key={c.id} className={`lec-chunk st-${c.status}`}>
              <button
                className="lec-ts"
                onClick={() => void playChunk(c)}
                title={t("lecture.playChunk")}
              >
                {playingChunk === c.id ? <Pause size={11} /> : <Play size={11} />}
                {fmtTs(c.start_ms)}
              </button>
              {editing?.chunkId === c.id ? (
                <div className="lec-edit">
                  <textarea
                    value={editing.text}
                    onChange={(e) => setEditing({ chunkId: c.id, text: e.target.value })}
                    rows={3}
                  />
                  <div className="lec-edit-actions">
                    <button className="lec-btn tiny" onClick={() => void saveEdit()}>
                      <Save size={12} /> {t("common.save")}
                    </button>
                    <button className="lec-btn tiny ghost" onClick={() => setEditing(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <span
                  className="lec-text"
                  onDoubleClick={() => setEditing({ chunkId: c.id, text: c.text })}
                  title={t("lecture.clickToEdit")}
                >
                  {/* ВАЖНО: причина и уровень показываются ЧЕСТНО. Раньше любая
                      пустая строка подписывалась «отброшено VAD», хотя это мог
                      быть и ответ Whisper, и шум на входе — разбираться было нечем. */}
                  {c.text ? (
                    <>
                      {c.source === "sys" && (
                        <span className="lec-src-sys" title={t("lecture.audio.srcSys")}>
                          {t("lecture.audio.srcSysShort")}{" "}
                        </span>
                      )}
                      {!c.source || c.source === "mic" ? (
                        <span className="lec-src-mic" title={t("lecture.audio.srcMicShort")}>
                          {t("lecture.audio.srcMicShort")}{" "}
                        </span>
                      ) : null}
                      {c.source === "recheck" && (
                        <span className="lec-src-recheck" title={t("lecture.recheck.srcShort")}>
                          ↻{" "}
                        </span>
                      )}
                      {/* Говорящий по диаризации (sherpa): «Аудитория 2» → №2. */}
                      {!!speakerBadge(c) && (
                        <span
                          className="lec-src-spk"
                          title={t("lecture.diarizePanel.speakerBadgeHint")}
                        >
                          {speakerBadge(c)}{" "}
                        </span>
                      )}
                      {c.text}
                    </>
                  ) : c.status === "pending" ? (
                    <i className="lec-dim">…</i>
                  ) : (
                    <i className="lec-dim">{chunkNote(t, c)}</i>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="lec-notes">
          <div className="lec-notes-head">
            <strong>{t("lecture.notes")}</strong>
            <div className="lec-notes-actions">
              <button
                className="lec-btn tiny"
                disabled={!session || conspectusBusy}
                onClick={() => void runConspectus()}
              >
                <Sparkles size={12} />{" "}
                {conspectusBusy ? t("lecture.conspectusBusy") : t("lecture.conspectus")}
              </button>
              {/* Режим запуска виден рядом с кнопкой: иначе непонятно, ждать ли
                  конспект автоматически или его надо собирать вручную. */}
              {conspectusCfg && conspectusCfg.trigger !== "manual" && (
                <span
                  className="lecs-dim lecs-hint"
                  title={t(`lecture.conspectusPanel.triggerHint.${conspectusCfg.trigger}`)}
                >
                  {t(`lecture.conspectusPanel.trigger.${conspectusCfg.trigger}`)}
                </span>
              )}
              {conspectusSt?.stale && (
                <span className="lec-src-recheck" title={t("lecture.conspectusStaleHint")}>
                  {t("lecture.conspectusStale")}
                </span>
              )}
              {!!conspectusNote && <span className="lecs-dim lecs-hint">{conspectusNote}</span>}
              <button
                className="icon-btn"
                title={t("lecture.saveNotes")}
                disabled={!session}
                onClick={() => void saveNotes()}
              >
                <Save size={14} />
              </button>
              {notesSaved && <span className="lec-saved">{t("lecture.notesSaved")}</span>}
            </div>
          </div>
          {/* Конфликт заметок: авто-конспект дописал их на сервере, а в поле —
              ручная правка. Молча затирать нельзя, поэтому выбор даёт человек. */}
          {notesStale && (
            <div className="lecs-warn lec-notes-stale">
              <AlertTriangle size={13} />
              <span>{t("lecture.notesStale")}</span>
              <button
                className="lec-btn tiny ghost"
                onClick={() => {
                  setNotes(serverNotesRef.current);
                  notesDirtyRef.current = false;
                  setNotesStale(false);
                }}
              >
                {t("lecture.notesStalePull")}
              </button>
              <button className="lec-btn tiny ghost" onClick={() => setNotesStale(false)}>
                {t("lecture.notesStaleKeep")}
              </button>
            </div>
          )}
          <textarea
            className="lec-notes-area"
            placeholder={t("lecture.notesPlaceholder")}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setNotesSaved(false);
              // Ручная правка: серверную версию больше не подтягиваем молча.
              notesDirtyRef.current = true;
            }}
          />
          <div className="lec-exports">
            <span className="lec-dim">{t("lecture.export")}:</span>
            {(["md", "srt", "vtt"] as const).map((f) => (
              <button
                key={f}
                className="lec-btn tiny ghost"
                disabled={!session || !!busy}
                onClick={() => void downloadExport(f)}
              >
                <Download size={12} /> {f.toUpperCase()}
              </button>
            ))}
            {session && (
              <button
                className="lec-btn tiny ghost"
                disabled={!!busy}
                onClick={() => void downloadAudio()}
              >
                <Download size={12} /> WAV
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
