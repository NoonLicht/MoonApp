import { useState } from "react";
import { MessageCircleQuestion, X, Play, Send, ListOrdered } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Answer = Awaited<ReturnType<typeof api.lectureAsk>>;

const stamp = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

/**
 * Панель «Вопрос по записи»: ответ модели опирается на отрывки расшифровки,
 * каждый отрывок показан с таймкодом и кнопкой прослушивания этого места.
 */
export default function LectureAskPanel({
  sessionId,
  onClose,
}: {
  sessionId: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(10);
  const [missed, setMissed] = useState<string | null>(null);
  const [chapters, setChapters] = useState<Awaited<ReturnType<typeof api.lectureChapters>>["items"] | null>(null);

  const ask = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError("");
    setRes(null);
    try {
      setRes(await api.lectureAsk(sessionId, q.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const catchUp = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMissed(null);
    try {
      const r = await api.lectureMissed(sessionId, from, to);
      setMissed(r.summary || t("lecture.askPanel.missedEmpty"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadChapters = async () => {
    setError("");
    try {
      setChapters((await api.lectureChapters(sessionId)).items);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const play = async (chunkId: number | null) => {
    if (chunkId == null) return;
    try {
      const blob = await api.lectureChunkAudio(chunkId);
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="lec-panel" style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <MessageCircleQuestion size={16} />
        <strong style={{ flex: 1 }}>{t("lecture.askPanel.title")}</strong>
        <button className="lec-btn ghost icon" onClick={onClose} aria-label={t("common.close")}>
          <X size={16} />
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={q}
          placeholder={t("lecture.askPanel.placeholder")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask();
          }}
        />
        <Btn variant="primary" onClick={ask} disabled={busy || !q.trim()}>
          <Send size={14} /> {busy ? t("lecture.askPanel.thinking") : t("lecture.askPanel.ask")}
        </Btn>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
        <span className="lec-dim">{t("lecture.askPanel.missed")}</span>
        <input
          className="input"
          type="number"
          min={0}
          style={{ width: 70 }}
          value={from}
          onChange={(e) => setFrom(Number(e.target.value))}
        />
        <span>–</span>
        <input
          className="input"
          type="number"
          min={1}
          style={{ width: 70 }}
          value={to}
          onChange={(e) => setTo(Number(e.target.value))}
        />
        <span className="lec-dim">{t("lecture.askPanel.min")}</span>
        <Btn onClick={catchUp} disabled={busy || to <= from}>
          {t("lecture.askPanel.catchUp")}
        </Btn>
      </div>
      <div style={{ marginTop: 10 }}>
        <Btn icon={ListOrdered} onClick={() => void loadChapters()} disabled={busy}>
          {t("lecture.askPanel.chapters")}
        </Btn>
      </div>
      {chapters && chapters.length === 0 && (
        <div className="lec-dim">{t("lecture.askPanel.chaptersNone")}</div>
      )}
      {chapters?.map((c) => (
        <div key={c.startMs} style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 4 }}>
          <span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>{stamp(c.startMs)}</span>
          <span style={{ flex: 1 }}>{c.title}</span>
        </div>
      ))}
      {missed && <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{missed}</div>}
      {error && <div style={{ color: "var(--danger, #e66)", marginTop: 8 }}>{error}</div>}
      {res && !res.answer && <div className="lec-dim">{t("lecture.askPanel.noMatch")}</div>}
      {res?.answer && (
        <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{res.answer}</div>
      )}
      {res && res.passages.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="lec-dim">{t("lecture.askPanel.sources")}</div>
          {res.passages.map((p) => (
            <div key={p.startMs} style={{ display: "flex", gap: 8, fontSize: 12, marginTop: 4 }}>
              <button
                className="lec-btn ghost icon"
                disabled={p.chunkId == null}
                onClick={() => void play(p.chunkId)}
                aria-label={t("lecture.askPanel.play")}
              >
                <Play size={13} />
              </button>
              <span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
                {stamp(p.startMs)}
              </span>
              <span style={{ flex: 1 }}>{p.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
