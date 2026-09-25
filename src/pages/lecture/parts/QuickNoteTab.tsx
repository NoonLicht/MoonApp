import { useEffect, useRef, useState } from "react";
import { Mic, Square, Pause, Play, Trash2, Copy, AlertTriangle, Clock, Sparkles } from "lucide-react";
import { Glass, Btn, Badge, EmptyHint, Checkbox } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { QuickNote } from "@/api/types";

interface Props {
  /** Готов ли движок распознавания (та же секция настроек, что у вкладки "Лекция"). */
  engineReady: boolean;
}

/**
 * Быстрые голосовые заметки — вкладка на странице «Лекторий» (раньше была
 * отдельной страницей). Настройки распознавания — общие с лекцией: тот же
 * whisper-движок/модель (server/ts/quickNotes.ts переиспользует
 * whisperEngine.findBin/findModel — единая точка настройки, см. шапку
 * страницы "Лекция" с engine.ready/engine.model).
 *
 * Расшифровка запускается только ПОСЛЕ полной остановки записи (а не по
 * кускам, как в лекции с VAD-чанками) — так и было раньше, здесь только
 * добавлена пауза/возобновление записи через нативные MediaRecorder.pause()/
 * resume() (без пересоздания потока/рекордера — пауза не рвёт запись на
 * несколько файлов).
 */
export default function QuickNoteTab({ engineReady }: Props) {
  const { t } = useI18n();
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [recState, setRecState] = useState<"idle" | "recording" | "paused">("idle");
  const [processing, setProcessing] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [keepAudio, setKeepAudio] = useState(false);
  const [error, setError] = useState("");
  const [structuringId, setStructuringId] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    setLoading(true);
    api
      .quickNotesList()
      .then(setNotes)
      .catch(() => setNotes([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  const startRecording = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        void submitRecording(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
      };
      rec.start();
      recorderRef.current = rec;
      setRecState("recording");
      setRecSeconds(0);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (e) {
      setError((e as Error).message || String(e));
    }
  };

  const pauseRecording = () => {
    recorderRef.current?.pause();
    setRecState("paused");
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const resumeRecording = () => {
    recorderRef.current?.resume();
    setRecState("recording");
    timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecState("idle");
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const submitRecording = async (blob: Blob) => {
    setProcessing(true);
    setError("");
    try {
      const ext = blob.type.includes("ogg") ? ".ogg" : blob.type.includes("mp4") ? ".mp4" : ".webm";
      const file = new File([blob], `note${ext}`, { type: blob.type });
      await api.quickNotesCreate(file, keepAudio);
      load();
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setProcessing(false);
    }
  };

  const remove = async (id: string) => {
    await api.quickNotesDelete(id);
    load();
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const structure = async (id: string) => {
    setStructuringId(id);
    setError("");
    try {
      const updated = await api.quickNotesStructure(id);
      setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)));
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setStructuringId(null);
    }
  };

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="lec-quicknote-tab">
      {!engineReady && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)", marginBottom: 10 }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{t("quickNotes.engineMissingHint")}</span>
        </Glass>
      )}
      <div className="muted-sm" style={{ marginBottom: 10 }}>
        {t("quickNotes.hint")}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        {recState === "idle" && (
          <Btn variant="primary" icon={Mic} disabled={processing} onClick={() => void startRecording()}>
            {processing ? t("quickNotes.processing") : t("quickNotes.record")}
          </Btn>
        )}
        {recState === "recording" && (
          <>
            <Btn icon={Pause} onClick={pauseRecording}>
              {t("quickNotes.pause")} · {fmtTime(recSeconds)}
            </Btn>
            <Btn icon={Square} onClick={stopRecording} style={{ borderColor: "var(--coral)" }}>
              {t("quickNotes.stop")}
            </Btn>
          </>
        )}
        {recState === "paused" && (
          <>
            <Btn icon={Play} onClick={resumeRecording}>
              {t("quickNotes.resume")} · {fmtTime(recSeconds)}
            </Btn>
            <Btn icon={Square} onClick={stopRecording} style={{ borderColor: "var(--coral)" }}>
              {t("quickNotes.stop")}
            </Btn>
          </>
        )}
        {recState !== "idle" && (
          <Badge tone={recState === "recording" ? "coral" : "neutral"} mono>
            {recState === "recording" ? "● REC" : "❚❚ " + t("quickNotes.paused")}
          </Badge>
        )}
        <label
          className="muted-sm"
          style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        >
          <Checkbox checked={keepAudio} onClick={() => setKeepAudio((v) => !v)} />
          {t("quickNotes.keepAudio")}
        </label>
      </div>

      {error && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{error}</span>
        </Glass>
      )}

      {loading && <div className="muted-sm">{t("passwordVault.loading")}</div>}
      {!loading && notes.length === 0 && recState === "idle" && (
        <EmptyHint icon={Mic} text={t("quickNotes.empty")} />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {notes.map((n) => (
          <Glass key={n.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Clock size={12} />
                {new Date(n.createdAt).toLocaleString()}
                {n.durationSec != null ? ` · ${n.durationSec.toFixed(1)} s` : ""}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("quickNotes.structure")}
                  disabled={structuringId === n.id || !n.text.trim()}
                  onClick={() => void structure(n.id)}
                >
                  <Sparkles size={14} className={structuringId === n.id ? "spin" : ""} />
                </button>
                <button type="button" className="icon-btn" onClick={() => void copyText(n.structuredText || n.text)}>
                  <Copy size={14} />
                </button>
                <button type="button" className="icon-btn" onClick={() => void remove(n.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{n.text || t("quickNotes.emptyText")}</div>
            {n.structuredText && (
              <div className="lec-quicknote-structured">
                <div className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <Sparkles size={11} /> {t("quickNotes.structuredLabel")}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{n.structuredText}</div>
              </div>
            )}
            {n.audioFile && (
              <audio controls src={api.quickNotesAudioUrl(n.id)} style={{ width: "100%" }} />
            )}
          </Glass>
        ))}
      </div>
    </div>
  );
}
