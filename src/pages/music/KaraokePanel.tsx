import { useEffect, useMemo, useRef, useState } from "react";
import { Mic2 } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Lyrics = Awaited<ReturnType<typeof api.lyrics>>;

/** «Исполнитель - Название.mp3» → { artist, title }. */
function guessMeta(fileName: string): { artist: string; title: string } {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "", title: base };
}

/** Индекс звучащей строки (-1 — ещё не началась). */
function lineAt(lines: { t: number }[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Караоке: локальный аудиофайл проигрывается здесь, текст с таймкодами
 * подтягивается из открытой базы lrclib.net, текущая строка подсвечивается.
 */
export default function KaraokePanel() {
  const { t } = useI18n();
  const [src, setSrc] = useState("");
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );

  const idx = useMemo(() => (lyrics ? lineAt(lyrics.synced, now) : -1), [lyrics, now]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [idx]);

  const load = async (a = artist, ti = title, duration?: number) => {
    if (!ti.trim()) return;
    setBusy(true);
    setErr("");
    try {
      setLyrics(await api.lyrics(a, ti, duration));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (file: File) => {
    const meta = guessMeta(file.name);
    setArtist(meta.artist);
    setTitle(meta.title);
    setSrc(URL.createObjectURL(file));
    setLyrics(null);
    setNow(0);
    void load(meta.artist, meta.title);
  };

  return (
    <Glass className="p-4" style={{ marginTop: 16 }}>
      <div className="field-label">{t("music.karaoke.title")}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn icon={Mic2} onClick={() => fileRef.current?.click()}>
          {t("music.karaoke.pick")}
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pick(f);
          }}
        />
        <input
          className="input"
          placeholder={t("music.karaoke.artist")}
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
        />
        <input
          className="input"
          placeholder={t("music.karaoke.song")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Btn
          disabled={busy || !title.trim()}
          onClick={() => void load(artist, title, audioRef.current?.duration || undefined)}
        >
          {busy ? t("music.karaoke.searching") : t("music.karaoke.find")}
        </Btn>
      </div>
      {src && (
        <audio
          ref={audioRef}
          src={src}
          controls
          style={{ width: "100%", marginTop: 10 }}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
        />
      )}
      {err && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{err}</div>}
      {lyrics && lyrics.synced.length === 0 && !lyrics.plain && (
        <div className="muted-sm" style={{ marginTop: 8 }}>
          {t("music.karaoke.none")}
        </div>
      )}
      {lyrics && lyrics.synced.length > 0 && (
        <div style={{ maxHeight: 260, overflow: "auto", marginTop: 10, textAlign: "center" }}>
          {lyrics.synced.map((l, i) => (
            <div
              key={`${l.t}-${i}`}
              ref={i === idx ? activeRef : undefined}
              style={{
                padding: "3px 0",
                fontSize: i === idx ? 20 : 15,
                fontWeight: i === idx ? 700 : 400,
                opacity: i === idx ? 1 : 0.55,
                color: i === idx ? "var(--amber, #ffd166)" : undefined,
                transition: "all .2s",
              }}
            >
              {l.text || "♪"}
            </div>
          ))}
        </div>
      )}
      {lyrics && lyrics.synced.length === 0 && lyrics.plain && (
        <div style={{ maxHeight: 260, overflow: "auto", marginTop: 10, whiteSpace: "pre-wrap" }}>
          <div className="muted-sm">{t("music.karaoke.plain")}</div>
          {lyrics.plain}
        </div>
      )}
    </Glass>
  );
}
