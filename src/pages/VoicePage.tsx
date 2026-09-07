import React, { useState, useEffect, useMemo, useRef } from "react";
import { Mic2, Upload, Wand2, Download, Save, Trash2, Copy, BookOpen, RefreshCw } from "lucide-react";
import { Glass, Btn, IconBtn, Field, Select, Badge, SectionHead, ProgressBar, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { useContextMenu, copyToClipboard } from "../components/ContextMenu";
import { api } from "../api/client";
import type { TtsProfile, TtsEngine } from "../api/client";

/**
 * F5-TTS Studio: zero-shot клонирование голоса и генерация аудиокниг.
 *
 * Как это работает:
 *  - Левая панель: референс аудио (5–10 сек wav/mp3), язык, профили голоса
 *    (сохраняются на сервере — 1-click перезагрузка параметров).
 *  - Тулбар: гиперпараметры F5-TTS — exaggeration (0.5–2.0) и CFG (1.5–4.5),
 *    дефолты из настроек voice.*.
 *  - Правая панель: текст/импорт .txt, счётчик символов и чанков (~250),
 *    кнопка генерации; прогресс по чанкам с сервера.
 *  - Пайплайн сервера: инференс по чанкам → кроссфейд 50 мс → EBU R128.
 *  - Контекстные меню: референс, профили, результат (copy/save/delete...).
 */

const TTS_LANGS = ["English", "Russian", "Chinese", "Spanish", "French", "German", "Japanese"];

export default function VoicePage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [sample, setSample] = useState<File | null>(null);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const [language, setLanguage] = useState("English");
  const [voiceName, setVoiceName] = useState("Custom clone");
  const [text, setText] = useState("");
  const [exaggeration, setExaggeration] = useState(1.0);
  const [cfgWeight, setCfgWeight] = useState(2.0);
  const [job, setJob] = useState<{ id: string; stage: string; progress: number; chunkIndex: number; chunksTotal: number; error: string; done: boolean } | null>(null);
  const [profiles, setProfiles] = useState<TtsProfile[]>([]);
  const [engineInfo, setEngineInfo] = useState<TtsEngine | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // С1: референс грузится на сервер отдельным шагом, дальше оперируем только
  // именем ref_* файла (путь не покидает сервер).
  const [refFile, setRefFile] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);
  const bookRef = useRef<HTMLInputElement | null>(null);

  // Дефолты из настроек + статус движка + сохранённые профили.
  useEffect(() => {
    api.getSettings().then((s: any) => {
      const v = s?.voice;
      if (v) {
        if (typeof v.defaultLanguage === "string" && v.defaultLanguage) setLanguage(v.defaultLanguage);
        if (typeof v.exaggeration === "number") setExaggeration(v.exaggeration);
        if (typeof v.cfgWeight === "number") setCfgWeight(v.cfgWeight);
      }
    }).catch(() => { /* дефолты из кода */ });
    api.ttsEngine().then(setEngineInfo).catch(() => {});
    api.ttsProfiles().then(setProfiles).catch(() => {});
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  usePageToolbar(
    <>
      <Field label={t("voice.exaggeration", { v: exaggeration.toFixed(2) })} w={150}>
        <input type="range" min="0.5" max="2" step="0.05" value={exaggeration} onChange={(e) => setExaggeration(parseFloat(e.target.value))} />
      </Field>
      <Field label={t("voice.cfgWeight", { v: cfgWeight.toFixed(2) })} w={150}>
        <input type="range" min="1.5" max="4.5" step="0.05" value={cfgWeight} onChange={(e) => setCfgWeight(parseFloat(e.target.value))} />
      </Field>
    </>,
    [exaggeration, cfgWeight, t]
  );

  const pick = (f: File | null) => {
    setSample(f);
    if (sampleUrl) URL.revokeObjectURL(sampleUrl);
    setSampleUrl(f ? URL.createObjectURL(f) : null);
    setRefFile("");
    // Сразу отправляем референс на сервер: имя ref_* нужно и для генерации,
    // и для сохранения профиля.
    if (f) api.ttsUploadReference(f).then((r) => setRefFile(r.refFile)).catch(() => {});
  };

  // Импорт книги: .txt/.md как текст; .epub распаковывается на сервере
  // (adm-zip): текст достаётся из (X)HTML-документов внутри архива.
  const importBook = async (f: File | null) => {
    if (!f) return;
    if (/\.(txt|md)$/i.test(f.name)) {
      const r = new FileReader();
      r.onload = () => setText(String(r.result || "").slice(0, 500000));
      r.readAsText(f);
    } else if (/\.epub$/i.test(f.name)) {
      try {
        const r = await api.ttsImportEpub(f);
        setText(r.text.slice(0, 500000));
      } catch { /* статус импорта виден по счётчику символов */ }
    }
  };

  // Оценка чанков для UI (~250 символов, как в чанкере сервера).
  const chunksEstimate = useMemo(() => (text.trim() ? Math.max(1, Math.ceil(text.trim().length / 250)) : 0), [text]);

  const saveProfile = async () => {
    if (!refFile) return; // профиль без загруженного референса бессмысленен
    try {
      await api.ttsSaveProfile({ name: voiceName || sample?.name || "voice", refFile, language, exaggeration, cfgWeight });
      api.ttsProfiles().then(setProfiles).catch(() => {});
    } catch { /* профиль не критичен */ }
  };

  // 1-click применение профиля: референс/язык/гиперпараметры подставляются.
  const applyProfile = (p: TtsProfile) => {
    setVoiceName(p.name);
    if (p.language) setLanguage(p.language);
    setExaggeration(p.exaggeration); setCfgWeight(p.cfgWeight);
    if (p.refFile) setRefFile(p.refFile);
  };

  const generate = async () => {
    if (!refFile || !text.trim()) return;
    try {
      const j = await api.ttsStart(refFile, { text, language, exaggeration, cfgWeight, format: "mp3" });
      setJob(j); setResultUrl(null);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await api.ttsStatus(j.id);
          setJob(s);
          if (s.done || s.stage === "error") {
            window.clearInterval(pollRef.current!); pollRef.current = null;
            if (s.done) {
              const { blob } = await api.ttsDownload(j.id);
              setResultUrl(URL.createObjectURL(blob));
            }
          }
        } catch { /* повтор на следующем тике */ }
      }, 1500);
    } catch (e: any) {
      setJob({ id: "", stage: "error", progress: 0, chunkIndex: 0, chunksTotal: 0, error: String(e.message || e), done: false });
    }
  };

  const busy = !!job && !job.done && job.stage !== "error";

  // Визуализатор (waveform) результата: реальные амплитуды через WebAudio,
  // а не случайные столбики.
  const [wave, setWave] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!resultUrl) { setWave([]); return; }
    fetch(resultUrl).then((r) => r.arrayBuffer()).then((ab) => {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      return ctx.decodeAudioData(ab).then((audio: AudioBuffer) => {
        ctx.close();
        if (cancelled) return;
        const data = audio.getChannelData(0);
        const n = 64, block = Math.floor(data.length / n) || 1;
        const peaks: number[] = [];
        for (let i = 0; i < n; i++) {
          let peak = 0;
          for (let j = 0; j < block; j += 32) peak = Math.max(peak, Math.abs(data[i * block + j] || 0));
          peaks.push(Math.max(6, Math.min(34, peak * 40)));
        }
        setWave(peaks);
      });
    }).catch(() => { /* визуализатор не критичен */ });
    return () => { cancelled = true; };
  }, [resultUrl]);

  // Скачивание готовой аудиокниги: blob с сервера → ссылка → клик.
  const downloadResult = async () => {
    if (!job) return;
    try {
      const { blob, name } = await api.ttsDownload(job.id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
    } catch { /* статус уже показан в UI */ }
  };
  return (
    <div className="page">
      <SectionHead eyebrow={t("voice.eyebrow")} title={t("voice.title")}
        action={engineInfo && !engineInfo.ok ? <Badge tone="coral">{t("voice.f5Missing")}</Badge> : <Badge tone="teal">{t("voice.f5Ready")}</Badge>} />
      <div className="split">
        {/* --- Левая панель: источник голоса --- */}
        <Glass className="split-pane">
          <div className="field-label">{t("voice.sample")}</div>
          <div className={`dropzone ${sample ? "has-file" : ""}`} onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0] || null); }}
            onContextMenu={(e) => menu.open(e, [
              sample && { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(sample.name) },
              sample && { label: t("voice.replace"), icon: RefreshCw, onClick: () => inputRef.current?.click() },
              { separator: true },
              { label: t("voice.upload"), icon: Upload, onClick: () => inputRef.current?.click() },
            ])}>
            <input ref={inputRef} type="file" hidden accept="audio/*"
              onChange={(e) => pick(e.target.files?.[0] || null)} />
            {sample ? (
              <><Mic2 size={24} strokeWidth={1.6} /><div className="dropzone-file">{sample.name}</div><span className="muted-sm">{t("voice.replace")}</span></>
            ) : (
              <><Upload size={24} strokeWidth={1.6} /><div>{t("voice.upload")}</div><span className="muted-sm">{t("voice.wav")}</span></>
            )}
          </div>
          {sampleUrl && <audio src={sampleUrl} controls style={{ width: "100%", marginTop: 8 }} />}
          <Field label={t("voice.language")}><Select value={language} onChange={(e) => setLanguage(e.target.value)} options={TTS_LANGS} /></Field>
          <Field label={t("voice.voiceName")}>
            <div style={{ display: "flex", gap: 6 }}>
              <input className="text-input" value={voiceName} onChange={(e) => setVoiceName(e.target.value)} style={{ flex: 1 }} />
              <IconBtn icon={Save} title={t("voice.saveProfile")} onClick={saveProfile} />
            </div>
          </Field>

          {/* Профили голоса: клик — применить, правый клик — меню */}
          {profiles.length > 0 && (
            <div className="task-list" style={{ marginTop: 8 }}>
              {profiles.map((p) => (
                <Glass key={p.id} className="task-row"
                  onClick={() => applyProfile(p)}
                  onContextMenu={(e) => menu.open(e, [
                    { label: t("voice.applyProfile"), icon: Mic2, onClick: () => applyProfile(p) },
                    { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(p.name) },
                    { separator: true },
                    { label: t("ctx.del"), icon: Trash2, danger: true, onClick: async () => { await api.ttsDeleteProfile(p.id); api.ttsProfiles().then(setProfiles).catch(() => {}); } },
                  ])}>
                  <Mic2 size={14} />
                  <span className="task-text">{p.name}</span>
                  <span className="muted-sm">{p.language}</span>
                  <IconBtn icon={Trash2} size={12} title={t("ctx.del")}
                    onClick={async () => { await api.ttsDeleteProfile(p.id); api.ttsProfiles().then(setProfiles).catch(() => {}); }} />
                </Glass>
              ))}
            </div>
          )}
        </Glass>

        {/* --- Правая панель: текст, генерация, плеер --- */}
        <Glass className="split-pane">
          <div className="field-label">{t("voice.toSynth")}</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <Btn icon={BookOpen} onClick={() => bookRef.current?.click()}>{t("voice.importBook")}</Btn>
            <input ref={bookRef} type="file" hidden accept=".txt,.md,.epub" onChange={(e) => importBook(e.target.files?.[0] || null)} />
          </div>
          <textarea className="voice-textarea" placeholder={t("voice.placeholder")} value={text} onChange={(e) => setText(e.target.value)}
            onContextMenu={(e) => menu.open(e, [
              text.length > 0 && { label: t("ctx.copy"), icon: Copy, onClick: () => copyToClipboard(text) },
              text.length > 0 && { label: t("ctx.clear"), icon: Trash2, onClick: () => setText("") },
            ])} />
          <div className="muted-sm" style={{ textAlign: "right" }}>
            {t("voice.chars", { n: text.length })} · {t("voice.chunks", { n: chunksEstimate })}
          </div>
          <Btn variant="primary" icon={Wand2} style={{ width: "100%" }} onClick={generate}
            disabled={!sample || !text.trim() || busy}>
            {busy ? t("voice.generating") : t("voice.generate")}
          </Btn>

          {busy && job && (
            <div style={{ marginTop: 10 }}>
              <div className="muted-sm" style={{ marginBottom: 6 }}>
                {t("voice.chunkProgress", { i: job.chunkIndex + 1, n: job.chunksTotal })}
              </div>
              <ProgressBar value={job.progress} />
            </div>
          )}

          {job?.stage === "error" && (
            <div style={{ color: "var(--coral)", marginTop: 8 }} className="muted-sm">
              {job.error === "f5_not_installed" ? t("voice.f5MissingHint") : `Error: ${job.error}`}
            </div>
          )}

          <div className="player" style={{ marginTop: 10 }}>
            <audio src={resultUrl || undefined} controls style={{ width: "100%" }} />
            {wave.length > 0 && (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40, marginTop: 6, opacity: 0.8 }}>
                {wave.map((h, i) => (
                  <div key={i} style={{ width: 4, height: h, borderRadius: 2, background: "var(--accent, #eab308)" }} />
                ))}
              </div>
            )}
          </div>
          {resultUrl && job && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}
              onContextMenu={(e) => menu.open(e, [
                { label: t("voice.downloadResult"), icon: Download, onClick: () => downloadResult() },
                { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(voiceName) },
                { separator: true },
                { label: t("voice.reRender"), icon: RefreshCw, onClick: generate },
              ])}>
              <Btn variant="primary" icon={Download} onClick={downloadResult}>{t("voice.downloadResult")}</Btn>
              <Btn icon={RefreshCw} onClick={generate}>{t("voice.reRender")}</Btn>
            </div>
          )}
        </Glass>
      </div>
    </div>
  );
}