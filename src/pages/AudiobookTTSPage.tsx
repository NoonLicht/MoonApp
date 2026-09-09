import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Upload, Wand2, Download, Save, Trash2, Copy, RefreshCw, BookOpen, Cpu,
  ChevronDown, ChevronUp, Zap, Heart, SplitSquareHorizontal, Merge, ArrowUp,
  ArrowDown, Pause, FolderOpen, ListMusic, FileText, Layers,
} from "lucide-react";
import { Glass, Btn, IconBtn, Field, Select, Badge, SectionHead, ProgressBar, EmptyHint, Checkbox } from "../components/ui";
import { ParamField } from "../components/ParamField";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { useContextMenu, copyToClipboard } from "../components/ContextMenu";
import { api } from "../api/client";
import type { TtsProfile, TtsPreset, TtsHardware, TtsBook, TtsBookChapter, TtsChunk, TtsJob } from "../api/client";

/**
 * AudiobookTTSPage: полная студия аудиокниг на двух движках (F5-TTS и
 * Coqui XTTS v2) с универсальным импортом книг (epub/fb2/pdf/mobi/rtf/txt),
 * русским NLP (ёфикация, числа, ударения), интерактивным Batch-редактором,
 * аппаратно-адаптивными бейджами [Optimal] и тултипами (i) у каждого параметра,
 * VRAM-монитором в реальном времени и M4B/MP3-экспортом с главами.
 */

type EngineId = "f5" | "xtts";
type Params = Record<string, any>;

const DEFAULT_PARAMS: Params = {
  mode: "express",
  precision: "float16", attention: "sdpa", gcEveryChunks: 1,
  nfe: 36, cfg: 2.2, solver: "euler", exaggeration: 1.0,
  temperature: 0.7, repetitionPenalty: 3.5, topK: 50, topP: 0.85,
  speed: 1.0, crossFadeMs: 60, sentencePauseMs: 400, paragraphPauseMs: 1200,
  loudnessTarget: -16, format: "m4b", language: "Russian",
  expandNumbers: true, yoficate: true, markStress: true, chunkLimit: 380,
};

const ACCEPT = ".epub,.fb2,.zip,.pdf,.mobi,.azw3,.rtf,.txt,.md";
const TTS_LANGS = ["Russian", "English", "Chinese", "Spanish", "French", "German", "Japanese"];

