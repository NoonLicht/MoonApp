import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { rsvpWords } from "@/lib/rsvp";

/**
 * Скорочтение: слова показываются по одному в одной точке экрана,
 * буква-фокус подсвечена. Скорость регулируется ползунком.
 */
export default function RsvpReader({ text }: { text: string }) {
  const { t } = useI18n();
  const [wpm, setWpm] = useState(300);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const words = useMemo(() => rsvpWords(text, wpm), [text, wpm]);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!playing || idx >= words.length) return;
    timer.current = window.setTimeout(() => setIdx((i) => i + 1), words[idx].ms);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [playing, idx, words]);

  const active = playing && idx < words.length;

  if (words.length === 0) return <div className="muted-sm">{t("myspace.tools.rsvpEmpty")}</div>;

  const w = words[Math.min(idx, words.length - 1)];
  const left = w.text.slice(0, w.orp);
  const mid = w.text.charAt(w.orp);
  const right = w.text.slice(w.orp + 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        aria-live="off"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          fontSize: 28,
          padding: "18px 8px",
          border: "1px solid var(--border, #444)",
          borderRadius: 8,
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        <span style={{ textAlign: "right" }}>{left}</span>
        <span style={{ color: "var(--accent, #e55)" }}>{mid}</span>
        <span>{right}</span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Btn
          icon={active ? Pause : Play}
          onClick={() => {
            if (idx >= words.length - 1) setIdx(0);
            setPlaying(!active);
          }}
        >
          {active ? t("myspace.tools.rsvpPause") : t("myspace.tools.rsvpPlay")}
        </Btn>
        <Btn
          variant="ghost"
          icon={RotateCcw}
          onClick={() => {
            setPlaying(false);
            setIdx(0);
          }}
        >
          {t("myspace.tools.rsvpReset")}
        </Btn>
        <span className="muted-sm" style={{ marginLeft: "auto" }}>
          {Math.min(idx + 1, words.length)} / {words.length}
        </span>
      </div>
      <label className="muted-sm" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {t("myspace.tools.rsvpSpeed", { n: wpm })}
        <input
          type="range"
          min={100}
          max={900}
          step={25}
          value={wpm}
          onChange={(e) => setWpm(Number(e.target.value))}
          style={{ flex: 1 }}
        />
      </label>
    </div>
  );
}
