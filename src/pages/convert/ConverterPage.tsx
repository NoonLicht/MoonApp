import React, { useState, useEffect, useMemo, useRef } from "react";
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
  );
}

/**
 * Редактор изображений (кроп/ресайз/водяной знак) — через ffmpeg
 * (server/ts/imageEditor.ts), без нового пакета обработки изображений.
 */
function ImageEditorToolkit() {
  const { t } = useI18n();

  const [cropFile, setCropFile] = useState<File | null>(null);
  const [box, setBox] = useState({ x: "0", y: "0", w: "0", h: "0" });
  const [cropBusy, setCropBusy] = useState(false);
  const [cropError, setCropError] = useState("");

  const [resizeFile, setResizeFile] = useState<File | null>(null);
  const [size, setSize] = useState({ w: "", h: "" });
  const [resizeBusy, setResizeBusy] = useState(false);
  const [resizeError, setResizeError] = useState("");

  const [wmFile, setWmFile] = useState<File | null>(null);
  const [wmMark, setWmMark] = useState<File | null>(null);
  const [wmPosition, setWmPosition] = useState("bottom-right");
  const [wmOpacity, setWmOpacity] = useState("0.6");
  const [wmBusy, setWmBusy] = useState(false);
  const [wmError, setWmError] = useState("");

  const doCrop = async () => {
    if (!cropFile) return;
    setCropBusy(true);
    setCropError("");
    try {
      const blob = await api.imageCrop(cropFile, {
        x: parseInt(box.x, 10) || 0,
        y: parseInt(box.y, 10) || 0,
        w: parseInt(box.w, 10) || 0,
        h: parseInt(box.h, 10) || 0,
      });
      saveBlob(blob, `cropped_${cropFile.name}`);
    } catch (e) {
      setCropError((e as Error).message);
    } finally {
      setCropBusy(false);
    }
  };

  const doResize = async () => {
    if (!resizeFile) return;
    setResizeBusy(true);
    setResizeError("");
    try {
      const blob = await api.imageResize(resizeFile, {
        w: parseInt(size.w, 10) || 0,
        h: parseInt(size.h, 10) || 0,
      });
      saveBlob(blob, `resized_${resizeFile.name}`);
    } catch (e) {
      setResizeError((e as Error).message);
    } finally {
      setResizeBusy(false);
    }
  };

  const doWatermark = async () => {
    if (!wmFile || !wmMark) return;
    setWmBusy(true);
    setWmError("");
    try {
      const blob = await api.imageWatermark(
        wmFile,
        wmMark,
        wmPosition,
        parseFloat(wmOpacity) || 0.6,
      );
      saveBlob(blob, `watermarked_${wmFile.name}`);
    } catch (e) {
      setWmError((e as Error).message);
    } finally {
      setWmBusy(false);
    }
  };

  return (
    <>
      <SectionHead eyebrow={t("conv.imgEyebrow")} title={t("conv.imgTitle")} />

      {/* --- Кроп --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.imgCrop")}</div>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setCropFile(e.target.files?.[0] || null)}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["x", "y", "w", "h"] as const).map((k) => (
            <input
              key={k}
              className="text-input"
              style={{ width: 90 }}
              placeholder={k.toUpperCase()}
              value={box[k]}
              onChange={(e) => setBox((b) => ({ ...b, [k]: e.target.value }))}
            />
          ))}
        </div>
        <Btn
          variant="primary"
          icon={cropBusy ? RefreshCw : FileUp}
          disabled={!cropFile || cropBusy}
          onClick={() => void doCrop()}
          style={{ width: 200 }}
        >
          {cropBusy ? t("conv.pdfWorking") : t("conv.imgCropGo")}
        </Btn>
        {cropError && <div style={{ color: "var(--coral)" }}>{cropError}</div>}
      </Glass>

      {/* --- Ресайз --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.imgResize")}</div>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setResizeFile(e.target.files?.[0] || null)}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="text-input"
            style={{ width: 100 }}
            placeholder={t("conv.imgWidth")}
            value={size.w}
            onChange={(e) => setSize((s) => ({ ...s, w: e.target.value }))}
          />
          <input
            className="text-input"
            style={{ width: 100 }}
            placeholder={t("conv.imgHeight")}
            value={size.h}
            onChange={(e) => setSize((s) => ({ ...s, h: e.target.value }))}
          />
        </div>
        <Btn
          variant="primary"
          icon={resizeBusy ? RefreshCw : FileUp}
          disabled={!resizeFile || resizeBusy}
          onClick={() => void doResize()}
          style={{ width: 200 }}
        >
          {resizeBusy ? t("conv.pdfWorking") : t("conv.imgResizeGo")}
        </Btn>
        {resizeError && <div style={{ color: "var(--coral)" }}>{resizeError}</div>}
      </Glass>

      {/* --- Водяной знак --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.imgWatermark")}</div>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setWmFile(e.target.files?.[0] || null)}
        />
        <div className="muted-sm">{t("conv.imgWatermarkFile")}</div>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setWmMark(e.target.files?.[0] || null)}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Select
            value={wmPosition}
            onChange={(e) => setWmPosition(e.target.value)}
            options={[
              { value: "top-left", label: t("conv.imgPosTopLeft") },
              { value: "top-right", label: t("conv.imgPosTopRight") },
              { value: "bottom-left", label: t("conv.imgPosBottomLeft") },
              { value: "bottom-right", label: t("conv.imgPosBottomRight") },
              { value: "center", label: t("conv.imgPosCenter") },
            ]}
          />
          <input
            className="text-input"
            style={{ width: 90 }}
            placeholder={t("conv.imgOpacity")}
            value={wmOpacity}
            onChange={(e) => setWmOpacity(e.target.value)}
          />
        </div>
        <Btn
          variant="primary"
          icon={wmBusy ? RefreshCw : FileUp}
          disabled={!wmFile || !wmMark || wmBusy}
          onClick={() => void doWatermark()}
          style={{ width: 200 }}
        >
          {wmBusy ? t("conv.pdfWorking") : t("conv.imgWatermarkGo")}
        </Btn>
        {wmError && <div style={{ color: "var(--coral)" }}>{wmError}</div>}
      </Glass>
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
