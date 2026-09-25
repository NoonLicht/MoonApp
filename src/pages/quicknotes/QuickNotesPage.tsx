import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2, Copy, AlertTriangle, Clock } from "lucide-react";
import { Glass, Btn, Badge, EmptyHint, SectionHead, Checkbox } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { QuickNote } from "@/api/types";

/**
 * Быстрые голосовые заметки: «наговорил идею → получил текст» одной кнопкой,
 * без полноценной сессии лекции. Использует тот же движок распознавания
 * (whisper.cpp), что и страница «Лекторий» — если модель там не установлена,
 * сервер вернёт честную ошибку с указанием, куда зайти и что поставить.
 */
export default function QuickNotesPage() {
  const { t } = useI18n();
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [keepAudio, setKeepAudio] = useState(false);
  const [error, setError] = useState("");

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
      setRecording(true);
      setRecSeconds(0);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (e) {
      setError((e as Error).message || String(e));
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
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

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="page">
      <SectionHead eyebrow={t("quickNotes.eyebrow")} title={t("quickNotes.title")} />
      <div className="muted-sm" style={{ marginBottom: 10 }}>
        {t("quickNotes.hint")}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        {!recording ? (
          <Btn variant="primary" icon={Mic} disabled={processing} onClick={() => void startRecording()}>
            {processing ? t("quickNotes.processing") : t("quickNotes.record")}
          </Btn>
        ) : (
          <Btn icon={Square} onClick={stopRecording} style={{ borderColor: "var(--coral)" }}>
            {t("quickNotes.stop")} · {fmtTime(recSeconds)}
          </Btn>
        )}
        {recording && (
          <Badge tone="coral" mono>
            ● REC
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
      {!loading && notes.length === 0 && !recording && (
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
                <button type="button" className="icon-btn" onClick={() => void copyText(n.text)}>
                  <Copy size={14} />
                </button>
                <button type="button" className="icon-btn" onClick={() => void remove(n.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{n.text || t("quickNotes.emptyText")}</div>
            {n.audioFile && (
              <audio controls src={api.quickNotesAudioUrl(n.id)} style={{ width: "100%" }} />
            )}
          </Glass>
        ))}
      </div>
    </div>
  );
}
