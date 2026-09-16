import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  FileVideo, Upload, Download, Gauge, Trash2, Copy, FolderOpen,
  X, Zap, Save, SlidersHorizontal,
} from "lucide-react";
import { Glass, Btn, Badge, Select, SectionHead, ProgressBar } from "../components/ui";
import { usePageActive, usePageBusy } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { useContextMenu, copyToClipboard } from "../components/ContextMenu";
import { api } from "../api/client";
import type { CompressorJob, CompressorHardware, CompressorPreset } from "../api/client";

/**
 * Страница сжатия видео 2.0: встроенная матрица энкодеров.
 *
 *  - Express Mode: рекомендатель по железу (GET /compressor/hardware) даёт
 *    метод под CPU/GPU и подсвечивает его бейджем «Recommended».
 *  - Pro Mode: кодек, движок (CPU/GPU-матрица), режим качества (CRF/битрейт/
 *    ограниченный), пресет скорости, разрешение, звук — с бейджами оптимальных
 *    диапазонов под активный кодек.
 *  - Пресеты: системные (сервер) + пользовательские (settings.json).
 *  - Результат: split-плеер оригинал/результат с синхронным воспроизведением,
 *    метаданными и перетаскиваемым разделителем.
 *  - Правый клик: копия пути/команды, проводник, сохранение пресета, удаление.
 */

