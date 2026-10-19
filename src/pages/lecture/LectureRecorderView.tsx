import { openAiHub } from "@/lib/openAiHub";
import { useEffect, useRef, useState } from "react";

// Колонка конспекта: по умолчанию минимальной ширины, тянется за левый край.
const NOTES_W_KEY = "moonapp.lecture.notesW";
const NOTES_W_MIN = 260;
const NOTES_W_MAX = 640;
function readNotesW(): number {
  try {
    const v = Number(localStorage.getItem(NOTES_W_KEY));
    if (Number.isFinite(v) && v >= NOTES_W_MIN) return Math.min(NOTES_W_MAX, v);
  } catch {
    /* хранилище недоступно — по умолчанию минимум */
  }
  return NOTES_W_MIN;
}
import { copyToClipboard } from "@/components/ContextMenu";
import {
  Cpu,
  ChevronDown,
  Volume2,
  Sparkles,
  Users,
  Settings2,
  FolderOpen,
  Copy,
  Trash2,
  Radio,
  Play,
  Square,
  Pause,
  Mic,
  SearchCheck,
  Save,
  RefreshCw,
  AlertTriangle,
  Download,
  MessageCircleQuestion,
} from "lucide-react";
import LectureAudioPanel, { LevelMeter } from "@/pages/lecture/parts/LectureAudioPanel";
import LectureEnginePanel from "@/pages/lecture/parts/LectureEnginePanel";
import AudioCleanPanel from "@/pages/lecture/parts/AudioCleanPanel";
import QuickNoteTab from "@/pages/lecture/parts/QuickNoteTab";
import ForesightPanel from "@/pages/lecture/parts/ForesightPanel";
import LectureSemantic from "@/pages/lecture/parts/LectureSemantic";
import LectureConspectusPanel from "@/pages/lecture/parts/LectureConspectusPanel";
import LectureAskPanel from "@/pages/lecture/parts/LectureAskPanel";
import ExamPanel from "@/pages/lecture/parts/ExamPanel";
import VoiceVaultPanel from "@/pages/lecture/parts/VoiceVaultPanel";
import LectureDiarizePanel from "@/pages/lecture/parts/LectureDiarizePanel";
import { Btn } from "@/components/ui";
import { chunkNote, fmtTs, speakerBadge } from "@/pages/lecture/parts/LectureRecorderHelpers";
import type { useLectureRecorderResult } from "@/pages/lecture/useLectureRecorder";

