import { useI18n } from "@/app/i18n";
import { useContextMenu } from "@/components/ContextMenu";
import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import type {
  LectureEngineStatus,
  LectureSession,
  LectureCreateResult,
  LectureStatus,
  LectureConspectusSettings,
  LectureConspectusState,
  LectureDiarizeState,
  LectureAudioSettings,
  LectureChunk,
} from "@/api/client";
import { parseModelNameError } from "@/lib/modelError";
import { usePageBusy } from "@/components/Toolbar";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
import { useDeepLink } from "@/lib/deepLink";
import {
  SEND_INTERVAL_MS,
  TARGET_RATE,
  acquireMic,
  acquireSystemAudio,
  conspectusProgressText,
  downsampleToInt16,
  lectureError,
} from "@/pages/lecture/parts/LectureRecorderHelpers";

/** Состояние и обработчики страницы (вынесено из LectureRecorderPage.tsx). */
export function useLectureRecorder() {
  const { t } = useI18n();
  const menu = useContextMenu();

  // Вкладка страницы: полноценная сессия лекции или быстрая голосовая заметка
  // (перенесена сюда со своей отдельной страницы — настройки движка распознавания
  // общие, это та же секция ниже "engine"/whisper, второй настройки не заводим).
  const [pageTab, setPageTab] = useState<"lecture" | "quick" | "foresight">("lecture");

  const [engine, setEngine] = useState<LectureEngineStatus | null>(null);
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [session, setSession] = useState<LectureCreateResult | null>(null);
  const [status, setStatus] = useState<LectureStatus | null>(null);
  const [title, setTitle] = useState("");
  const [systemAudio, setSystemAudio] = useState(false);
  const [recording, setRecording] = useState(false);
  // Пауза: микрофон освобождён, но СЕССИЯ на сервере продолжает жить — запись
  // продолжится в ту же лекцию. Раньше «стоп + запись» всегда создавали новую
  // лекцию, поэтому поставить паузу и вернуться к ней было нельзя.
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  // «Модель сохранена» — короткая плашка: пользователь только что выбрал модель
  // из подсказки чипсом и должен видеть, что выбор уже в настройках.
  const [modelNotice, setModelNotice] = useState("");
  /**
   * Ошибка вида «сервис принимает такие-то модели» → показываем кнопку
   * «Провайдер и модель» и чипсы с именами. Разбор берём из готового текста
   * ошибки, а не из каждого catch: так подсказка появляется и для ошибок чата,
   * и для конспекта, и для будущих вызовов модели.
   */
  const modelFix = useMemo(() => parseModelNameError(error), [error]);
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
  const [showAsk, setShowAsk] = useState(false); // панель «Вопрос по записи»
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
  // Пауза тоже «задача»: пока она активна, сессия живёт, и выгружать страницу
  // (теряя её id) нельзя.
  const recordingActive = recording || paused;
  usePageBusy(recordingActive || conspectusBusy || calibrating || recheckBusy);

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

  /**
   * Сохранить модель из подсказки («сервис принимает: …»).
   *
   * Один клик = выбор сделан и записан в settings.json, поэтому повторять
   * настройку в следующий раз не нужно (сервер хранит conspectusModel).
   */
  const applyModel = useCallback(
    async (model: string) => {
      try {
        await api.lectureConspectusSetSettings({ model });
        setError("");
        setModelNotice(t("lecture.modelSaved", { model }));
        refreshConspectusCfg();
        if (session) refreshStatus(session.id);
      } catch (e) {
        setError(lectureError(t, e));
      }
    },
    [t, refreshConspectusCfg, refreshStatus, session],
  );

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
    // Стоп из паузы: прибор закрывается, поэтому снимаем и признак паузы.
    setPaused(false);
    if (!session) return;
    try {
      const st = await api.lectureStop(session.id);
      setStatus(st);
      refreshMeta();
    } catch (e) {
      setError(lectureError(t, e));
    }
  }, [releaseAudio, refreshMeta, session, t]);

  /**
   * Подключить аудио-граф к УЖЕ существующей сессии.
   *
   * Вынесено из startRecording, чтобы «Пауза → Продолжить» возвращалось в ту же
   * лекцию: раньше единственной кнопкой продолжения была «Начать запись», а она
   * всегда создавала НОВУЮ сессию — поставленная пауза терялась.
   */
  const attachAudio = useCallback(
    async (sessionId: number, stream: MediaStream) => {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
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
                setPaused(false);
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

      audioRef.current = { ctx, stream, processor, source: src, gain, track };
    },
    [audio, refreshMeta, releaseAudio, systemAudio, t],
  );

  /** Начать НОВУЮ лекцию: создать сессию на сервере и подключить аудио. */
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
      await attachAudio(created.id, streamLocal);
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
      setPaused(false);
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
  }, [attachAudio, audio, refreshMeta, systemAudio, t, title]);

  /**
   * ПАУЗА: освобождаем микрофон («ушли на перерыв»), но сессию на сервере НЕ
   * закрываем — raw.wav, VAD-очередь и заметки остаются той же лекцией, а
   * «Продолжить» просто снова поднимает звук в тот же id.
   */
  const pauseRecording = useCallback(() => {
    releaseAudio();
    setPaused(true);
  }, [releaseAudio]);

  /** Продолжить запись в ТУ ЖЕ лекцию (та же сессия и тот же raw.wav). */
  const resumeRecording = useCallback(async () => {
    if (!session) return;
    setError("");
    let streamLocal: MediaStream | null = null;
    try {
      streamLocal = systemAudio
        ? await acquireSystemAudio()
        : await acquireMic(String(audio?.micDeviceId || ""), audio?.micAgc === true);
      await attachAudio(session.id, streamLocal);
      setPaused(false);
      setRecording(true);
    } catch (e) {
      setError(lectureError(t, e));
      try {
        streamLocal?.getTracks().forEach((tr) => tr.stop());
      } catch {
        /* ignore */
      }
    }
  }, [attachAudio, audio, session, systemAudio, t]);

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

  /**
   * Собрать ИИ-конспект из расшифровки.
   * replace=true — «Регенерировать»: сервер ПЕРЕЗАПИШЕТ заметки новым конспектом
   * вместо дописывания, поэтому локальную копию заменяем целиком (r.markdown).
   */
  const runConspectus = useCallback(
    async (replace = false) => {
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
        const r = await api.lectureConspectus(id, replace);
        setNotes(r.markdown);
        // Конспект сервер уже записал в заметки (дописал или перезаписал при
        // replace), локальная копия его содержит — значит «Сохранить заметки»
        // не затрёт результат, конфликт снят.
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
        else if (r.replaced) setConspectusNote(t("lecture.regenerated"));
        refreshStatus(id);
      } catch (e) {
        setError(lectureError(t, e));
      } finally {
        clearInterval(timer);
        setConspectusNote("");
        setConspectusBusy(false);
      }
    },
    [refreshStatus, session, t],
  );

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

  useDeepLink("lecture", (t) => {
    if (t.view === "quick") setPageTab("quick");
    else if (t.ref) {
      setPageTab("lecture");
      setShowSessions(true);
      void openSession(Number(t.ref));
    }
  });

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
  return {
    t,
    menu,
    pageTab,
    setPageTab,
    engine,
    sessions,
    session,
    status,
    title,
    setTitle,
    systemAudio,
    setSystemAudio,
    recording,
    paused,
    error,
    modelNotice,
    modelFix,
    editing,
    setEditing,
    notes,
    setNotes,
    notesSaved,
    setNotesSaved,
    conspectusBusy,
    conspectusNote,
    showSessions,
    setShowSessions,
    playingChunk,
    busy,
    showEngine,
    setShowEngine,
    showAudio,
    setShowAudio,
    showConspectus,
    setShowConspectus,
    showDiarize,
    setShowDiarize,
    showAsk,
    setShowAsk,
    conspectusCfg,
    conspectusSt,
    diarizeSt,
    notesStale,
    setNotesStale,
    audio,
    devices,
    levelDb,
    calibrating,
    recheckBusy,
    serverNotesRef,
    notesDirtyRef,
    recordingActive,
    feedRef,
    autoscroll,
    refreshMeta,
    loadDevices,
    refreshStatusAll,
    refreshConspectusCfg,
    applyModel,
    stopRecording,
    startRecording,
    pauseRecording,
    resumeRecording,
    saveAudio,
    calibrate,
    runRecheck,
    saveEdit,
    saveNotes,
    playChunk,
    downloadExport,
    downloadAudio,
    runConspectus,
    openSession,
    deleteSession,
    chunks,
  };
}

export type useLectureRecorderResult = ReturnType<typeof useLectureRecorder>;
