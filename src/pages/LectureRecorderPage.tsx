import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic, Square, Download, Pin, Sparkles, Trash2, ChevronDown, Cpu, Radio, Save,
} from "lucide-react";
import { api } from "../api/client";
import type {
  LectureChunk, LectureCreateResult, LectureEngineStatus, LectureSession, LectureStatus,
} from "../api/client";
import { useI18n } from "../i18n";

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
 * click-to-edit. Ctrl+B / F2 — маркер «важного». Ollama — офлайн-конспект.
 */

const TARGET_RATE = 16000;
const SEND_INTERVAL_MS = 500;

function fmtTs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map((x) => String(x).padStart(2, "0")).join(":");
}

function downloadUrl(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
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

/** Системный звук (онлайн-лекции): захват через getDisplayMedia с audio. */
async function acquireStream(systemAudio: boolean): Promise<MediaStream> {
  if (!systemAudio) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTracks = display.getAudioTracks();
  if (!audioTracks.length) {
    display.getTracks().forEach((tr) => tr.stop());
    throw new Error("no_system_audio");
  }
  display.getVideoTracks().forEach((tr) => tr.stop());
  return new MediaStream(audioTracks);
}

interface DeviceInfo { deviceId: string; label: string }

export default function LectureRecorderPage() {
  const { t } = useI18n();

  const [engine, setEngine] = useState<LectureEngineStatus | null>(null);
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [session, setSession] = useState<LectureCreateResult | null>(null);
  const [status, setStatus] = useState<LectureStatus | null>(null);
  const [title, setTitle] = useState("");
  const [systemAudio, setSystemAudio] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ chunkId: number; text: string } | null>(null);
  const [notes, setNotes] = useState("");
  const [conspectusBusy, setConspectusBusy] = useState(false);
  const [showSessions, setShowSessions] = useState(false);

  const audioRef = useRef<{
    ctx: AudioContext; stream: MediaStream; processor: ScriptProcessorNode; source: MediaStreamAudioSourceNode;
  } | null>(null);
  const resampleBuf = useRef<Float32Array[]>([]);
  const resampleLen = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const autoscroll = useRef(true);

  /* ---- Инициализация: движок + список сессий ---- */
  const refreshMeta = useCallback(() => {
    api.lectureEngine().then(setEngine).catch(() => setEngine(null));
    api.lectureSessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => { refreshMeta(); }, [refreshMeta]);

  const refreshStatus = useCallback((id: number) => {
    api.lectureStatus(id).then(setStatus).catch(() => { /* сессия могла быть удалена */ });
  }, []);

  /* ---- Поллинг статуса активной сессии ---- */
  useEffect(() => {
    if (!session) return;
    const id = session.id;
    refreshStatus(id);
    const timer = setInterval(() => refreshStatus(id), 1800);
    return () => clearInterval(timer);
  }, [session, refreshStatus]);

  /* ---- Автоскролл телепромтера ---- */
  useEffect(() => {
    if (autoscroll.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [status?.chunks.length]);


  /* ---- Запись ---- */
  const stopRecording = useCallback(async (finalStop: boolean) => {
    setRecording(false);
    const a = audioRef.current;
    if (a) {
      try { a.processor.disconnect(); a.source.disconnect(); } catch { /* ignore */ }
      a.stream.getTracks().forEach((tr) => tr.stop());
      void a.ctx.close();
      audioRef.current = null;
    }
    if (session && finalStop) {
      try {
        const st = await api.lectureStop(session.id);
        setStatus(st);
        refreshMeta();
      } catch (e) { setError(String((e as Error).message)); }
    }
  }, [session, refreshMeta]);

  const startRecording = useCallback(async () => {
    setError("");
    try {
      const created = await api.lectureCreate(title || t("lecture.defaultTitle"));
      setSession(created);
      setStatus(null);
      setNotes("");

      const stream = await acquireStream(systemAudio);
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        setDevices(devs.filter((d) => d.kind === "audioinput").map((d) => ({
          deviceId: d.deviceId, label: d.label || t("lecture.deviceUnlabeled"),
        })));
      } catch { /* ignore */ }

      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      resampleBuf.current = [];
      resampleLen.current = 0;

      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        setLevel(Math.sqrt(sum / input.length));
        resampleBuf.current.push(input);
        resampleLen.current += input.length;
        // Накопили ~500 мс → отправляем на сервер (fail-safe raw + VAD).
        const targetSamples = ctx.sampleRate * (SEND_INTERVAL_MS / 1000);
        if (resampleLen.current >= targetSamples) {
          const merged = new Float32Array(resampleLen.current);
          let off = 0;
          for (const b of resampleBuf.current) { merged.set(b, off); off += b.length; }
          resampleBuf.current = [];
          resampleLen.current = 0;
          const pcm = downsampleToInt16(merged, ctx.sampleRate, TARGET_RATE);
          void api.lectureIngest(created.id, pcm.buffer as ArrayBuffer).catch(() => { /* следующий кусок доотправит */ });
        }
      };
      const mute = ctx.createGain();
      mute.gain.value = 0; // ScriptProcessor требует подключение к графу — глушим
      src.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);

      audioRef.current = { ctx, stream, processor, source: src };
      setRecording(true);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, [title, systemAudio, t]);

  /* ---- Хоткеи: Ctrl+B / F2 — маркер важного ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMarker = e.key === "F2" || (e.ctrlKey && (e.key === "b" || e.key === "B" || e.code === "KeyB"));
      if (!isMarker || !session) return;
      e.preventDefault();
      const atMs = status ? status.recordingSec * 1000 : 0;
      void api.lectureMarker(session.id, atMs, t("lecture.importantPoint"))
        .then(() => refreshStatus(session.id))
        .catch(() => { /* ignore */ });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, status, refreshStatus, t]);

  /* ---- Waveform-визуализатор ---- */
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx2d = canvas?.getContext("2d");
      if (canvas && ctx2d) {
        const w = canvas.width, h = canvas.height;
        ctx2d.clearRect(0, 0, w, h);
        const bars = 48;
        const amp = Math.min(1, level * 6);
        for (let i = 0; i < bars; i++) {
          const bh = Math.max(2, amp * h * (0.4 + 0.6 * Math.abs(Math.sin(i * 1.7 + Date.now() / 400))));
          ctx2d.fillStyle = amp > 0.03 ? "#f59e0b" : "#555";
          ctx2d.fillRect((i * w) / bars + 2, h - bh, w / bars - 4, bh);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [recording, level]);


  /* ---- Действия ---- */
  const saveEdit = useCallback(async () => {
    if (!editing) return;
    await api.lectureEditChunk(editing.chunkId, editing.text).catch(() => { /* ignore */ });
    setEditing(null);
    if (session) refreshStatus(session.id);
  }, [editing, session, refreshStatus]);

  const runConspectus = useCallback(async () => {
    if (!session) return;
    setConspectusBusy(true);
    setError("");
    try {
      const r = await api.lectureConspectus(session.id);
      setNotes(r.markdown);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setConspectusBusy(false); }
  }, [session]);

  /** Открыть прошлую сессию (просмотр/доделка экспорта). */
  const openSession = useCallback(async (id: number) => {
    setSession(null);
    const st = await api.lectureStatus(id).catch(() => null);
    if (!st) return;
    setSession({
      id, sampleRate: st.lecture.sample_rate, channels: st.lecture.channels,
      vad: null as never, whisper: st.whisper,
    });
    setStatus(st);
    setNotes(st.lecture.notes || "");
    setShowSessions(false);
  }, []);

  const deleteSession = useCallback(async (id: number) => {
    await api.lectureDelete(id).catch(() => { /* ignore */ });
    if (session?.id === id) { setSession(null); setStatus(null); }
    refreshMeta();
  }, [session, refreshMeta]);

  const addManualMarker = useCallback(() => {
    if (!session) return;
    const atMs = status ? status.recordingSec * 1000 : 0;
    void api.lectureMarker(session.id, atMs, t("lecture.importantPoint"))
      .then(() => refreshStatus(session.id))
      .catch(() => { /* ignore */ });
  }, [session, status, refreshStatus, t]);


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
          <button className="lec-btn ghost" onClick={() => setShowSessions((v) => !v)}>
            <ChevronDown size={16} /> {t("lecture.archive")}
          </button>
        </div>
      </div>

      {showSessions && (
        <div className="lec-sessions">
          {sessions.length === 0 && <div className="lec-dim">{t("lecture.noSessions")}</div>}
          {sessions.map((s) => (
            <div key={s.id} className="lec-session-row">
              <button className="lec-session-open" onClick={() => void openSession(s.id)}>
                <span className="lec-session-title">{s.title}</span>
                <span className="lec-dim">{s.started_at} · {fmtTs(s.duration_ms || 0)}</span>
              </button>
              <button className="icon-btn" title={t("common.delete")} onClick={() => void deleteSession(s.id)}>
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
          <input type="checkbox" checked={systemAudio} disabled={recording}
            onChange={(e) => setSystemAudio(e.target.checked)} />
          <Radio size={14} /> {t("lecture.systemAudio")}
        </label>
        {!recording ? (
          <button className="lec-btn primary" onClick={() => void startRecording()}>
            <Mic size={16} /> {t("lecture.start")}
          </button>
        ) : (
          <button className="lec-btn danger" onClick={() => void stopRecording(true)}>
            <Square size={16} /> {t("lecture.stop")}
          </button>
        )}
        <button className="lec-btn ghost" disabled={!session} onClick={addManualMarker}>
          <Pin size={16} /> {t("lecture.markImportant")} <kbd>Ctrl+B</kbd>
        </button>
        <canvas ref={canvasRef} width={220} height={28} className={recording ? "lec-viz on" : "lec-viz"} />
        {recording && <span className="lec-rec-time">{fmtTs((status?.recordingSec || 0) * 1000)}</span>}
      </div>

      {error && <div className="lec-error">{error}</div>}
      {status?.lastError && <div className="lec-error">{t("lecture.lastError")}: {status.lastError}</div>}
      {status?.live && (
        <div className="lec-live-strip">
          {t("lecture.queue", { n: status.queue })}
          {status.transcribing ? ` · ${t("lecture.transcribing")}` : ""}
          {status.vadStats ? ` · ${t("lecture.vadStats", { speech: status.vadStats.speechFrames, frames: status.vadStats.frames })}` : ""}
        </div>
      )}

      {/* Сплит-скрин: телепромтер / конспект */}
      <div className="lec-split">
        <div className="lec-feed" ref={feedRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            autoscroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}>
          {chunks.length === 0 && (
            <div className="lec-empty">{t("lecture.emptyFeed")}</div>
          )}
          {chunks.map((c) => (
            <div key={c.id} className={`lec-chunk st-${c.status}`}>
              <button className="lec-ts" onClick={() => downloadUrl(api.lectureAudioUrl(c.lecture_id) + "", "chunk.wav")}>
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
                    <button className="lec-btn tiny" onClick={() => void saveEdit()}><Save size={12} /> {t("common.save")}</button>
                    <button className="lec-btn tiny ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
                  </div>
                </div>
              ) : (
                <span className="lec-text" onDoubleClick={() => setEditing({ chunkId: c.id, text: c.text })} title={t("lecture.clickToEdit")}>
                  {c.text || (c.status === "pending" ? <i className="lec-dim">…</i> : <i className="lec-dim">{c.error || t("lecture.chunkEmpty")}</i>)}
                </span>
              )}
            </div>
          ))}
        </div>


        <div className="lec-notes">
          <div className="lec-notes-head">
            <strong>{t("lecture.notes")}</strong>
            <div className="lec-notes-actions">
              <button className="lec-btn tiny" disabled={!session || conspectusBusy} onClick={() => void runConspectus()}>
                <Sparkles size={12} /> {conspectusBusy ? t("lecture.conspectusBusy") : t("lecture.conspectus")}
              </button>
              <button className="icon-btn" title={t("lecture.saveNotes")} disabled={!session}
                onClick={() => session && void api.lectureMarker(session.id, 0, notes.slice(0, 280))}>
                <Save size={14} />
              </button>
            </div>
          </div>
          <textarea
            className="lec-notes-area"
            placeholder={t("lecture.notesPlaceholder")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="lec-exports">
            <span className="lec-dim">{t("lecture.export")}:</span>
            {(["md", "srt", "vtt"] as const).map((f) => (
              <button key={f} className="lec-btn tiny ghost" disabled={!session}
                onClick={() => session && downloadUrl(api.lectureExportUrl(session.id, f), `lecture_${session.id}.${f}`)}>
                <Download size={12} /> {f.toUpperCase()}
              </button>
            ))}
            {session && (
              <button className="lec-btn tiny ghost" onClick={() => downloadUrl(api.lectureAudioUrl(session.id), `lecture_${session.id}.wav`)}>
                <Download size={12} /> WAV
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