/** Разметка страницы; всё состояние приходит из useLectureRecorder. */
export default function LectureRecorderView({ c }: { c: useLectureRecorderResult }) {
  const {
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
  } = c;

  // Диалоги (движок, аудио, конспект, говорящие, вопрос) — взаимоисключающие:
  // новый закрывает прежний, а Esc закрывает открытый. Раньше они копились
  // друг на друге и не закрывались с клавиатуры.
  // Ширина колонки конспекта (по умолчанию минимальная, тянется мышью, запоминается).
  const [notesW, setNotesW] = useState<number>(readNotesW);
  const startNotesResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = notesW;
    let last = startW;
    const move = (ev: PointerEvent) => {
      last = Math.min(NOTES_W_MAX, Math.max(NOTES_W_MIN, startW + (startX - ev.clientX)));
      setNotesW(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      try {
        localStorage.setItem(NOTES_W_KEY, String(Math.round(last)));
      } catch {
        /* не критично */
      }
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const panelFlags = [showEngine, showAudio, showConspectus, showDiarize, showAsk];
  const prevFlags = useRef(panelFlags);
  useEffect(() => {
    const closers = [setShowEngine, setShowAudio, setShowConspectus, setShowDiarize, setShowAsk];
    const opened = panelFlags.findIndex((f, i) => f && !prevFlags.current[i]);
    if (opened >= 0) closers.forEach((close, i) => i !== opened && close(false));
    prevFlags.current = panelFlags;
  });
  const anyPanel = panelFlags.some(Boolean);
  useEffect(() => {
    if (!anyPanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setShowEngine(false);
      setShowAudio(false);
      setShowConspectus(false);
      setShowDiarize(false);
      setShowAsk(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyPanel, setShowEngine, setShowAudio, setShowConspectus, setShowDiarize, setShowAsk]);

  return (
    <div className="page lec-page">
      <div className="lec-tabbar">
        <button
          type="button"
          className={`lec-tabbtn${pageTab === "lecture" ? " is-active" : ""}`}
          onClick={() => setPageTab("lecture")}
        >
          {t("lecture.tabLecture")}
        </button>
        <button
          type="button"
          className={`lec-tabbtn${pageTab === "quick" ? " is-active" : ""}`}
          onClick={() => setPageTab("quick")}
        >
          {t("lecture.tabQuickNote")}
        </button>
        <button
          type="button"
          className={`lec-tabbtn${pageTab === "foresight" ? " is-active" : ""}`}
          onClick={() => setPageTab("foresight")}
        >
          {t("lecture.tabForesight")}
        </button>
      </div>
      {/* Шапка: статус движка + контролы. Общая для обеих вкладок — настройки
          движка распознавания (кнопка Settings2) одни и те же и для Лектория,
          и для Быстрых заметок, поэтому шапка не дублируется под каждую вкладку. */}
      <div className="lec-header">
        <div className="lec-engine">
          <Cpu size={16} />
          <span className={engine?.ready ? "lec-ok" : "lec-warn"}>
            {engine?.ready
              ? engine.asr === "gigaam"
                ? t("lecture.engineReadyGigaam")
                : t("lecture.engineReady", { backend: engine.backend || "cpu" })
              : t("lecture.engineMissing")}
          </span>
          {engine && !engine.ready && (
            <button type="button" className="lec-btn ghost" onClick={() => openAiHub(t("aiHub.title"))}>
              {t("lecture.setupBtn")}
            </button>
          )}
          <span className="lec-sep">·</span>
          <span className="lec-dim">
            {engine?.asr === "gigaam"
              ? "GigaAM v3"
              : engine?.model
                ? engine.model.split(/[\\/]/).pop()
                : "—"}
          </span>
        </div>
        <div className="lec-actions">
          {pageTab !== "quick" && recordingActive && (
            <LevelMeter db={levelDb} thresholdDb={audio?.vad.thresholdDb ?? -42} t={t} />
          )}
          {/* Кнопки-иконки, без подписей: ряд больше не распирает шапку, поэтому
              последняя кнопка не уезжает за край узкого окна. Смысл кнопки —
              в title (подсказка) и aria-label (скринридер). Часть кнопок имеет
              смысл только на вкладке «Лекторий». */}
          {pageTab !== "quick" && (
            <>
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
                onClick={() => setShowAsk((v) => !v)}
                title={t("lecture.askPanel.btnHint")}
                aria-label={t("lecture.askPanel.btn")}
                disabled={!session?.id}
              >
                <MessageCircleQuestion size={16} />
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
            </>
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

      <VoiceVaultPanel />

      {pageTab === "quick" && (
        <>
          <QuickNoteTab engineReady={!!engine?.ready} />
          <AudioCleanPanel />
        </>
      )}
      {pageTab !== "quick" && (
        <>
          {showAudio && (
            <LectureAudioPanel
              onClose={() => setShowAudio(false)}
              settings={audio}
              devices={devices}
              levelDb={levelDb}
              metrics={status?.vad?.mic || null}
              recording={recordingActive}
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
              modelHints={modelFix}
            />
          )}

          {showAsk && session?.id && (
            <LectureAskPanel sessionId={session.id} onClose={() => setShowAsk(false)} />
          )}

          {session?.id ? <ExamPanel sessionId={session.id} /> : null}

          {showDiarize && (
            <LectureDiarizePanel
              onClose={() => setShowDiarize(false)}
              sessionId={session?.id || 0}
              onChanged={refreshStatusAll}
            />
          )}

          {showSessions && (
            <div className="lec-sessions">
              <LectureSemantic
                title={sessions.find((x) => x.id === session?.id)?.title ?? ""}
                notes={notes}
                onOpen={(id) => void openSession(id)}
              />
              {sessions.length === 0 && <div className="lec-dim">{t("lecture.noSessions")}</div>}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="lec-session-row"
                  onContextMenu={(e) =>
                    menu.open(e, [
                      {
                        label: t("ctx.open"),
                        icon: FolderOpen,
                        onClick: () => void openSession(s.id),
                      },
                      {
                        label: t("ctx.copyName"),
                        icon: Copy,
                        onClick: () => copyToClipboard(s.title),
                      },
                      { separator: true },
                      {
                        label: t("common.delete"),
                        icon: Trash2,
                        danger: true,
                        onClick: () => void deleteSession(s.id),
                      },
                    ])
                  }
                >
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
              disabled={recordingActive}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label className="lec-check">
              <input
                type="checkbox"
                checked={systemAudio}
                disabled={recordingActive}
                onChange={(e) => setSystemAudio(e.target.checked)}
              />
              <Radio size={14} /> {t("lecture.systemAudio")}
            </label>
            {/* Три состояния записи: идёт / пауза / простой. На паузе сессия живёт,
            поэтому пользователю нужны ОБЕ кнопки — «Продолжить» и «Стоп». */}
            {paused ? (
              <>
                <button className="lec-btn primary" onClick={() => void resumeRecording()}>
                  <Play size={16} /> {t("lecture.resume")}
                </button>
                <button
                  className="lec-btn danger"
                  onClick={() => void stopRecording()}
                  title={t("lecture.stopHint")}
                >
                  <Square size={16} /> {t("lecture.stop")}
                </button>
              </>
            ) : recording ? (
              <>
                <button className="lec-btn" onClick={pauseRecording} title={t("lecture.pauseHint")}>
                  <Pause size={16} /> {t("lecture.pause")}
                </button>
                <button className="lec-btn danger" onClick={() => void stopRecording()}>
                  <Square size={16} /> {t("lecture.stop")}
                </button>
              </>
            ) : (
              <button className="lec-btn primary" onClick={() => void startRecording()}>
                <Mic size={16} /> {t("lecture.start")}
              </button>
            )}
            {session && (
              <button
                className="lec-btn ghost"
                disabled={!!busy || recheckBusy || recordingActive}
                onClick={() => void runRecheck()}
                title={t("lecture.recheck.hint")}
              >
                <SearchCheck size={16} /> {t("lecture.recheck.btn")}
              </button>
            )}

            {recordingActive && (
              <span className="lec-rec-time">
                {paused ? `${t("lecture.paused")} · ` : ""}
                {fmtTs((status?.recordingSec || 0) * 1000)}
              </span>
            )}
          </div>

          {error && (
            <div className="lec-error">
              <span>{error}</span>
              {/* Модель не принята провайдером: рядом кнопка выбора «провайдер и
              модель» (всплывающая панель) и чипсы имён, которые сервис реально
              принимает. Клик по чипсу сразу сохраняет выбор в настройки. */}
              {modelFix && (
                <div className="lec-error-fix">
                  <Btn variant="ghost" icon={Sparkles} onClick={() => setShowConspectus(true)}>
                    {t("lecture.fixModel")}
                  </Btn>
                  {modelFix.names.map((name) => (
                    <button
                      key={name}
                      className="lec-model-chip"
                      title={t("lecture.modelPick", { model: name })}
                      onClick={() => void applyModel(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!!modelNotice && <div className="lec-model-notice">{modelNotice}</div>}
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

          {pageTab === "foresight" && (
            <ForesightPanel
              sessionId={session?.id ?? null}
              live={recordingActive}
              notes={notes}
              onInsertNotes={(text) => {
                setNotes(notes ? `${notes}

${text}` : text);
                notesDirtyRef.current = true;
                setNotesSaved(false);
              }}
            />
          )}

          {/* Сплит-скрин: телепромтер / конспект */}
          <div className="lec-split" style={{ gridTemplateColumns: `minmax(0, 1fr) ${notesW}px` }}>
            <div
              className="lec-split-handle"
              style={{ right: notesW + 1 }}
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startNotesResize}
            />
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
                <div
                  key={c.id}
                  className={`lec-chunk st-${c.status}`}
                  onContextMenu={(e) =>
                    menu.open(e, [
                      { label: t("ctx.copy"), icon: Copy, onClick: () => copyToClipboard(c.text) },
                      {
                        label: t("lecture.clickToEdit"),
                        icon: Save,
                        disabled: !c.text,
                        onClick: () => setEditing({ chunkId: c.id, text: c.text }),
                      },
                      {
                        label: t("lecture.playChunk"),
                        icon: Play,
                        onClick: () => void playChunk(c),
                      },
                    ])
                  }
                >
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
              {/* Потоковая расшифровка (бета): черновик незакрытого сегмента, пока
              пользователь ещё говорит — исчезает/заменяется финальным чанком,
              как только VAD закроет паузой (см. status.draft в lecture.js). */}
              {status?.live &&
                (["mic", "sys"] as const).map((src) =>
                  status.draft?.[src] ? (
                    <div key={`draft-${src}`} className="lec-chunk lec-chunk-draft">
                      <span className="lec-ts lec-ts-draft">
                        {src === "sys" ? (
                          <span className="lec-src-sys" title={t("lecture.audio.srcSys")}>
                            {t("lecture.audio.srcSysShort")}
                          </span>
                        ) : (
                          <span className="lec-src-mic" title={t("lecture.audio.srcMicShort")}>
                            {t("lecture.audio.srcMicShort")}
                          </span>
                        )}
                      </span>
                      <span
                        className="lec-text lec-text-draft"
                        title={t("lecture.audio.streamingDraftHint")}
                      >
                        {status.draft[src]}
                      </span>
                    </div>
                  ) : null,
                )}
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
                  {/* «Регенерировать»: тот же проход по расшифровке, но заметки
                  ПЕРЕЗАПИСЫВАЮТСЯ новым конспектом. Нужна, когда предыдущая
                  сборка вышла неудачной или в поле накопился мусор: обычная
                  кнопка выше ДОПИСЫВАЕТ конспект к уже имеющемуся тексту.
                  Подпись убрана: ряд мелких кнопок распирал шапку панели, смысл
                  остался в title (подсказка) и aria-label (скринридер). */}
                  <button
                    className="lec-btn tiny ghost icon"
                    disabled={!session || conspectusBusy}
                    title={t("lecture.regenerateHint")}
                    aria-label={t("lecture.regenerate")}
                    onClick={() => void runConspectus(true)}
                  >
                    <RefreshCw size={12} />
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
        </>
      )}
    </div>
  );
}