const fmtMB = (b?: number | null) => (!b && b !== 0) ? "—" : `${(b / 1024 / 1024).toFixed(1)} MB`;
const fmtBitrate = (bps?: number | null) => (!bps ? "—" : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`);

const ENGINES: { id: string; kind: "cpu" | "gpu"; codec: string; label: string }[] = [
  { id: "svtav1", kind: "cpu", codec: "av1", label: "SVT-AV1" },
  { id: "av1an", kind: "cpu", codec: "av1", label: "SVT-AV1 + Av1an" },
  { id: "aom", kind: "cpu", codec: "av1", label: "libaom" },
  { id: "rav1e", kind: "cpu", codec: "av1", label: "rav1e" },
  { id: "x265", kind: "cpu", codec: "hevc", label: "x265" },
  { id: "x264", kind: "cpu", codec: "h264", label: "x264" },
  { id: "nvenc", kind: "gpu", codec: "av1", label: "NVENC" },
  { id: "nvencc", kind: "gpu", codec: "av1", label: "NVEncC (rigaya)" },
  { id: "qsv", kind: "gpu", codec: "av1", label: "Quick Sync" },
  { id: "qsvencc", kind: "gpu", codec: "av1", label: "QSVEncC (rigaya)" },
  { id: "amf", kind: "gpu", codec: "av1", label: "AMF/VCE" },
  { id: "vceencc", kind: "gpu", codec: "av1", label: "VCEEncC (rigaya)" },
];

const HEIGHTS = ["original", "2160", "1440", "1080", "720", "480"];

// Локальное поле параметров страницы.
interface Params {
  codec: string; engine: string; qualityMode: string;
  crf: number; targetKbps: number; maxKbps: number; speed: string;
  tenBit: boolean; targetHeight: string; audio: string; audioKbps: number;
}

const DEFAULT_PARAMS: Params = {
  codec: "av1", engine: "auto", qualityMode: "crf", crf: 23,
  targetKbps: 0, maxKbps: 0, speed: "6", tenBit: false,
  targetHeight: "original", audio: "aac", audioKbps: 192,
};

function crfTone(crf: number, codec: string): { tone: string; key: string } {
  const [lo, hi] = codec === "h264" ? [18, 22] : codec === "hevc" ? [20, 24] : [22, 28];
  if (crf < lo - 2) return { tone: "amber", key: "cmp.crfOverkill" };
  if (crf <= hi) return { tone: "teal", key: "cmp.crfSweet" };
  if (crf <= hi + 8) return { tone: "violet", key: "cmp.crfHigh" };
  return { tone: "coral", key: "cmp.crfLow" };
}

export default function CompressorPage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileMeta, setFileMeta] = useState<{ w: number; h: number; dur: number } | null>(null);
  const [origCodec, setOrigCodec] = useState<string>("");
  const [hw, setHw] = useState<CompressorHardware | null>(null);
  const [presets, setPresets] = useState<{ system: CompressorPreset[]; custom: CompressorPreset[] }>({ system: [], custom: [] });
  const [mode, setMode] = useState<"express" | "pro">("express");
  const [p, setP] = useState<Params>(DEFAULT_PARAMS);
  const [targetMB, setTargetMB] = useState(25);
  const [job, setJob] = useState<CompressorJob | null>(null);
  const [defect, setDefect] = useState("");
  const [saveModal, setSaveModal] = useState(false);
  const [presetName, setPresetName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const patch = (u: Partial<Params>) => setP((prev) => ({ ...prev, ...u }));

  // Железо + пресеты при монтировании; дефолты настроек поверх.
  // Рекомендатель применяется один раз при загрузке: что выбрал пользователь
  // (в т.ч. пресет) позже — не перезаписывается.
  const hwApplied = useRef(false);
  useEffect(() => {
    api.compressorHardware().then((h) => {
      setHw(h);
      if (!hwApplied.current) {
        hwApplied.current = true;
        setP((prev) => ({
          ...prev,
          engine: h.recommended.engine, codec: h.recommended.codec,
          qualityMode: h.recommended.qualityMode, crf: h.recommended.crf,
          speed: h.recommended.speed || prev.speed,
        }));
      }
    }).catch(() => { /* CPU-дефолты */ });
    api.compressorPresets().then(setPresets).catch(() => { /* пусто */ });
    api.getSettings().then((s: any) => {
      const c = s?.compressor;
      if (c) setP((prev) => ({
        ...prev,
        codec: typeof c.codec === "string" ? c.codec : prev.codec,
        engine: typeof c.engine === "string" ? c.engine : prev.engine,
        qualityMode: typeof c.qualityMode === "string" ? c.qualityMode : prev.qualityMode,
        crf: typeof c.crf === "number" ? c.crf : prev.crf,
        tenBit: c.tenBit === true,
        targetHeight: typeof c.targetHeight === "string" ? c.targetHeight : prev.targetHeight,
        audio: typeof c.audio === "string" ? c.audio : prev.audio,
        audioKbps: typeof c.audioKbps === "number" ? c.audioKbps : prev.audioKbps,
      }));
    }).catch(() => { /* дефолты из кода */ });
  }, []);

  // Методы, подходящие под выбранный кодек и доступные на этой машине.
  const engineOptions = ENGINES.filter((e) => {
    if (hw && !hw.methods[e.id]) return false;
    if (["nvenc", "qsv", "amf", "nvencc", "qsvencc", "vceencc"].includes(e.id)) return true;
    return e.codec === p.codec;
  });
  // Скоростная шкала активного движка.
  const speedScale = (() => {
    if (["nvenc"].includes(p.engine)) return ["P1", "P2", "P3", "P4", "P5", "P6", "P7"];
    if (["qsv"].includes(p.engine)) return ["veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
    if (p.engine === "amf") return ["speed", "balanced", "quality"];
    if (p.engine === "aom") return ["0", "2", "4", "6", "8"];
    if (p.engine === "x265" || p.engine === "x264") return ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
    return ["0", "2", "4", "6", "8", "10", "13"]; // svtav1/av1an/auto
  })();

  // Оптимальные диапазоны под текущий кодек/метод (из /hardware).
  const crfOptimal = p.engine === "nvenc" || p.engine === "qsv" || p.engine === "amf"
    ? hw?.optimal?.cqp?.[p.codec] : hw?.optimal?.crf?.[p.codec];
  const bitrateOptimal = hw?.optimal?.bitrate?.[p.targetHeight === "original" ? "1080" : p.targetHeight];

  // Целевой битрейт из лимита размера: (МБ*8/сек) − аудио, в kbps.
  const computedKbps = (() => {
    if (!fileMeta?.dur) return 0;
    const totalKbits = targetMB * 1024 * 1024 * 8;
    const audioK = (p.audio === "copy" ? 0 : p.audioKbps) * fileMeta.dur;
    return Math.max(64, Math.round((totalKbits - audioK) / fileMeta.dur / 1000));
  })();

  // Опрос активного задания. В фоне (страница не видима) он реже: сама задача
  // идёт на сервере, а интерфейс догонит её сразу при возвращении (см. ниже).
  const [jobId, setJobId] = useState<string | null>(null);
  const isActive = usePageActive();

  useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const j = await api.compressorStatus(jobId);
        if (stopped) return;
        setJob(j);
        if (j.done || j.stage === "error") setJobId(null);
      } catch { /* сеть моргнула — попробуем на следующем тике */ }
    };
    const timer = window.setInterval(tick, isActive ? 1000 : 4000);
    if (isActive) void tick(); // при возврате сразу подтягиваем прогресс
    return () => { stopped = true; window.clearInterval(timer); };
  }, [jobId, isActive]);

  // Незавершённое сжатие — страницу нельзя выгружать из памяти (LRU).
  usePageBusy(!!jobId);

  /** Сбросить активное задание (вместе с опросом). */
  const closeJob = () => { setJobId(null); setJob(null); };

  const pick = (f: File | null) => {
    setFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
    setJobId(null);
    setJob(null);
    setFileMeta(null);
    setOrigCodec("");
    // Исходный кодек/метаданные — лёгкий probe на сервере (файл сразу удаляется).
    if (f) {
      api.compressorProbe(f).then((info) => {
        setOrigCodec(info.codec || "");
        if (info.width || info.duration) {
          setFileMeta((prev) => ({
            w: info.width || prev?.w || 0,
            h: info.height || prev?.h || 0,
            dur: info.duration || prev?.dur || 0,
          }));
        }
      }).catch(() => { /* без probe — метаданные из <video> */ });
    }
  };

  // Метаданные исходника — из <video> (duration/размер нужны калькулятору битрейта).
  const onMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    setFileMeta({ w: v.videoWidth, h: v.videoHeight, dur: v.duration || 0 });
  };

  const start = async () => {
    if (!file) return;
    setDefect("");
    try {
      const payload: Record<string, string | number | boolean> = { ...p };
      if (p.qualityMode === "bitrate") payload.targetKbps = computedKbps || p.targetKbps;
      const j = await api.compressVideo(file, payload);
      setJob(j);
      setJobId(j.id);
    } catch (e: any) {
      setDefect(String(e.message || e));
    }
  };

  // Применение пресета. Системные пресеты с сервера держат параметры на
  // верхнем уровне ({id, codec, ...}), пользовательские — в pr.params.
  const applyPreset = (pr: CompressorPreset) => {
    const q = (pr.params || pr) as Record<string, unknown>;
    setP((prev) => ({
      ...prev,
      codec: String(q.codec ?? prev.codec),
      engine: String(q.engine ?? prev.engine),
      qualityMode: String(q.qualityMode ?? prev.qualityMode),
      crf: Number(q.crf ?? prev.crf),
      speed: String(q.speed ?? prev.speed),
      tenBit: q.tenBit === true,
      targetHeight: String(q.targetHeight ?? prev.targetHeight),
      audio: String(q.audio ?? prev.audio),
      audioKbps: Number(q.audioKbps ?? prev.audioKbps),
    }));
    if (pr.targetMB) setTargetMB(pr.targetMB);
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    try {
      const payload: Record<string, unknown> = { name, ...p };
      if (p.qualityMode === "bitrate") payload.targetKbps = computedKbps || p.targetKbps;
      const r = await api.compressorSavePreset(payload as any);
      setPresets((prev) => ({ ...prev, custom: r.custom as any }));
      setSaveModal(false);
      setPresetName("");
    } catch { /* не сохраняется — молча */ }
  };

  const deletePreset = async (name: string) => {
    try {
      await api.compressorDeletePreset(name);
      setPresets((prev) => ({ ...prev, custom: prev.custom.filter((x) => x.name !== name) }));
    } catch { /* ignore */ }
  };

  // «Reveal in File Explorer» через IPC-shell; путь отдаёт сервер.
  const reveal = async (id: string) => {
    try {
      const { path } = await api.compressorReveal(id);
      const br = (window as any).appBridge;
      if (br?.revealPath) await br.revealPath(path);
      else copyToClipboard(path); // вне Electron — хотя бы путь в буфер
    } catch { /* не готово */ }
  };

  const tone = crfTone(p.crf, p.codec);
  const saved = job?.done && job.size ? Math.round(100 - (100 * job.outSize) / job.size) : null;
  // Пропорции исходника для превью (до загрузки метаданных — 16:9).
  const previewAr = fileMeta && fileMeta.w > 0 && fileMeta.h > 0 ? fileMeta.w / fileMeta.h : 16 / 9;
  const done = job?.done;
  const busy = !!job && !done && job.stage !== "error";
  const rec = hw?.recommended;

  // Какой пресет сейчас активен (для подсветки бейджа).
  const presetActive = (pr: CompressorPreset) => {
    const q = (pr.params || pr) as Record<string, unknown>;
    // В bitrate-режиме CRF не участвует (у системных пресетов он null).
    const crfOk = q.crf == null || Number(q.crf) === p.crf;
    const audioOk = q.audioKbps == null || Number(q.audioKbps) === p.audioKbps;
    return q.codec === p.codec && q.engine === p.engine && q.qualityMode === p.qualityMode
      && crfOk && audioOk && q.targetHeight === p.targetHeight && q.tenBit === p.tenBit;
  };

  return (
    <div className="page cmp-page">
      <SectionHead eyebrow={t("cmp.eyebrow")} title={t("cmp.title")} />

      <div className="cmp-grid">
        {/* --- Левая колонка: видео --- */}
        <div className="cmp-left">
          {!file && (
            <div className={`dropzone`} onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0] || null); }}
              onContextMenu={(e) => menu.open(e, [
                { label: t("cmp.select"), icon: Upload, onClick: () => inputRef.current?.click() },
              ])}>
              <input ref={inputRef} type="file" hidden accept="video/*"
                onChange={(e) => pick(e.target.files?.[0] || null)} />
              <FileVideo size={28} strokeWidth={1.5} />
              <div>{t("cmp.drop")}</div>
              <span className="muted-sm">{t("cmp.dropHint")}</span>
            </div>
          )}

          {file && !done && (
            <Glass className="cmp-preview cmp-card" style={{ flexDirection: "column", gap: 8 }}
              onContextMenu={(e) => menu.open(e, [
                { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(file.name) },
                { label: t("cmp.rechoose"), icon: X, onClick: () => pick(null) },
              ])}>
              {previewUrl && (
                <div className="cmp-player-wrap">
                  <video src={previewUrl} controls onLoadedMetadata={onMeta}
                    style={{ ["--cmp-ar" as string]: previewAr, ["--cmp-max-h" as string]: "52vh" }} />
                </div>
              )}
              <div className="media-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {origCodec && <Badge tone="violet" mono>{origCodec.toUpperCase()}</Badge>}
                {fileMeta && fileMeta.w > 0 && <Badge tone="neutral">{fileMeta.w}×{fileMeta.h}</Badge>}
                <Badge tone="neutral">{fmtMB(file.size)}</Badge>
                {fileMeta?.dur ? <Badge tone="neutral">{Math.round(fileMeta.dur)}s</Badge> : null}
              </div>
            </Glass>
          )}

          {/* --- Результат: split-плеер сравнения --- */}
          {done && job && (
            <Glass className="cmp-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}
              onContextMenu={(e) => menu.open(e, [
                { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(job.name) },
                { label: t("ctx.copyPath"), icon: Copy, onClick: async () => { try { const r = await api.compressorReveal(job.id); copyToClipboard(r.path); } catch { /* */ } } },
                { label: t("cmp.copyCommand"), icon: Copy, onClick: async () => { try { const r = await api.compressorCommand(job.id); copyToClipboard(r.command); } catch { /* */ } } },
                { label: t("ctx.reveal"), icon: FolderOpen, onClick: () => reveal(job.id) },
                { label: t("cmp.savePreset"), icon: Save, onClick: () => setSaveModal(true) },
                { separator: true },
                { label: t("cmp.download"), icon: Download, onClick: () => { window.location.href = api.compressorUrl(job.id, "download"); } },
                { label: t("cmp.delete"), icon: Trash2, danger: true, onClick: async () => { await api.compressorDelete(job.id); pick(null); } },
              ])}>
              <SplitCompare
                originalSrc={previewUrl || ""}
                resultSrc={api.compressorUrl(job.id, "preview")}
                job={job}
                fileMeta={fileMeta}
                savedPct={saved}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn variant="primary" icon={Download} onClick={() => { window.location.href = api.compressorUrl(job.id, "download"); }}>
                  {t("cmp.download")}
                </Btn>
                <Btn icon={FileVideo} onClick={() => pick(null)}>{t("cmp.newVideo")}</Btn>
                <Btn icon={SlidersHorizontal} onClick={closeJob}>{t("cmp.recompress")}</Btn>
              </div>
            </Glass>
          )}

          {defect && <Glass><span style={{ color: "var(--coral)" }}>{defect}</span></Glass>}
        </div>

        {/* --- Правая колонка: настройки --- */}
        <div className="cmp-right">
          {rec && hw?.ffmpeg.found && (
            <Glass style={{ padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Zap size={15} style={{ color: "var(--amber)" }} />
              <span className="muted-sm">
                {t("cmp.recommendFor", { hw: rec.hwName, method: t(`cmp.engine_${rec.engine}`), reason: t(`cmp.reason_${rec.reason}`) })}
              </span>
            </Glass>
          )}
          {hw && !hw.ffmpeg.found && (
            <Glass style={{ padding: "10px 14px" }}>
              <span style={{ color: "var(--coral)" }}>{t("cmp.ffmpegMissing")}</span>
            </Glass>
          )}

          <Glass className="cmp-card cmp-fill" style={{ flexDirection: "column", gap: 12 }}
            onContextMenu={(e) => menu.open(e, [
              { label: t("cmp.savePreset"), icon: Save, onClick: () => setSaveModal(true) },
            ])}>
          {/* --- Пресеты: системные + пользовательские --- */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="field-label">{t("cmp.presets")}</span>
            {presets.system.map((pr) => (
              <Badge key={pr.id} tone="violet" active={presetActive(pr)} onClick={() => applyPreset(pr)}>{t(`cmp.preset_${pr.id}`)}</Badge>
            ))}
            {presets.custom.map((pr) => (
              <span key={pr.name} onContextMenu={(e) => menu.open(e, [
                { label: t("cmp.deletePreset"), icon: Trash2, danger: true, onClick: () => deletePreset(pr.name!) },
              ])}>
                <Badge tone="teal" active={presetActive(pr)} onClick={() => applyPreset(pr)}>{pr.name}</Badge>
              </span>
            ))}
            <Btn icon={Save} onClick={() => setSaveModal(true)}>{t("cmp.savePreset")}</Btn>
          </div>

          {/* --- Режим: Express / Pro --- */}
          <div style={{ display: "flex", gap: 6 }}>
            <Badge tone={mode === "express" ? "amber" : "neutral"} active={mode === "express"} onClick={() => setMode("express")}>
              {t("cmp.express")}
            </Badge>
            <Badge tone={mode === "pro" ? "violet" : "neutral"} active={mode === "pro"} onClick={() => setMode("pro")}>
              {t("cmp.pro")}
            </Badge>
          </div>

          {mode === "pro" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Кодек + разрешение + звук */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Field label={t("cmp.codec")}>
                  <Select value={p.codec} onChange={(e) => patch({ codec: e.target.value })}
                    options={[{ value: "av1", label: "AV1" }, { value: "hevc", label: "HEVC (H.265)" }, { value: "h264", label: "H.264 (AVC)" }]} />
                </Field>
                <Field label={t("cmp.resolution")}>
                  <Select value={p.targetHeight} onChange={(e) => patch({ targetHeight: e.target.value })}
                    options={HEIGHTS.map((h) => ({ value: h, label: h === "original" ? t("cmp.resOriginal") : `${h}p` }))} />
                </Field>
                <Field label={t("cmp.audio")}>
                  <Select value={p.audio} onChange={(e) => patch({ audio: e.target.value })}
                    options={[{ value: "copy", label: t("cmp.audioCopy") }, { value: "aac", label: "AAC" }, { value: "opus", label: "Opus" }]} />
                </Field>
                {p.audio !== "copy" && (
                  <Field label={t("cmp.audioKbps")}>
                    <Select value={String(p.audioKbps)} onChange={(e) => patch({ audioKbps: Number(e.target.value) })}
                      options={["96", "128", "160", "192", "256", "320"]} />
                  </Field>
                )}
              </div>

              {/* Матрица методов (CPU/GPU) */}
              <Field label={t("cmp.method")}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Badge tone={p.engine === "auto" ? "amber" : "neutral"} active={p.engine === "auto"} onClick={() => patch({ engine: "auto" })}>
                    {t("cmp.engineAuto")}
                  </Badge>
                  {engineOptions.filter((e) => e.id !== "auto").map((e) => (
                    <Badge key={e.id} tone={e.kind === "gpu" ? "teal" : "violet"} active={p.engine === e.id}
                      onClick={() => patch({ engine: e.id })}>
                      {e.kind === "gpu" ? "⚡ " : ""}{e.label}
                    </Badge>
                  ))}
                </div>
              </Field>

              {/* Режим качества */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Field label={t("cmp.qualityMode")}>
                  <Select value={p.qualityMode} onChange={(e) => patch({ qualityMode: e.target.value })}
                    options={[
                      { value: "crf", label: t("cmp.modeCrf") },
                      { value: "bitrate", label: t("cmp.modeBitrate") },
                      { value: "constrained", label: t("cmp.modeConstrained") },
                    ]} />
                </Field>
                {(p.qualityMode === "crf" || p.qualityMode === "constrained") && (
                  <Field label={`${t("cmp.crf", { v: p.crf })} · ${t(tone.key)}`}>
                    <input type="range" min="0" max="51" value={p.crf}
                      onChange={(e) => patch({ crf: Number(e.target.value) })} style={{ width: 180 }} />
                  </Field>
                )}
                {p.qualityMode === "bitrate" && (
                  <Field label={t("cmp.targetSize")}>
                    <input className="text-input" type="number" min={1} value={targetMB}
                      onChange={(e) => setTargetMB(Number(e.target.value))} style={{ width: 110 }} />
                  </Field>
                )}
                {p.qualityMode === "constrained" && (
                  <Field label={t("cmp.maxKbps")}>
                    <input className="text-input" type="number" min={100} step={100} value={p.maxKbps || 4000}
                      onChange={(e) => patch({ maxKbps: Number(e.target.value) })} style={{ width: 110 }} />
                  </Field>
                )}
              </div>

              {/* Бейджи оптимальных значений */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {crfOptimal && (p.qualityMode === "crf" || p.qualityMode === "constrained") && (
                  <Badge tone="teal">{t("cmp.optimalCrf", { lo: crfOptimal[0], hi: crfOptimal[1] })}</Badge>
                )}
                {bitrateOptimal && p.qualityMode === "bitrate" && (
                  <Badge tone="teal">{t("cmp.optimalBitrate", { lo: bitrateOptimal[0], hi: bitrateOptimal[1] })}</Badge>
                )}
                {p.qualityMode === "bitrate" && computedKbps > 0 && (
                  <Badge tone="violet" mono>≈ {computedKbps} kbps</Badge>
                )}
                {p.codec === "av1" && <Badge tone="neutral">{t("cmp.optimalSpeedSvt")}</Badge>}
                {p.engine === "nvenc" && <Badge tone="neutral">{t("cmp.optimalSpeedNvenc")}</Badge>}
              </div>

              {/* Пресет скорости + 10-bit */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <Field label={t("cmp.speedPreset")}>
                  <Select value={p.speed} onChange={(e) => patch({ speed: e.target.value })}
                    options={speedScale.map((s) => ({ value: s, label: s }))} />
                </Field>
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", paddingBottom: 8 }}>
                  <input type="checkbox" checked={p.tenBit} onChange={(e) => patch({ tenBit: e.target.checked })} />
                  <span className="muted-sm">{t("cmp.tenBit")}</span>
                </label>
              </div>
            </div>
          )}

          {mode === "express" && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Badge tone="violet">{p.engine === "auto" ? t("cmp.engineAuto") : t(`cmp.engine_${p.engine}`)}</Badge>
              <Badge tone="neutral">{p.codec.toUpperCase()}</Badge>
              <Badge tone={tone.tone}>{t(tone.key)}</Badge>
              <span className="muted-sm">{t("cmp.expressHint")}</span>
            </div>
          )}

          {/* --- Прогресс / кнопка старта --- */}
          {busy && job && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="muted-sm">{t(`cmp.stage_${job.stage}`)} · {t(`cmp.engine_${job.engineUsed || job.engine}`)}</span>
                <span className="muted-sm">{job.progress}%{job.etaSec ? ` · ETA ${job.etaSec}s` : ""}</span>
              </div>
              <ProgressBar value={job.progress} />
              {job.fallbacks?.length ? <span className="muted-sm">{t("cmp.fallbacks", { list: job.fallbacks.join(", ") })}</span> : null}
            </div>
          )}
          {!busy && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn variant="primary" icon={Gauge} onClick={start} disabled={!file || (!!hw && !hw.ffmpeg.found)}>
                {t("cmp.compress")}
              </Btn>
              <Btn icon={X} onClick={() => pick(null)} disabled={!file}>{t("cmp.rechoose")}</Btn>
            </div>
          )}
          </Glass>
        </div>
      </div>

      {/* --- Модалка: сохранить текущие параметры как пресет --- */}
      {saveModal && (
        <div className="modal-overlay" onClick={() => setSaveModal(false)}>
          <Glass className="modal-panel" onClick={(e: any) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="media-title">{t("cmp.savePreset")}</div>
              <button onClick={() => setSaveModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", display: "flex" }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input className="text-input" style={{ flex: 1 }} value={presetName}
                placeholder={t("cmp.presetName")} onChange={(e) => setPresetName(e.target.value)} />
              <Btn variant="primary" icon={Save} onClick={savePreset}>{t("cmp.save")}</Btn>
            </div>
          </Glass>
        </div>
      )}

      {/* --- Модалка-гайд (CPU vs GPU, CRF, пресеты) удалена вместе с кнопкой
             «Как это работает» в тулбаре. --- */}
    </div>
  );
}

// Локальное поле: label + control.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 130 }}>
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * Split-плеер сравнения: оригинал под результатом, разделитель — клип-порт
 * результата, перетаскивается мышью.
 *
 * Синхронность: звучит всегда ТОЛЬКО одна дорожка (иначе слышен «флангер» и
 * рассинхрон), а видео подтягиваются друг к другу — мягко через playbackRate и
 * жёстко (seek) при большом расхождении.
 *
 * Размер: плеер масштабируется по ширине кадра и не вылезает за высоту окна,
 * поэтому больших чёрных полос сверху/снизу нет (--cmp-ar / --cmp-max-h).
 */
function SplitCompare({ originalSrc, resultSrc, job, fileMeta, savedPct }: {
  originalSrc: string;
  resultSrc: string;
  job: CompressorJob;
  fileMeta: { w: number; h: number; dur: number } | null;
  savedPct: number | null;
}) {
  const { t } = useI18n();
  const isActive = usePageActive();
  const refA = useRef<HTMLVideoElement | null>(null); // оригинал (низ, со звуком)
  const refB = useRef<HTMLVideoElement | null>(null); // результат (верх, клип)
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [split, setSplit] = useState(50);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [audioSide, setAudioSide] = useState<"orig" | "result">("orig");
  const dragging = useRef(false);

  // Пропорции кадра: из <video> исходника, иначе из probe-метаданных задания.
  const arRaw = fileMeta && fileMeta.w > 0 && fileMeta.h > 0
    ? fileMeta.w / fileMeta.h
    : (job.info?.width && job.info?.height ? job.info.width / job.info.height : 16 / 9);
  const ar = Number.isFinite(arRaw) && arRaw > 0 ? arRaw : 16 / 9;

  /* ── синхронизация ──
   * Мягкая коррекция: опоздавшему слою на 1 кадр крутим playbackRate, это
   * незаметно глазу и не даёт «щёлкнуть» звуком. Если разъехались сильно —
   * жёстко переставляем время. */
  const hardSync = (from: HTMLVideoElement | null, to: HTMLVideoElement | null, tol = 0.25) => {
    if (from && to && Math.abs(from.currentTime - to.currentTime) > tol) to.currentTime = from.currentTime;
  };

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      const a = refA.current, b = refB.current;
      if (!a || !b) return;
      const drift = a.currentTime - b.currentTime;
      if (Math.abs(drift) > 0.25) { b.currentTime = a.currentTime; a.playbackRate = 1; b.playbackRate = 1; return; }
      // ведущий — оригинал (a), ведомый — результат (b)
      b.playbackRate = Math.abs(drift) < 0.01 ? 1 : Math.min(1.05, Math.max(0.95, 1 + drift * 2));
      a.playbackRate = 1;
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing]);

  // Звучит ровно одна дорожка (иначе двойной звук даёт «эхо» и слышимый рассинхрон).
  useEffect(() => {
    if (refA.current) refA.current.muted = audioSide !== "orig";
    if (refB.current) refB.current.muted = audioSide !== "result";
  }, [audioSide, playing]);

  // Уход со страницы — останавливаем воспроизведение (звук не должен играть фоном).
  useEffect(() => {
    if (isActive) return;
    try { refA.current?.pause(); refB.current?.pause(); } catch { /* noop */ }
    setPlaying(false);
  }, [isActive]);

  const toggle = () => {
    const a = refA.current, b = refB.current;
    if (!a || !b) return;
    if (playing) { a.pause(); b.pause(); setPlaying(false); }
    else {
      hardSync(a, b, 0.001); hardSync(b, a, 0.001);
      a.playbackRate = 1; b.playbackRate = 1;
      Promise.all([a.play(), b.play()]).then(() => setPlaying(true)).catch(() => { /* autoplay */ });
    }
  };

  const seekTo = (frac: number) => {
    const a = refA.current, b = refB.current;
    const dur = a?.duration || fileMeta?.dur || 0;
    if (!dur) return;
    setPos(frac);
    if (a) a.currentTime = frac * dur;
    if (b) b.currentTime = frac * (b.duration || dur);
  };

  const onMove = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el || !dragging.current) return;
    const r = el.getBoundingClientRect();
    setSplit(Math.max(2, Math.min(98, ((clientX - r.left) / r.width) * 100)));
  }, []);

  useEffect(() => {
    const mm = (e: MouseEvent) => onMove(e.clientX);
    const mu = () => { dragging.current = false; };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [onMove]);

  const origBitrate = fileMeta && fileMeta.dur ? (job.size * 8) / fileMeta.dur : job.info?.bitRate || 0;
  const outBitrate = job.durationSec ? (job.outSize * 8) / job.durationSec : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
      {/* Центрируем плеер: он сам подбирает ширину по пропорции кадра. */}
      <div className="cmp-player-wrap">
      <div ref={wrapRef} className="cmp-player" style={{ ["--cmp-ar" as string]: ar, ["--cmp-max-h" as string]: "52vh" }}>
        {/* Оригинал — нижний слой */}
        <video ref={refA} src={originalSrc} playsInline loop
          onTimeUpdate={(e) => setPos(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
          onEnded={() => setPlaying(false)} />
        {/* Результат — верхний слой, обрезан до позиции разделителя */}
        <video ref={refB} src={resultSrc} playsInline loop
          style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
        {/* Разделитель */}
        <div
          onMouseDown={(e) => { dragging.current = true; onMove(e.clientX); }}
          style={{ position: "absolute", top: 0, bottom: 0, left: `${split}%`, width: 3, background: "var(--amber)", cursor: "col-resize" }}>
          <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 26, height: 26, borderRadius: "50%", background: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", color: "#000", fontSize: 13, fontWeight: 700 }}>↔</div>
        </div>
        {/* Управление воспроизведением */}
        <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 10, right: 10, bottom: 8, display: "flex", gap: 10, alignItems: "center", background: "rgba(0,0,0,.55)", borderRadius: 8, padding: "4px 10px" }}>
          <button onClick={toggle} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 15 }}>{playing ? "⏸" : "▶"}</button>
          <input type="range" min="0" max="1" step="0.001" value={pos}
            onChange={(e) => seekTo(Number(e.target.value))} style={{ flex: 1, accentColor: "var(--amber)" }} />
          {/* Звучит только одна дорожка — переключаем, какую слушать. */}
          <button onClick={() => setAudioSide((s) => (s === "orig" ? "result" : "orig"))}
            title={audioSide === "orig" ? t("cmp.original") : t("cmp.result")}
            style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 13 }}>
            {audioSide === "orig" ? "🔊" : "🔈"}
          </button>
        </div>
        {/* Подписи сторон */}
        <span style={{ position: "absolute", top: 8, left: 10, color: "#fff", fontSize: 12, background: "rgba(0,0,0,.55)", borderRadius: 6, padding: "2px 8px" }}>{t("cmp.original")}</span>
        <span style={{ position: "absolute", top: 8, right: 10, color: "#fff", fontSize: 12, background: "rgba(0,0,0,.55)", borderRadius: 6, padding: "2px 8px" }}>{t("cmp.result")}</span>
      </div>
      </div>

      {/* Метаданные: оригинал слева, результат справа */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="field-label">{t("cmp.original")}</span>
          {fileMeta && <Badge tone="neutral">{fileMeta.w}×{fileMeta.h}</Badge>}
          <Badge tone="neutral">{fmtMB(job.size)}</Badge>
          <Badge tone="neutral">{fmtBitrate(origBitrate)}</Badge>
          {job.info?.codec && <Badge tone="neutral" mono>{job.info.codec}</Badge>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="field-label">{t("cmp.result")}</span>
          <Badge tone="violet" mono>{t(`cmp.engine_${job.engineUsed || job.engine}`)}</Badge>
          <Badge tone="neutral">{fmtMB(job.outSize)}</Badge>
          <Badge tone="neutral">{fmtBitrate(outBitrate)}</Badge>
          {/* Размер мог и вырасти: тогда показываем «+N%», а не двойной минус. */}
          {savedPct != null && (
            savedPct >= 0
              ? <Badge tone="teal">−{savedPct}%</Badge>
              : <Badge tone="coral">+{Math.abs(savedPct)}%</Badge>
          )}
        </div>
      </div>
    </div>
  );
}


