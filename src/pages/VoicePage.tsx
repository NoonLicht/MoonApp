import React, { useState, useMemo, useRef } from "react";
import { Mic2, Upload, Wand2, Play, Pause, Download } from "lucide-react";
import { Glass, Btn, IconBtn, Field, Select, SectionHead } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";

const TTS_LANGS = ["English", "Spanish", "French", "German", "Japanese"];

export default function VoicePage() {
  const { t } = useI18n();
  const [sample, setSample] = useState<string | null>(null);
  const [language, setLanguage] = useState("English");
  const [voiceName, setVoiceName] = useState("Custom clone");
  const [text, setText] = useState("");
  const [exaggeration, setExaggeration] = useState(0.5);
  const [cfgWeight, setCfgWeight] = useState(0.5);
  const [state, setState] = useState("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);

  usePageToolbar(
    <>
      <Field label={t("voice.exaggeration", { v: exaggeration.toFixed(2) })} w={150}>
        <input type="range" min="0" max="1" step="0.05" value={exaggeration} onChange={(e) => setExaggeration(parseFloat(e.target.value))} />
      </Field>
      <Field label={t("voice.cfgWeight", { v: cfgWeight.toFixed(2) })} w={150}>
        <input type="range" min="0" max="1" step="0.05" value={cfgWeight} onChange={(e) => setCfgWeight(parseFloat(e.target.value))} />
      </Field>
    </>,
    [exaggeration, cfgWeight, t]
  );

  const generate = () => { if (!sample || !text.trim()) return; setState("generating"); setTimeout(() => setState("done"), 1400); };
  const bars = useMemo(() => Array.from({ length: 48 }, () => 6 + Math.random() * 26), [state]);

  return (
    <div className="page">
      <SectionHead eyebrow={t("voice.eyebrow")} title={t("voice.title")} />
      <div className="split">
        <Glass className="split-pane">
          <div className="field-label">{t("voice.sample")}</div>
          <div className={`dropzone ${sample ? "has-file" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setSample(f.name); }}>
            <input ref={inputRef} type="file" hidden accept="audio/*" onChange={(e) => e.target.files?.[0] && setSample(e.target.files[0].name)} />
            {sample ? (
              <><Mic2 size={24} strokeWidth={1.6} /><div className="dropzone-file">{sample}</div><span className="muted-sm">{t("voice.replace")}</span></>
            ) : (
              <><Upload size={24} strokeWidth={1.6} /><div>{t("voice.upload")}</div><span className="muted-sm">{t("voice.wav")}</span></>
            )}
          </div>
          <Field label={t("voice.language")}><Select value={language} onChange={(e) => setLanguage(e.target.value)} options={TTS_LANGS} /></Field>
          <Field label={t("voice.voiceName")}><input className="text-input" value={voiceName} onChange={(e) => setVoiceName(e.target.value)} /></Field>
        </Glass>

        <Glass className="split-pane">
          <div className="field-label">{t("voice.toSynth")}</div>
          <textarea className="voice-textarea" placeholder={t("voice.placeholder")} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="muted-sm" style={{ textAlign: "right" }}>{t("voice.chars", { n: text.length })}</div>
          <Btn variant="primary" icon={Wand2} style={{ width: "100%" }} onClick={generate} disabled={!sample || !text.trim() || state === "generating"}>
            {state === "generating" ? t("voice.generating") : t("voice.generate")}
          </Btn>

          <div className="player">
            <IconBtn icon={state === "done" ? Pause : Play} active={state === "done"} title={t("voice.play")} />
            <div className="waveform">{bars.map((h, i) => (<span key={i} style={{ height: `${state === "idle" ? 6 : h}px`, opacity: state === "done" ? 1 : 0.35 }} />))}</div>
            <span className="muted-sm" style={{ fontFamily: "var(--font-mono)" }}>{state === "done" ? "0:04 / 0:11" : "—:—"}</span>
            <IconBtn icon={Download} title={t("voice.downloadResult")} disabled={state !== "done"} />
          </div>
        </Glass>
      </div>
    </div>
  );
}