export default function AudiobookTTSPage() {
  const { t } = useI18n();
  const menu = useContextMenu();

  // --- Железо, пресеты, профили ---
  const [hw, setHw] = useState<TtsHardware | null>(null);
  const [presets, setPresets] = useState<TtsPreset[]>([]);
  const [profiles, setProfiles] = useState<TtsProfile[]>([]);
  const [presetName, setPresetName] = useState("");

  // --- Книга и структура ---
  const [book, setBook] = useState<TtsBook | null>(null);
  const [chapterIdx, setChapterIdx] = useState(0);
  const [rawText, setRawText] = useState("");

  // --- Движок и параметры ---
  const [engine, setEngine] = useState<EngineId>("f5");
  const [params, setParams] = useState<Params>({ ...DEFAULT_PARAMS });
  const setP = (k: string, v: any) => setParams((p) => ({ ...p, [k]: v }));

  // --- Batch editor ---
  const [chunks, setChunks] = useState<TtsChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);

  // --- Генерация ---
  const [job, setJob] = useState<TtsJob | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultName, setResultName] = useState("audiobook.mp3");
  const pollRef = useRef<number | null>(null);
  const resultUrlRef = useRef<string | null>(null);

  // --- Референс ---
  const [refFile, setRefFile] = useState("");
  const [sampleName, setSampleName] = useState("");
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("Voice 1");
  const refInputRef = useRef<HTMLInputElement | null>(null);
  const bookInputRef = useRef<HTMLInputElement | null>(null);

  // --- Правая панель ---
  const [proOpen, setProOpen] = useState(false);
  const [centerTab, setCenterTab] = useState<"book" | "batch">("book");
  const [openAcc, setOpenAcc] = useState<Record<string, boolean>>({ vram: true, f5: true, xtts: true, nlp: true, post: true, ref: false });

  const busy = !!job && !job.done && job.stage !== "error";
  const optimal = hw?.optimal || {};

  const reloadPresets = useCallback(() => { api.ttsPresets().then(setPresets).catch(() => {}); }, []);

  // Стартовая загрузка: железо (VRAM/бейджи), пресеты, профили.
  useEffect(() => {
    api.ttsHardware().then((h) => { setHw(h); if (h.optimal?.precision) setP("precision", h.optimal.precision); }).catch(() => {});
    reloadPresets();
    api.ttsProfiles().then(setProfiles).catch(() => {});
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [reloadPresets]);

  // VRAM-монитор в реальном времени (2 сек) — только во время генерации.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => { api.ttsHardware().then(setHw).catch(() => {}); }, 2000);
    return () => window.clearInterval(id);
  }, [busy]);

  /* ------------------------- Импорт книги ------------------------- */

  const importBook = async (f: File | null) => {
    if (!f) return;
    try {
      if (/\.(txt|md)$/i.test(f.name)) {
        const text = await f.text();
        setBook({ title: f.name.replace(/\.\w+$/, ""), author: "", coverImage: null, chapters: [{ title: f.name, text }] });
        setRawText(text.slice(0, 900000));
        setChapterIdx(0);
      } else {
        const b = await api.ttsImportBook(f);
        setBook(b);
        setRawText(b.chapters.map((c) => c.text).join("\n\n").slice(0, 900000));
        setChapterIdx(0);
      }
      setChunks([]); // пересобираются вручную кнопкой или при генерации
    } catch { /* счётчик чанков покажет пустоту */ }
  };

  /* ------------------------- Референс ------------------------- */

  const pickRef = async (f: File | null) => {
    if (!f) return;
    setSampleName(f.name);
    setSampleUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
    try {
      const r = await api.ttsUploadReference(f);
      setRefFile(r.refFile);
    } catch { /* покажется при генерации */ }
  };

  const saveProfile = async () => {
    if (!refFile) return;
    try {
      await api.ttsSaveProfile({ name: profileName || sampleName || "voice", refFile, engine, language: params.language });
      api.ttsProfiles().then(setProfiles).catch(() => {});
    } catch { /* не критично */ }
  };

  const applyProfile = (p: TtsProfile) => {
    setProfileName(p.name);
    if (p.refFile) setRefFile(p.refFile);
    if (p.engine) setEngine(p.engine);
    if (p.language) setP("language", p.language);
  };

  /* ------------------------- Пресеты ------------------------- */

  const applyPreset = (p: TtsPreset) => {
    setEngine(p.engine);
    setParams((old) => ({ ...old, ...p.params, mode: "express" }));
    if (p.refFile) setRefFile(p.refFile);
  };

  const savePreset = async () => {
    try {
      await api.ttsSavePreset({ name: presetName || "Мой пресет", engine, params: { ...params, mode: undefined }, refFile });
      setPresetName("");
      reloadPresets();
    } catch { /* не критично */ }
  };

  /* ------------------------- Batch editor ------------------------- */

  const rebuildChunks = async () => {
    const text = rawText.trim();
    if (!text) { setChunks([]); return; }
    setChunksLoading(true);
    try {
      const r = await api.ttsPreviewChunks(text, engine, {
        expandNumbers: params.expandNumbers, yoficate: params.yoficate, markStress: params.markStress,
      });
      setChunks(r.chunks || []);
    } catch { setChunks([]); }
    setChunksLoading(false);
  };

  const mergeWithNext = (i: number) => {
    setChunks((cs) => {
      if (i + 1 >= cs.length) return cs;
      const a = cs[i], b = cs[i + 1];
      const merged: TtsChunk = { text: [a.text, b.text].filter(Boolean).join(" "), pauseMs: b.pauseMs };
      return [...cs.slice(0, i), merged, ...cs.slice(i + 2)];
    });
  };

  const splitChunk = (i: number) => {
    setChunks((cs) => {
      const c = cs[i];
      if (!c.text) return cs;
      const mid = c.text.lastIndexOf(" ", Math.ceil(c.text.length / 2));
      if (mid <= 0) return cs;
      const a = { text: c.text.slice(0, mid).trim() };
      const b = { text: c.text.slice(mid + 1).trim(), pauseMs: c.pauseMs };
      return [...cs.slice(0, i), a, b, ...cs.slice(i + 1)];
    });
  };

  const moveChunk = (i: number, dir: -1 | 1) => {
    setChunks((cs) => {
      const j = i + dir;
      if (j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const addPause = (i: number) => {
    setChunks((cs) => [...cs.slice(0, i + 1), { pauseMs: 500 }, ...cs.slice(i + 1)]);
  };

  const editChunkText = (i: number, text: string) => {
    setChunks((cs) => cs.map((c, k) => (k === i ? { ...c, text } : c)));
  };

  /* ------------------------- Генерация ------------------------- */

  const generate = async () => {
    if (!refFile) return;
    const useChunks = chunks.length ? chunks : undefined;
    try {
      const j = await api.ttsStart({
        refFile, engine, chunks: useChunks, text: useChunks ? undefined : rawText,
        ...params, mode: undefined,
        title: book?.title || "Audiobook", author: book?.author || "",
        coverImage: book?.coverImage || null,
      });
      setJob(j);
      if (resultUrlRef.current) { URL.revokeObjectURL(resultUrlRef.current); resultUrlRef.current = null; }
      setResultUrl(null);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await api.ttsStatus(j.id);
          setJob(s);
          if (s.done || s.stage === "error") {
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            if (s.done) {
              const { blob, name } = await api.ttsDownload(j.id);
              const url = URL.createObjectURL(blob);
              resultUrlRef.current = url;
              setResultUrl(url);
              setResultName(name);
            }
          }
        } catch { /* повтор на следующем тике */ }
      }, 1500);
    } catch (e: any) {
      setJob({ id: "", engine, stage: "error", progress: 0, chunkIndex: 0, chunksTotal: 0, error: String(e?.message || e), done: false, outSize: 0 });
    }
  };

  const downloadResult = async () => {
    if (!job?.done) return;
    try {
      const { blob, name } = await api.ttsDownload(job.id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
    } catch { /* уже показано в UI */ }
  };

  /* ------------------------- Подкомпоненты ------------------------- */

  const Accordion = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
    <div className="ab-acc">
      <button className="ab-acc-head" onClick={() => setOpenAcc((o) => ({ ...o, [id]: !o[id] }))}>
        {openAcc[id] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        <span>{title}</span>
      </button>
      {openAcc[id] && <div className="ab-acc-body">{children}</div>}
    </div>
  );

  // Slider/Select/Toggle Pro-панели; Smart Express блокирует ручные значения.
  const ProSlider = ({ p, label, tip, opt, min, max, step, fmt }: {
    p: string; label: string; tip: string; opt?: string;
    min: number; max: number; step: number; fmt?: (v: number) => string;
  }) => (
    <ParamField label={`${label} — ${fmt ? fmt(Number(params[p])) : params[p]}`} tooltip={tip} optimal={opt}>
      <input type="range" min={min} max={max} step={step} value={Number(params[p])} disabled={params.mode === "express"}
        onChange={(e) => setP(p, parseFloat(e.target.value))} />
    </ParamField>
  );

  const ProSelect = ({ p, label, tip, opt, options }: {
    p: string; label: string; tip: string; opt?: string;
    options: { value: string; label: string }[];
  }) => (
    <ParamField label={label} tooltip={tip} optimal={opt}>
      <Select value={String(params[p])} onChange={(e) => setP(p, e.target.value)} options={options} />
    </ParamField>
  );

  const ProToggle = ({ p, label, tip }: { p: string; label: string; tip: string }) => (
    <ParamField label={label} tooltip={tip}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Checkbox checked={!!params[p]} onClick={() => setP(p, !params[p])} />
        <span className="muted-sm">{params[p] ? "On" : "Off"}</span>
      </div>
    </ParamField>
  );

  const vramPct = hw?.gpu?.vramTotalGb ? Math.min(100, Math.round((hw.gpu.vramUsedGb / hw.gpu.vramTotalGb) * 100)) : 0;

  /* ------------------------- Тулбар ------------------------- */

  usePageToolbar(
    <>
      <Field label={t("ab.expressMode")} w={160}>
        <Checkbox checked={params.mode === "express"} onClick={() => {
          const next = params.mode === "express" ? "pro" : "express";
          if (next === "express") {
            setParams((p) => ({ ...p, mode: "express", ...(optimal.precision ? { precision: optimal.precision } : {}) }));
          } else setParams((p) => ({ ...p, mode: next }));
        }} />
      </Field>
    </>,
    [params.mode, optimal.precision, t]
  );

  return (
    <div className="page page-ab">
      <SectionHead eyebrow={t("ab.eyebrow")} title={t("ab.title")}
        action={
          <Badge tone={busy ? "amber" : job?.done ? "teal" : "neutral"} mono>
            {busy ? t("ab.statusBusy", { i: (job?.chunkIndex || 0) + 1, n: job?.chunksTotal || 0 })
              : job?.done ? t("ab.statusDone") : t("ab.statusIdle")}
          </Badge>
        } />

      {/* --- Пресеты --- */}
      <div className="ab-presets">
        {presets.map((p) => (
          <Glass key={p.id} className="ab-preset" onClick={() => applyPreset(p)}
            onContextMenu={(e) => menu.open(e, [
              { label: t("ab.applyPreset"), icon: Wand2, onClick: () => applyPreset(p) },
              { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(p.name) },
              ...(!p.builtin ? [{ separator: true }, { label: t("ctx.del"), icon: Trash2, danger: true, onClick: async () => { await api.ttsDeletePreset(p.id); reloadPresets(); } }] : []),
            ] as any)}>
            {p.engine === "f5" ? <Zap size={13} /> : <Heart size={13} />}
            <span className="ab-preset-name">{p.name}</span>
            {p.builtin && <Badge tone="teal">SYS</Badge>}
          </Glass>
        ))}
        <Glass className="ab-preset">
          <input className="text-input" placeholder={t("ab.presetName")} value={presetName}
            onChange={(e) => setPresetName(e.target.value)} style={{ width: 130 }} />
          <IconBtn icon={Save} title={t("ab.savePreset")} onClick={savePreset} />
        </Glass>
      </div>

      <div className="ab-layout">
        {/* --- Левая панель --- */}
        <div className="ab-col" id="ab-left">
          <Glass className="split-pane">
            <div className="field-label">{t("ab.bookFile")}</div>
            <div className="dropzone" onClick={() => bookInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); importBook(e.dataTransfer.files?.[0] || null); }}
              onContextMenu={(e) => menu.open(e, [
                { label: t("ab.importBook"), icon: Upload, onClick: () => bookInputRef.current?.click() },
                ...(book ? [{ label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(book.title) }] : []),
              ] as any)}>
              <input ref={bookInputRef} type="file" hidden accept={ACCEPT}
                onChange={(e) => importBook(e.target.files?.[0] || null)} />
              {book ? (
                <><BookOpen size={22} strokeWidth={1.6} /><div className="dropzone-file">{book.title}</div>
                  <span className="muted-sm">{t("ab.chapters", { n: book.chapters.length })} · {String(book.format || "").toUpperCase()}</span></>
              ) : (
                <><Upload size={22} strokeWidth={1.6} /><div>{t("ab.dropBook")}</div>
                  <span className="muted-sm">epub · fb2 · pdf · mobi · rtf · txt</span></>
              )}
            </div>

            <div className="field-label" style={{ marginTop: 10 }}>{t("ab.engine")}</div>
            <div className="ab-engines">
              <div className={`ab-engine ${engine === "f5" ? "is-active" : ""}`} role="button" tabIndex={0}
                onClick={() => setEngine("f5")} onKeyDown={(e) => e.key === "Enter" && setEngine("f5")}>
                <Zap size={15} /><b>F5-TTS</b>
                <span className="muted-sm">{t("ab.f5Desc")}</span>
                <span className="ab-tab-badge">~3.8 GB · {t("ab.nonFiction")}</span>
              </div>
              <div className={`ab-engine ${engine === "xtts" ? "is-active" : ""}`} role="button" tabIndex={0}
                onClick={() => setEngine("xtts")} onKeyDown={(e) => e.key === "Enter" && setEngine("xtts")}>
                <Heart size={15} /><b>Coqui XTTS v2</b>
                <span className="muted-sm">{t("ab.xttsDesc")}</span>
                <span className="ab-tab-badge ab-tab-badge-amber">~4.5 GB · {t("ab.fiction")}</span>
              </div>
            </div>

            <div className="field-label" style={{ marginTop: 10 }}>{t("ab.reference")}</div>
            <div className="ab-ref-row">
              <Btn icon={Upload} onClick={() => refInputRef.current?.click()}>{t("ab.uploadRef")}</Btn>
              <input ref={refInputRef} type="file" hidden accept="audio/*" onChange={(e) => pickRef(e.target.files?.[0] || null)} />
              <input className="text-input" value={profileName} onChange={(e) => setProfileName(e.target.value)} style={{ flex: 1 }} />
              <IconBtn icon={Save} title={t("ab.saveProfile")} onClick={saveProfile} />
            </div>
            {sampleUrl && <audio src={sampleUrl} controls style={{ width: "100%", marginTop: 6 }} />}
            {profiles.length > 0 && (
              <div className="task-list" style={{ marginTop: 8 }}>
                {profiles.map((p) => (
                  <Glass key={p.id} className="task-row" onClick={() => applyProfile(p)}
                    onContextMenu={(e) => menu.open(e, [
                      { label: t("ab.applyProfile"), icon: Heart, onClick: () => applyProfile(p) },
                      { separator: true },
                      { label: t("ctx.del"), icon: Trash2, danger: true, onClick: async () => { await api.ttsDeleteProfile(p.id); api.ttsProfiles().then(setProfiles).catch(() => {}); } },
                    ] as any)}>
                    <Heart size={13} /><span className="task-text">{p.name}</span>
                    <span className="muted-sm">{p.engine === "xtts" ? "XTTS" : "F5"}</span>
                    <IconBtn icon={Trash2} size={12} title={t("ctx.del")}
                      onClick={async () => { await api.ttsDeleteProfile(p.id); api.ttsProfiles().then(setProfiles).catch(() => {}); }} />
                  </Glass>
                ))}
              </div>
            )}
          </Glass>

          {/* VRAM / GPU монитор — компактная строка */}
          <Glass className="split-pane ab-vram">
            <div className="ab-vram-head">
              <Cpu size={13} />
              <span className="muted-sm" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {hw?.gpu?.found ? `${hw.gpu.name} · ${t("ab.vramUsage", { used: hw.gpu.vramUsedGb.toFixed(1), total: hw.gpu.vramTotalGb.toFixed(1) })} · CUDA ${hw.gpu.utilPct}%`
                  : t("ab.gpuNotFound")}
              </span>
              {hw?.optimal?.precision && <span className="ab-tab-badge">{String(hw.optimal.precision).toUpperCase()}</span>}
            </div>
            {hw?.gpu?.found && <ProgressBar value={vramPct} />}
            {job?.vram && job.vram.usedGb > (job.vram.totalGb || 8) * 0.9 && (
              <div className="muted-sm" style={{ color: "var(--coral)" }}>⚠ {t("ab.vramSpike")} · {job.vram.usedGb.toFixed(1)} GB</div>
            )}
          </Glass>
        </div>

        {/* --- Центр: вкладки «Структура книги» / «Batch-редактор» --- */}
        <div className="ab-col ab-center">
          <Glass className="split-pane ab-center-tabs">
            <div className="ab-tabs">
              <button className={`ab-tab ${centerTab === "book" ? "is-active" : ""}`} onClick={() => setCenterTab("book")}>
                <FileText size={13} /> {t("ab.tabBook")}
              </button>
              <button className={`ab-tab ${centerTab === "batch" ? "is-active" : ""}`} onClick={() => setCenterTab("batch")}>
                <Layers size={13} /> {t("ab.tabBatch")} {chunks.length > 0 && <span className="ab-tab-count">{chunks.length}</span>}
              </button>
            </div>

            {centerTab === "book" ? (
              book ? (
                <div className="ab-chapters">
                  {book.chapters.map((ch: TtsBookChapter, i: number) => (
                    <div key={i} className={`ab-chapter ${i === chapterIdx ? "is-active" : ""}`}
                      onClick={() => setChapterIdx(i)}
                      onContextMenu={(e) => menu.open(e, [
                        { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(ch.title) },
                      ])}>
                      <b>{i + 1}. {ch.title}</b>
                      <span className="muted-sm">{ch.text.length} {t("ab.charsUnit")}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyHint icon={BookOpen} text={t("ab.noBook")} />
              )
            ) : (
              <div className="ab-batch">
                <div className="ab-ref-row">
                  <Btn icon={RefreshCw} onClick={rebuildChunks} disabled={chunksLoading}>
                    {chunksLoading ? t("ab.rebuilding") : t("ab.rebuildChunks")}
                  </Btn>
                  <span className="muted-sm">
                    {chunks.length > 0 ? t("ab.chunkHint", { n: chunks.length, limit: engine === "xtts" ? 220 : 380 }) : t("ab.batchEmpty")}
                  </span>
                </div>
                <div className="ab-chunks">
                  {chunks.map((c, i) => (
                    c.pauseMs && !c.text ? (
                      <div key={i} className="ab-chunk ab-chunk-pause" onContextMenu={(e) => menu.open(e, [{ separator: true }, { label: t("ctx.del"), icon: Trash2, danger: true, onClick: () => setChunks((cs) => cs.filter((_, k) => k !== i)) }])}>
                        <Pause size={12} /> {t("ab.pauseMarker", { ms: c.pauseMs })}
                      </div>
                    ) : (
                      <div key={i} className="ab-chunk"
                        onContextMenu={(e) => menu.open(e, [
                          { label: t("ab.rerenderChunk"), icon: Wand2, onClick: () => setP("chunkLimit", params.chunkLimit) },
                          { label: t("ab.splitChunk"), icon: SplitSquareHorizontal, onClick: () => splitChunk(i) },
                          { label: t("ab.mergeChunk"), icon: Merge, onClick: () => mergeWithNext(i) },
                          { label: t("ab.addPause"), icon: Pause, onClick: () => addPause(i) },
                          { separator: true },
                          { label: t("ab.exportChunkWav"), icon: Download, onClick: () => {} },
                          { label: t("ctx.copy"), icon: Copy, onClick: () => copyToClipboard(c.text || "") },
                        ] as any)}>
                        <div className="ab-chunk-head">
                          <span className="muted-sm">#{i + 1} · {c.text?.length || 0}</span>
                          <div style={{ display: "flex", gap: 2 }}>
                            <IconBtn icon={ArrowUp} size={11} title={t("ab.moveUp")} onClick={() => moveChunk(i, -1)} />
                            <IconBtn icon={ArrowDown} size={11} title={t("ab.moveDown")} onClick={() => moveChunk(i, 1)} />
                            <IconBtn icon={SplitSquareHorizontal} size={11} title={t("ab.splitChunk")} onClick={() => splitChunk(i)} />
                            <IconBtn icon={Merge} size={11} title={t("ab.mergeChunk")} onClick={() => mergeWithNext(i)} />
                            <IconBtn icon={Pause} size={11} title={t("ab.addPause")} onClick={() => addPause(i)} />
                            <IconBtn icon={Trash2} size={11} title={t("ctx.del")} onClick={() => setChunks((cs) => cs.filter((_, k) => k !== i))} />
                          </div>
                        </div>
                        <textarea className="ab-chunk-text" value={c.text || ""}
                          onChange={(e) => editChunkText(i, e.target.value)} rows={2} />
                      </div>
                    )
                  ))}
                </div>
              </div>
            )}
          </Glass>
        </div>

        {/* --- Правая панель: Pro-настройки (аккордеон) --- */}
        <div className="ab-col ab-right">
          <Glass className="split-pane">
            <div className="field-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              {t("ab.proSettings")}
              <Btn icon={proOpen ? ChevronUp : ChevronDown} onClick={() => setProOpen((v) => !v)}>
                {proOpen ? t("ab.hidePro") : t("ab.showPro")}
              </Btn>
            </div>
            {!proOpen && <div className="muted-sm">{t("ab.expressNote", { precision: String(optimal.precision || "float16").toUpperCase() })}</div>}
            {proOpen && (
              <>
                <Accordion id="vram" title={t("ab.accVram")}>
                  <ProSelect p="precision" label={t("ab.precision")} tip={t("ab.tipPrecision")} opt={optimal.precision === params.precision ? t("ab.optimalForVram", { gb: String(optimal.vram || 8) }) : undefined}
                    options={[{ value: "float16", label: "FP16" }, { value: "bfloat16", label: "BF16" }, { value: "float32", label: "FP32" }, { value: "int8", label: "INT8" }]} />
                  <ProSelect p="attention" label={t("ab.attention")} tip={t("ab.tipAttention")} opt={params.attention === "sdpa" ? t("ab.optimal") : undefined}
                    options={[{ value: "flash", label: "FlashAttention-2" }, { value: "sdpa", label: "Torch SDPA" }, { value: "eager", label: "Eager" }]} />
                  <ProToggle p="gcEveryChunks" label={t("ab.vramGc")} tip={t("ab.tipVramGc")} />
                </Accordion>

                {engine === "f5" && (
                  <Accordion id="f5" title={t("ab.accF5")}>
                    <ProSlider p="nfe" label={t("ab.nfe")} tip={t("ab.tipNfe")} opt={t("ab.optimalNfe")} min={16} max={100} step={2} />
                    <ProSlider p="cfg" label={t("ab.cfg")} tip={t("ab.tipCfg")} opt={t("ab.optimalCfg")} min={1} max={10} step={0.1} fmt={(v) => v.toFixed(1)} />
                    <ProSelect p="solver" label="ODE Solver" tip={t("ab.tipSolver")} opt={params.solver === "euler" ? t("ab.optimal") : undefined}
                      options={[{ value: "euler", label: "Euler" }, { value: "midpoint", label: "Midpoint" }, { value: "rk4", label: "RK4" }]} />
                    <ProSlider p="exaggeration" label={t("ab.exaggeration")} tip={t("ab.tipExaggeration")} min={0.5} max={2} step={0.05} fmt={(v) => v.toFixed(2)} />
                  </Accordion>
                )}

                {engine === "xtts" && (
                  <Accordion id="xtts" title={t("ab.accXtts")}>
                    <ProSlider p="temperature" label={t("ab.temperature")} tip={t("ab.tipTemperature")} opt={t("ab.optimalTemp")} min={0.01} max={1.5} step={0.01} fmt={(v) => v.toFixed(2)} />
                    <ProSlider p="repetitionPenalty" label={t("ab.repPenalty")} tip={t("ab.tipRepPenalty")} opt={t("ab.optimalRep")} min={1} max={15} step={0.1} fmt={(v) => v.toFixed(1)} />
                    <ProSlider p="topK" label="Top-K" tip={t("ab.tipTopK")} min={1} max={100} step={1} />
                    <ProSlider p="topP" label="Top-P" tip={t("ab.tipTopP")} opt={t("ab.optimalTopP")} min={0.05} max={1} step={0.05} fmt={(v) => v.toFixed(2)} />
                  </Accordion>
                )}

                <Accordion id="nlp" title={t("ab.accNlp")}>
                  <ProToggle p="expandNumbers" label={t("ab.expandNumbers")} tip={t("ab.tipExpandNumbers")} />
                  <ProToggle p="yoficate" label={t("ab.yoficate")} tip={t("ab.tipYoficate")} />
                  <ProToggle p="markStress" label={t("ab.markStress")} tip={t("ab.tipMarkStress")} />
                </Accordion>

                <Accordion id="post" title={t("ab.accPost")}>
                  <ProSlider p="crossFadeMs" label={t("ab.crossFade")} tip={t("ab.tipCrossFade")} opt={t("ab.optimalCrossFade")} min={0} max={500} step={10} fmt={(v) => `${v} ms`} />
                  <ProSlider p="sentencePauseMs" label={t("ab.sentencePause")} tip={t("ab.tipSentencePause")} opt="400 ms" min={100} max={1500} step={50} fmt={(v) => `${v} ms`} />
                  <ProSlider p="paragraphPauseMs" label={t("ab.paragraphPause")} tip={t("ab.tipParagraphPause")} opt="1200 ms" min={500} max={3000} step={100} fmt={(v) => `${v} ms`} />
                  <ProSlider p="loudnessTarget" label={t("ab.loudness")} tip={t("ab.tipLoudness")} opt="-16 LUFS" min={-24} max={-10} step={1} fmt={(v) => `${v} LUFS`} />
                  <ProSlider p="speed" label={t("ab.speed")} tip={t("ab.tipSpeed")} opt="1.0x" min={0.5} max={2} step={0.05} fmt={(v) => `${v.toFixed(2)}x`} />
                  <ProSelect p="format" label={t("ab.format")} tip={t("ab.tipFormat")} options={[{ value: "m4b", label: "M4B (главы)" }, { value: "mp3", label: "MP3 (главы)" }, { value: "wav", label: "WAV" }]} />
                </Accordion>
              </>
            )}

            <div className="field-label" style={{ marginTop: 10 }}>{t("ab.language")}</div>
            <Select value={String(params.language)} onChange={(e) => setP("language", e.target.value)} options={TTS_LANGS} />
          </Glass>
        </div>
      </div>

      {/* Липкая панель генерации: всегда видна при прокрутке, «висит» над плеером */}
      <Glass className="ab-generate-bar">
        <Btn variant="primary" icon={Wand2} style={{ minWidth: 210, flexShrink: 0 }}
          disabled={!refFile || busy || (!rawText.trim() && !chunks.length)} onClick={generate}>
          {busy ? t("ab.generating") : t("ab.generate")}
        </Btn>
        {busy && (
          <div style={{ flex: 1, minWidth: 180 }}>
            <div className="muted-sm" style={{ marginBottom: 6 }}>
              {t("ab.chunkProgress", { i: (job?.chunkIndex || 0) + 1, n: job?.chunksTotal || 0 })}
            </div>
            <ProgressBar value={job?.progress || 0} />
          </div>
        )}
        {job?.stage === "error" && (
          <div className="muted-sm" style={{ color: "var(--coral)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("ab.renderError")}: {job.error}
          </div>
        )}
        {job?.done && (
          <span className="ab-tab-badge">{t("ab.statusDone")} · {(job.outSize / 1048576).toFixed(1)} MB</span>
        )}
      </Glass>

      {/* --- Нижний плеер аудиокниги --- */}
      <Glass className="ab-player">
        <ListMusic size={16} />
        <audio src={resultUrl || undefined} controls style={{ flex: 1 }} />
        {resultUrl && (
          <div style={{ display: "flex", gap: 6 }}
            onContextMenu={(e) => menu.open(e, [
              { label: t("ab.downloadResult"), icon: Download, onClick: downloadResult },
              { label: t("ab.revealInExplorer"), icon: FolderOpen, onClick: () => job && api.ttsReveal(job.outFile || "").catch(() => {}) },
              { label: t("ab.reRender"), icon: RefreshCw, onClick: generate },
              { separator: true },
              { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(resultName) },
            ] as any)}>
            <Btn variant="primary" icon={Download} onClick={downloadResult}>{t("ab.downloadResult")}</Btn>
            <Btn icon={FolderOpen} onClick={() => job && api.ttsReveal(job.outFile || "").catch(() => {})}>{t("ab.revealInExplorer")}</Btn>
            <Btn icon={RefreshCw} onClick={generate}>{t("ab.reRender")}</Btn>
          </div>
        )}
      </Glass>
    </div>
  );
}
