import React, { useState, useEffect, useRef } from "react";
import { FileVideo, Upload, Download, Gauge, Sparkles, MonitorPlay, Trash2, Copy, FolderOpen, Columns2, Info, X, Zap } from "lucide-react";
import { Glass, Btn, Badge, Select, SectionHead, ProgressBar, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { useContextMenu, copyToClipboard } from "../components/ContextMenu";
import { api } from "../api/client";
import type { CompressorJob } from "../api/client";

/**
 * Страница сжатия видео (вдохновлена rotato.app/compress).
 *
 * Как это работает:
 *  - Файл выбирается в дропзоне; параметры (CRF/кодек/разрешение/AI) можно
 *    переопределить поверх дефолтов из «Настроек» (compressor.*).
 *  - После POST /api/compressor страница раз в секунду опрашивает статус
 *    задания и показывает 3 ступени пайплайна + прогресс и ETA.
 *  - CRF-слайдер с цветовой индикацией: 0–19 overkill, 20–25 sweet spot,
 *    26–35 сильное сжатие, 36–50 низкое качество.
 *  - Результат: сравнение оригинал/результат (два плеера), размер и экономия,
 *    скачивание. Правый клик по результату — копирование пути/сравнение/удаление.
 */

const fmtMB = (b?: number | null) => (!b && b !== 0) ? "—" : `${(b / 1024 / 1024).toFixed(1)} MB`;

// Цвет и подпись для значения CRF.
function crfTone(crf: number): { tone: "amber" | "teal" | "violet" | "coral"; key: string } {
  if (crf <= 19) return { tone: "amber", key: "cmp.crfOverkill" };
  if (crf <= 25) return { tone: "teal", key: "cmp.crfSweet" };
  if (crf <= 35) return { tone: "violet", key: "cmp.crfHigh" };
  return { tone: "coral", key: "cmp.crfLow" };
}

export default function CompressorPage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [crf, setCrf] = useState(22);
  const [codec, setCodec] = useState("av1");
  const [targetH, setTargetH] = useState("original");
  const [ai, setAi] = useState(true);
  const [aiScale, setAiScale] = useState("2x");
  const [aiModel, setAiModel] = useState("realesr-animevideov3-x4");
  const [gpuFirst, setGpuFirst] = useState(false);
  // Состояние Real-ESRGAN: установлен / качается / ошибка.
  const [aiInfo, setAiInfo] = useState<{ installed: boolean; downloading: boolean; progress: number; error: string } | null>(null);
  const [job, setJob] = useState<CompressorJob | null>(null);
  const [defect, setDefect] = useState<string>(""); // подсказки (ffmpeg нет и т.п.)
  const [guide, setGuide] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  // Дефолты из настроек (compressor.*) применяются при открытии страницы.
  useEffect(() => {
    api.getSettings().then((s: any) => {
      const c = s?.compressor;
      if (c) {
        if (typeof c.crf === "number") setCrf(c.crf);
        if (typeof c.codec === "string") setCodec(c.codec);
        if (typeof c.aiUpscale === "boolean") setAi(c.aiUpscale);
        if (typeof c.aiScale === "string") setAiScale(c.aiScale);
        if (typeof c.aiModel === "string") setAiModel(c.aiModel);
        if (typeof c.gpuFirst === "boolean") setGpuFirst(c.gpuFirst);
      }
    }).catch(() => { /* дефолты из кода */ });
    // Статус Real-ESRGAN (для кнопки скачивания модели).
    api.compressorAiStatus().then(setAiInfo).catch(() => {});
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  // Пока модель качается — опрашиваем прогресс.
  useEffect(() => {
    if (!aiInfo?.downloading) return;
    const t = window.setInterval(() => {
      api.compressorAiStatus().then((s) => { setAiInfo(s); if (!s.downloading) window.clearInterval(t); }).catch(() => {});
    }, 1200);
    return () => window.clearInterval(t);
  }, [aiInfo?.downloading]);

  const aiDownload = async () => {
    try { await api.compressorAiDownload(); setAiInfo((p) => p ? { ...p, downloading: true, progress: 0, error: "" } : p); } catch { /* уже качается */ }
  };

  // Опрос статуса активного задания.
  const startPolling = (id: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const j = await api.compressorStatus(id);
        setJob(j);
        if (j.done || j.stage === "error") {
          window.clearInterval(pollRef.current!);
          pollRef.current = null;
        }
      } catch { /* сеть моргнула — попробуем на следующем тике */ }
    }, 1000);
  };

  const pick = (f: File | null) => {
    setFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
    setJob(null);
  };

  const start = async () => {
    if (!file) return;
    setDefect("");
    try {
      const j = await api.compressVideo(file, { crf, codec, targetHeight: targetH, aiUpscale: ai, aiScale, aiModel, gpuFirst });
      setJob(j);
      startPolling(j.id);
    } catch (e: any) {
      setDefect(String(e.message || e));
    }
  };

  // М5: «Reveal in File Explorer» через IPC-shell; путь отдаёт сервер.
  const reveal = async (id: string) => {
    try {
      const { path } = await api.compressorReveal(id);
      const br = (window as any).appBridge;
      if (br?.revealPath) await br.revealPath(path);
      else copyToClipboard(path); // вне Electron — хотя бы путь в буфер
    } catch { /* не готово */ }
  };

  usePageToolbar(
    <>
      <Badge tone="violet" mono>{t("cmp.badge")}</Badge>
      <Btn icon={Info} onClick={() => setGuide(true)}>{t("cmp.howItWorks")}</Btn>
    </>,
    [t]
  );

  const tone = crfTone(crf);
  const saved = job?.done && job.size ? Math.round(100 - (100 * job.outSize) / job.size) : null;
  const done = job?.done;
  const busy = !!job && !done && job.stage !== "error";

  return (
    <div className="page">
      <SectionHead eyebrow={t("cmp.eyebrow")} title={t("cmp.title")} />

      {/* --- Дропзона с превью и бейджами файла --- */}
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
        <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}
          onContextMenu={(e) => menu.open(e, [
            { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(file.name) },
            { label: t("cmp.rechoose"), icon: X, onClick: () => pick(null) },
          ])}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {previewUrl && <video src={previewUrl} controls style={{ width: 260, borderRadius: 10 }} />}
            <div style={{ flex: 1 }}>
              <div className="media-title">{file.name}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <Badge tone="violet">{t("cmp.original")}: {fmtMB(file.size)}</Badge>
                <Badge tone="amber">{t("cmp.type")}: {file.type || "video/*"}</Badge>
              </div>
            </div>
          </div>

          {/* --- CRF слайдер с цветовой зоной качества --- */}
          <div>
            <div className="field-label">{t("cmp.crf", { v: crf })}</div>
            <input type="range" min="0" max="50" step="1" value={crf}
              onChange={(e) => setCrf(parseInt(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <Badge tone={tone.tone}>{t(tone.key)}</Badge>
              {(crf >= 20 && crf <= 25) && <Badge tone="teal">★ {t("cmp.crfBest")}</Badge>}
            </div>
          </div>

          <div className="cmp-controls">
            <Field label={t("cmp.codec")}>
              <Select value={codec} onChange={(e) => setCodec(e.target.value)} options={["av1", "hevc", "h264"]} />
            </Field>
            <Field label={t("cmp.resolution")}>
              <Select value={targetH} onChange={(e) => setTargetH(e.target.value)} options={["original", "1080", "720", "480"]} />
            </Field>
            <Field label={t("cmp.aiScale")}>
              <Select value={aiScale} onChange={(e) => setAiScale(e.target.value)} options={["2x", "4x"]} />
            </Field>
            <Field label={t("cmp.aiModel")}>
              <Select value={aiModel} onChange={(e) => setAiModel(e.target.value)} options={["realesr-animevideov3-x4", "realesr-animevideov3-x2", "realesrgan-x4plus-anime", "realesrgan-x4plus"]} />
            </Field>
          </div>

          {/* --- ИИ-апскейл: стилизованный тумблер + статус/скачивание модели --- */}
          <div className="cmp-ai-row">
            <button type="button" className={`option-item ${ai ? "is-on" : ""}`}
              onClick={() => setAi(!ai)} aria-pressed={ai}>
              <Sparkles size={15} strokeWidth={2} />
              <span>{t("cmp.aiUpscale")}</span>
              <span className={`cmp-switch ${ai ? "on" : ""}`} />
            </button>
            {/* Быстрое кодирование: NVENC впереди программных энкодеров. */}
            <button type="button" className={`option-item ${gpuFirst ? "is-on" : ""}`}
              onClick={() => setGpuFirst(!gpuFirst)} aria-pressed={gpuFirst} title={t("cmp.gpuFirstHint")}>
              <Zap size={15} strokeWidth={2} />
              <span>{t("cmp.gpuFirst")}</span>
              <span className={`cmp-switch ${gpuFirst ? "on" : ""}`} />
            </button>
            {ai && aiInfo && !aiInfo.installed && !aiInfo.downloading && (
              <Btn icon={Download} onClick={aiDownload}>{t("cmp.aiDownload")}</Btn>
            )}
            {ai && aiInfo?.downloading && (
              <div className="cmp-ai-progress">
                <span className="muted-sm">{t("cmp.aiDownloading", { p: aiInfo.progress })}</span>
                <ProgressBar value={aiInfo.progress} />
              </div>
            )}
            {ai && aiInfo?.installed && <Badge tone="teal">✓ {t("cmp.aiReady")}</Badge>}
            {ai && aiInfo?.error && <span className="muted-sm" style={{ color: "var(--coral)" }}>{aiInfo.error}</span>}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn variant="primary" icon={Gauge} onClick={start} disabled={busy}>
              {busy ? t("cmp.compressing") : t("cmp.compress")}
           </Btn>
          </div>
        </Glass>
      )}

      {/* --- Прогресс 3 ступеней --- */}
      {busy && job && (
        <Glass className="chart-panel">
          <div className="muted-sm" style={{ marginBottom: 8 }}>
            {t("cmp.step", { n: job.step || 1, stage: t(`cmp.stage_${job.stage === "queued" ? "queued" : job.stage}`) })}
            {job.etaSec != null && job.etaSec > 0 ? ` · ETA ${Math.max(1, Math.ceil(job.etaSec / 60))} min` : ""}
          </div>
          <ProgressBar value={job.progress} />
          {job.aiSkipped && <div className="muted-sm" style={{ marginTop: 8 }}>{t("cmp.aiSkipped")}</div>}
        </Glass>
      )}

      {job?.stage === "error" && (
        <Glass><span style={{ color: "var(--coral)" }}>
          {job.error === "ffmpeg_missing" ? t("cmp.ffmpegMissing") : `${t("cmp.error")}: ${job.error}`}
        </span></Glass>
      )}

      {/* --- Результат: сравнение, скачивание, контекстное меню --- */}
      {done && job && (
        <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}
          onContextMenu={(e) => menu.open(e, [
            { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(job.name) },
            { label: t("ctx.copyPath"), icon: Copy, onClick: async () => { try { const r = await api.compressorReveal(job.id); copyToClipboard(r.path); } catch { /* */ } } },
            { label: t("ctx.reveal"), icon: FolderOpen, onClick: () => reveal(job.id) },
            { label: t("cmp.compare"), icon: Columns2, onClick: () => window.open(api.compressorUrl(job.id, "preview"), "_blank") },
            { separator: true },
            { label: t("cmp.download"), icon: Download, onClick: () => { window.location.href = api.compressorUrl(job.id, "download"); } },
            { label: t("cmp.delete"), icon: Trash2, danger: true, onClick: async () => { await api.compressorDelete(job.id); pick(null); setJob(null); } },
          ])}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {previewUrl && (
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="field-label">{t("cmp.original")} · {fmtMB(job.size)}</div>
                <video src={previewUrl} controls style={{ width: "100%", borderRadius: 10 }} />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="field-label">
                {t("cmp.result")} · {fmtMB(job.outSize)}{" "}
                {saved != null && <Badge tone="teal">−{saved}%</Badge>}
              </div>
              <video src={api.compressorUrl(job.id, "preview")} controls style={{ width: "100%", borderRadius: 10 }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="primary" icon={Download} onClick={() => { window.location.href = api.compressorUrl(job.id, "download"); }}>
              {t("cmp.download")}
            </Btn>
            <Btn icon={FileVideo} onClick={() => pick(null)}>{t("cmp.newVideo")}</Btn>
          </div>
        </Glass>
      )}

      {defect && <Glass><span style={{ color: "var(--coral)" }}>{defect}</span></Glass>}

      {/* --- Модалка «Как это работает и настройка» --- */}
      {guide && (
        <div className="modal-overlay" onClick={() => setGuide(false)}>
          <Glass className="modal-panel" onClick={(e: any) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="media-title">{t("cmp.guideTitle")}</div>
              <button onClick={() => setGuide(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", display: "flex" }}><X size={16} /></button>
            </div>
            <p className="muted-sm">{t("cmp.guide1")}</p>
            <p className="muted-sm">{t("cmp.guide2")}</p>
            <p className="muted-sm">{t("cmp.guide3")}</p>
            <p className="muted-sm">{t("cmp.guide4")}</p>
          </Glass>
        </div>
      )}

      {!file && !job && <EmptyHint icon={MonitorPlay} text={t("cmp.empty")} />}
    </div>
  );
}

// Локальный Field — обёртка label+control (как на других страницах).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 130 }}>
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}