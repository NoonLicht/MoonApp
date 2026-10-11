import { useRef, useState } from "react";
import { AudioLines, Play, Search } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Hit = Awaited<ReturnType<typeof api.voiceVaultSearch>>["items"][number];

const stamp = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/**
 * Voice Vault: «найди, где я говорил про …» по всем лекциям и быстрым
 * заметкам; найденный отрезок проигрывается прямо здесь.
 */
export default function VoiceVaultPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState("");
  const [montage, setMontage] = useState<Awaited<ReturnType<typeof api.montageBuild>> | null>(null);
  const [mBusy, setMBusy] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const run = useRef(0);

  const search = async () => {
    if (q.trim().length < 2 || busy) return;
    setBusy(true);
    setError("");
    try {
      setItems((await api.voiceVaultSearch(q.trim())).items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const makeMontage = async () => {
    if (q.trim().length < 2 || mBusy) return;
    setMBusy(true);
    setError("");
    setMontage(null);
    try {
      setMontage(await api.montageBuild(q.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMBusy(false);
    }
  };

  const stop = () => {
    run.current++;
    audio.current?.pause();
    setPlaying("");
  };

  const play = (h: Hit, key: string) => {
    stop();
    const urls = h.audioUrl ? [h.audioUrl] : h.chunkIds.map((id) => `/api/lecture/chunks/${id}/audio`);
    if (!urls.length) return;
    const my = ++run.current;
    setPlaying(key);
    const a = audio.current ?? (audio.current = new Audio());
    let i = 0;
    const next = () => {
      if (my !== run.current) return;
      if (i >= urls.length) {
        setPlaying("");
        return;
      }
      a.src = urls[i++];
      a.onended = next;
      a.onerror = () => {
        if (my === run.current) setPlaying("");
      };
      void a.play().catch(() => setPlaying(""));
    };
    next();
  };

  return (
    <div className="lec-panel">
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        <AudioLines size={14} /> {t("lecture.vault.title")}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={t("lecture.vault.placeholder")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void search()}
            />
            <Btn icon={Search} disabled={busy || q.trim().length < 2} onClick={() => void search()}>
              {t("lecture.vault.search")}
            </Btn>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn variant="ghost" disabled={mBusy || q.trim().length < 2} onClick={() => void makeMontage()}>
              {mBusy ? t("lecture.vault.montageBusy") : t("lecture.vault.montage")}
            </Btn>
            <span className="muted-sm">{t("lecture.vault.montageHint")}</span>
          </div>
          {montage && montage.id === null && <div className="muted-sm">{t("lecture.vault.montageEmpty")}</div>}
          {montage && montage.id && (
            <div className="lec-exam-card">
              <div className="muted-sm">
                {t("lecture.vault.montageTotal", { n: montage.clips.length, sec: montage.seconds })}
              </div>
              <audio controls src={`/api/montage/${montage.id}`} style={{ width: "100%" }} />
              <a className="btn" href={`/api/montage/${montage.id}`} download="montage.mp3">
                {t("lecture.vault.montageDownload")}
              </a>
              {montage.captions.map((c, i) => (
                <div key={i} className="muted-sm">
                  {c.at} · {c.title} ({c.from}) — {c.snippet}
                </div>
              ))}
            </div>
          )}
          {error && <div className="muted-sm">{error}</div>}
          {items && items.length === 0 && <div className="muted-sm">{t("lecture.vault.empty")}</div>}
          {items?.map((h) => {
            const key = `${h.kind}-${h.ref}-${h.startMs}`;
            const canPlay = !!h.audioUrl || h.chunkIds.length > 0;
            return (
              <div key={key} className="lec-exam-card">
                <div className="muted-sm">
                  {h.title}
                  {h.kind === "lecture" && ` · ${stamp(h.startMs)}`}
                </div>
                <div style={{ userSelect: "text" }}>{h.snippet}</div>
                {canPlay ? (
                  <Btn
                    icon={Play}
                    variant="ghost"
                    onClick={() => (playing === key ? stop() : play(h, key))}
                  >
                    {playing === key ? t("lecture.vault.stop") : t("lecture.vault.play")}
                  </Btn>
                ) : (
                  <span className="muted-sm">{t("lecture.vault.noAudio")}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
