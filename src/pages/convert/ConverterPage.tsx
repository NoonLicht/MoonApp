import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Repeat,
  Check,
  AlertTriangle,
  RefreshCw,
  FileUp,
  Terminal,
  Copy,
  Download,
  X,
  Crop as CropIcon,
  Maximize2,
  Link2,
  Unlink,
} from "lucide-react";
import {
  Glass,
  Btn,
  Badge,
  Field,
  Select,
  SectionHead,
  EmptyHint,
  ProgressBar,
  Checkbox,
} from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
import type { ConvertTools, ConvertResult, ConvertInstallStatus } from "@/api/types";

const CAT_TONE: Record<string, string> = { video: "amber", audio: "violet", image: "teal" };

function fmtSize(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Страница конвертации файлов — полностью нативный модуль приложения.
 * Конвертация выполняется локально через FFmpeg (обнаруживается автоматически
 * или берётся из настроек converter.ffmpegPath). Внешние сервисы и загрузка
 * рантайма не нужны: файл не покидает машину.
 */
export default function ConverterPage() {
  const { t } = useI18n();
  const menu = useContextMenu();

  const [tools, setTools] = useState<ConvertTools | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [to, setTo] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ConvertResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [install, setInstall] = useState<ConvertInstallStatus | null>(null);

  // Статус FFmpeg + каталог форматов с бэкенда.
  useEffect(() => {
    let alive = true;
    api
      .getConvertTools()
      .then((d) => {
        if (alive) setTools(d);
      })
      .catch(() => {
        if (alive) setTools(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const ffmpegFound = !!tools?.ffmpeg?.found;

  // Поллинг прогресса установки FFmpeg, пока она идёт на бэкенде.
  useEffect(() => {
    if (install?.state !== "working") return;
    const timer = setInterval(async () => {
      try {
        const st = await api.getConvertInstall();
        setInstall(st);
        if (st.state === "done") {
          // Установленный бинарь — сбросим кэш детекта и перечитаем tools.
          const fresh = await api.getConvertTools();
          setTools(fresh);
        }
      } catch {
        /* пропускаем опрос */
      }
    }, 900);
    return () => clearInterval(timer);
  }, [install?.state]);

  const startInstall = async () => {
    try {
      const st = await api.startConvertInstall();
      setInstall(st);
    } catch (err) {
      setError((err as Error).message || String(err));
      setState("error");
    }
  };

  // Категория выбранного файла → список доступных целевых форматов.
  const category = useMemo(() => {
    if (!file || !tools) return null;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    return tools.categories.find((c) => c.inputs.includes(ext)) || null;
  }, [file, tools]);

  const pickFile = (f: File | null) => {
    setFile(f);
    setError("");
    setResult(null);
    setState("idle");
    setTo("");
  };

  const onSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    pickFile(f);
    // Сбросим input, чтобы можно было выбрать тот же файл снова.
    if (e.target) e.target.value = "";
  };
  const convert = async () => {
    if (!file || !to) return;
    setState("working");
    setError("");
    try {
      const r = await api.uploadConvert(file, to);
      setResult(r);
      setState("done");
    } catch (err) {
      setError((err as Error).message || String(err));
      setState("error");
    }
  };

  const download = async () => {
    if (!result) return;
    try {
      const { blob, name } = await api.downloadConvert(result.key);
      // Единый путь скачивания (src/utils/download.ts), см. MusicPage.
      saveBlob(blob, name);
    } catch (err) {
      setError((err as Error).message || String(err));
      setState("error");
    }
  };

  return (
    <div className="page">
      <SectionHead eyebrow={t("conv.eyebrow")} title={t("conv.title")} />

      <div className="page-scroll-body">
      {tools && !ffmpegFound && (
        <Glass
          className="source-placeholder"
          style={{
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 8,
            borderColor: "var(--coral)",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text-primary)",
              fontWeight: 600,
            }}
          >
            <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
            {t("conv.ffmpegMissing")}
          </span>
          <span className="muted-sm">{t("conv.ffmpegHint")}</span>

          {install?.state === "working" ? (
            <div className="install-progress">
              <div className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <RefreshCw size={14} className="spin" />
                {install.phase === "extract"
                  ? t("conv.installing")
                  : t("conv.downloading", { p: install.progress })}
              </div>
              <ProgressBar value={install.progress} />
            </div>
          ) : (
            <Btn variant="primary" icon={Terminal} onClick={startInstall} style={{ width: 220 }}>
              {t("conv.install")}
            </Btn>
          )}

          {install?.state === "error" && (
            <span className="muted-sm" style={{ color: "var(--coral)" }}>
              {install.error}
            </span>
          )}
        </Glass>
      )}

      {/* Dropzone — как на странице голоса. */}
      <div
        className={`dropzone ${file ? "has-file" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0] || null;
          if (f) pickFile(f);
        }}
        role="button"
        tabIndex={0}
      >
        <input ref={inputRef} type="file" hidden onChange={onSelect} />
        {file ? (
          <>
            <FileUp size={24} strokeWidth={1.6} />
            <div className="dropzone-file">{file.name}</div>
            <span className="muted-sm">{t("conv.replace")}</span>
          </>
        ) : (
          <>
            <Repeat size={24} strokeWidth={1.6} />
            <div>{t("conv.drop")}</div>
            <span className="muted-sm">{t("conv.orBrowse")}</span>
          </>
        )}
      </div>

      {file && category && (
        <Glass
          className="media-preview"
          onContextMenu={(e) =>
            menu.open(e, [
              { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(file.name) },
              result && {
                label: t("conv.download"),
                icon: Download,
                onClick: () => void download(),
              },
              { separator: true },
              { label: t("ctx.clear"), icon: X, danger: true, onClick: () => pickFile(null) },
            ])
          }
        >
          <div className={`media-thumb tone-${CAT_TONE[category.id] || "violet"}`}>
            <Repeat size={26} strokeWidth={1.5} />
          </div>
          <div className="media-info">
            <div className="media-title">{file.name}</div>
            <div className="muted-sm">
              {fmtSize(file.size)} ·{" "}
              <Badge tone={CAT_TONE[category.id] || "violet"} mono>
                {category.id}
              </Badge>
            </div>

            <div className="quality-row">
              <Field label={t("conv.to")} w={200}>
                <Select
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  options={category.outputs.map((o) => ({ value: o, label: o.toUpperCase() }))}
                />
              </Field>
            </div>

            {state === "working" && (
              <div className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <RefreshCw size={14} className="spin" />
                {t("conv.converting", { fmt: to.toUpperCase() })}
              </div>
            )}

            {state === "done" && result && (
              <div className="muted-sm" style={{ color: "var(--success)" }}>
                ✓ {t("conv.ready")} · {result.name} · {fmtSize(result.size)}
              </div>
            )}

            {state === "done" && result ? (
              <Btn variant="primary" icon={Check} onClick={download}>
                {t("conv.download")}
              </Btn>
            ) : (
              <Btn
                variant="primary"
                icon={state === "working" ? RefreshCw : Repeat}
                onClick={convert}
                disabled={!ffmpegFound || !to || state === "working"}
                style={{ width: 220 }}
              >
                {state === "working"
                  ? t("conv.converting", { fmt: to.toUpperCase() })
                  : t("conv.convertTo", { fmt: to.toUpperCase() })}
              </Btn>
            )}
          </div>
        </Glass>
      )}

      {file && !category && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{t("conv.noSupport")}</span>
        </Glass>
      )}

      {error && state === "error" && (
        <Glass
          className="source-placeholder"
          style={{ borderColor: "var(--coral)", color: "var(--text-secondary)" }}
        >
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{error}</span>
        </Glass>
      )}

      {!file && <EmptyHint icon={Repeat} text={t("conv.empty")} />}

      <ImageEditorToolkit />
      <PdfToolkit />
      </div>
    </div>
  );
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Визуальный выбор области обрезки: тащим прямоугольник прямо по превью
 * картинки, координаты сразу пересчитываются в реальные пиксели файла. */
function CropTool() {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [rect, setRect] = useState<CropRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    setRect(null);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const toImagePoint = (e: React.MouseEvent) => {
    const img = imgRef.current;
    if (!img) return null;
    const b = img.getBoundingClientRect();
    const scaleX = natural.w / b.width;
    const scaleY = natural.h / b.height;
    const x = Math.max(0, Math.min(natural.w, (e.clientX - b.left) * scaleX));
    const y = Math.max(0, Math.min(natural.h, (e.clientY - b.top) * scaleY));
    return { x, y };
  };

  const onDown = (e: React.MouseEvent) => {
    const p = toImagePoint(e);
    if (!p) return;
    dragStart.current = p;
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: React.MouseEvent) => {
    if (!dragStart.current) return;
    const p = toImagePoint(e);
    if (!p) return;
    const s = dragStart.current;
    setRect({
      x: Math.round(Math.min(s.x, p.x)),
      y: Math.round(Math.min(s.y, p.y)),
      w: Math.round(Math.abs(p.x - s.x)),
      h: Math.round(Math.abs(p.y - s.y)),
    });
  };
  const onUp = () => {
    dragStart.current = null;
  };

  const doCrop = async () => {
    if (!file || !rect || rect.w < 2 || rect.h < 2) return;
    setBusy(true);
    setError("");
    try {
      const blob = await api.imageCrop(file, rect);
      saveBlob(blob, `cropped_${file.name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Проценты вместо пикселей — не нужно читать getBoundingClientRect() во
  // время рендера (ref.current меняется только в событиях/эффектах), и
  // рамка сама остаётся на месте при ресайзе окна без лишних измерений.
  const displayRect = useMemo(() => {
    if (!rect || !natural.w || !natural.h) return null;
    return {
      left: `${(rect.x / natural.w) * 100}%`,
      top: `${(rect.y / natural.h) * 100}%`,
      width: `${(rect.w / natural.w) * 100}%`,
      height: `${(rect.h / natural.h) * 100}%`,
    };
  }, [rect, natural]);

  return (
    <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div className="media-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CropIcon size={16} />
        {t("conv.imgCrop")}
      </div>
      <div className="muted-sm">{t("conv.imgCropHint")}</div>
      <input
        type="file"
        accept="image/*"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
      />
      {url && (
        <div
          className="img-edit-canvas-wrap"
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
        >
          <img
            ref={imgRef}
            src={url}
            alt=""
            draggable={false}
            className="img-edit-preview"
            onLoad={(e) => {
              const im = e.currentTarget;
              setNatural({ w: im.naturalWidth, h: im.naturalHeight });
            }}
          />
          {displayRect && (
            <div
              className="img-edit-crop-rect"
              style={{
                left: displayRect.left,
                top: displayRect.top,
                width: displayRect.width,
                height: displayRect.height,
              }}
            />
          )}
        </div>
      )}
      {rect && rect.w > 1 && rect.h > 1 && (
        <div className="muted-sm">
          {t("conv.imgCropSize", { w: rect.w, h: rect.h })}
        </div>
      )}
      <Btn
        variant="primary"
        icon={busy ? RefreshCw : FileUp}
        disabled={!file || !rect || rect.w < 2 || rect.h < 2 || busy}
        onClick={() => void doCrop()}
        style={{ width: 220 }}
      >
        {busy ? t("conv.pdfWorking") : t("conv.imgCropGo")}
      </Btn>
      {error && <div style={{ color: "var(--coral)" }}>{error}</div>}
    </Glass>
  );
}

/** Ресайз с превью, показом текущих/новых размеров и опциональной блокировкой
 * соотношения сторон. */
function ResizeTool() {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [size, setSize] = useState({ w: "", h: "" });
  const [lockRatio, setLockRatio] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    setSize({ w: "", h: "" });
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const onWidthChange = useCallback(
    (v: string) => {
      setSize((s) => {
        if (lockRatio && natural.w && natural.h && v) {
          const w = parseInt(v, 10) || 0;
          const h = Math.round((w * natural.h) / natural.w);
          return { w: v, h: String(h) };
        }
        return { ...s, w: v };
      });
    },
    [lockRatio, natural],
  );
  const onHeightChange = useCallback(
    (v: string) => {
      setSize((s) => {
        if (lockRatio && natural.w && natural.h && v) {
          const h = parseInt(v, 10) || 0;
          const w = Math.round((h * natural.w) / natural.h);
          return { w: String(w), h: v };
        }
        return { ...s, h: v };
      });
    },
    [lockRatio, natural],
  );

  const doResize = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const blob = await api.imageResize(file, {
        w: parseInt(size.w, 10) || 0,
        h: parseInt(size.h, 10) || 0,
      });
      saveBlob(blob, `resized_${file.name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div className="media-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Maximize2 size={16} />
        {t("conv.imgResize")}
      </div>
      <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      {url && (
        <div className="img-edit-resize-preview">
          <img
            src={url}
            alt=""
            onLoad={(e) => {
              const im = e.currentTarget;
              setNatural({ w: im.naturalWidth, h: im.naturalHeight });
            }}
          />
          {natural.w > 0 && (
            <div className="muted-sm">
              {t("conv.imgCurrentSize", { w: natural.w, h: natural.h })}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="text-input"
          style={{ width: 100 }}
          type="number"
          placeholder={t("conv.imgWidth")}
          value={size.w}
          onChange={(e) => onWidthChange(e.target.value)}
        />
        {lockRatio ? <Link2 size={14} /> : <Unlink size={14} />}
        <input
          className="text-input"
          style={{ width: 100 }}
          type="number"
          placeholder={t("conv.imgHeight")}
          value={size.h}
          onChange={(e) => onHeightChange(e.target.value)}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <Checkbox checked={lockRatio} onClick={() => setLockRatio((v) => !v)} />
          <span className="muted-sm">{t("conv.imgLockRatio")}</span>
        </label>
      </div>
      <Btn
        variant="primary"
        icon={busy ? RefreshCw : FileUp}
        disabled={!file || !size.w || !size.h || busy}
        onClick={() => void doResize()}
        style={{ width: 220 }}
      >
        {busy ? t("conv.pdfWorking") : t("conv.imgResizeGo")}
      </Btn>
      {error && <div style={{ color: "var(--coral)" }}>{error}</div>}
    </Glass>
  );
}

/**
 * Редактор изображений (кроп/ресайз) — через ffmpeg (server/ts/imageEditor.ts),
 * без нового пакета обработки изображений.
 */
function ImageEditorToolkit() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead eyebrow={t("conv.imgEyebrow")} title={t("conv.imgTitle")} />
      <CropTool />
      <ResizeTool />
    </>
  );
}

/**
 * PDF-тулкит: слияние/разбиение (pdf-lib) и извлечение текстового слоя
 * (pdf-parse) — server/ts/pdfTools.ts. Независим от FFmpeg-конвертера выше:
 * своя мини-форма на каждую операцию. OCR намеренно не реализован (нет
 * OCR-зависимости в проекте) — честно помечен как недоступный, а не заглушка.
 */
function PdfToolkit() {
  const { t } = useI18n();
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState("");

  const [splitFile, setSplitFile] = useState<File | null>(null);
  const [ranges, setRanges] = useState("");
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState("");

  const [textFile, setTextFile] = useState<File | null>(null);
  const [textBusy, setTextBusy] = useState(false);
  const [textError, setTextError] = useState("");
  const [extractedText, setExtractedText] = useState<string | null>(null);

  const doMerge = async () => {
    if (mergeFiles.length < 2) return;
    setMergeBusy(true);
    setMergeError("");
    try {
      const blob = await api.pdfMerge(mergeFiles);
      saveBlob(blob, "merged.pdf");
    } catch (e) {
      setMergeError((e as Error).message);
    } finally {
      setMergeBusy(false);
    }
  };

  const doSplit = async () => {
    if (!splitFile || !ranges.trim()) return;
    setSplitBusy(true);
    setSplitError("");
    try {
      const blob = await api.pdfSplit(splitFile, ranges.trim());
      saveBlob(blob, "split.zip");
    } catch (e) {
      setSplitError((e as Error).message);
    } finally {
      setSplitBusy(false);
    }
  };

  const doExtract = async () => {
    if (!textFile) return;
    setTextBusy(true);
    setTextError("");
    setExtractedText(null);
    try {
      const result = await api.pdfExtractText(textFile);
      setExtractedText(result.text);
    } catch (e) {
      setTextError((e as Error).message);
    } finally {
      setTextBusy(false);
    }
  };

  const downloadText = () => {
    if (extractedText == null) return;
    const blob = new Blob([extractedText], { type: "text/plain;charset=utf-8" });
    saveBlob(blob, (textFile?.name.replace(/\.pdf$/i, "") || "text") + ".txt");
  };

  return (
    <>
      <SectionHead eyebrow={t("conv.pdfEyebrow")} title={t("conv.pdfTitle")} />

      {/* --- Слияние --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfMerge")}</div>
        <input
          type="file"
          accept="application/pdf"
          multiple
          onChange={(e) => setMergeFiles(Array.from(e.target.files || []))}
        />
        {mergeFiles.length > 0 && (
          <div className="muted-sm">{t("conv.pdfFilesChosen", { n: mergeFiles.length })}</div>
        )}
        <Btn
          variant="primary"
          icon={mergeBusy ? RefreshCw : FileUp}
          disabled={mergeFiles.length < 2 || mergeBusy}
          onClick={() => void doMerge()}
          style={{ width: 220 }}
        >
          {mergeBusy ? t("conv.pdfWorking") : t("conv.pdfMergeGo")}
        </Btn>
        {mergeError && <div style={{ color: "var(--coral)" }}>{mergeError}</div>}
      </Glass>

      {/* --- Разбиение --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfSplit")}</div>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setSplitFile(e.target.files?.[0] || null)}
        />
        <input
          className="text-input"
          placeholder={t("conv.pdfRangesPlaceholder")}
          value={ranges}
          onChange={(e) => setRanges(e.target.value)}
        />
        <Btn
          variant="primary"
          icon={splitBusy ? RefreshCw : FileUp}
          disabled={!splitFile || !ranges.trim() || splitBusy}
          onClick={() => void doSplit()}
          style={{ width: 220 }}
        >
          {splitBusy ? t("conv.pdfWorking") : t("conv.pdfSplitGo")}
        </Btn>
        {splitError && <div style={{ color: "var(--coral)" }}>{splitError}</div>}
      </Glass>

      {/* --- Извлечение текста --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfExtractText")}</div>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => {
            setTextFile(e.target.files?.[0] || null);
            setExtractedText(null);
          }}
        />
        <Btn
          variant="primary"
          icon={textBusy ? RefreshCw : FileUp}
          disabled={!textFile || textBusy}
          onClick={() => void doExtract()}
          style={{ width: 220 }}
        >
          {textBusy ? t("conv.pdfWorking") : t("conv.pdfExtractGo")}
        </Btn>
        {textError && <div style={{ color: "var(--coral)" }}>{textError}</div>}
        {extractedText != null && (
          <>
            <textarea
              className="text-input"
              readOnly
              rows={8}
              value={extractedText || t("conv.pdfNoTextLayer")}
            />
            <Btn icon={Download} onClick={downloadText} style={{ width: 200 }}>
              {t("conv.pdfDownloadText")}
            </Btn>
          </>
        )}
      </Glass>

      <div className="muted-sm">{t("conv.pdfOcrHint")}</div>
    </>
  );
}
