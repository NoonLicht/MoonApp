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
  Upload,
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

      <PdfToolkit />
      <OfficeToolkit />
      </div>
    </div>
  );
}

/** Стилизованная кнопка выбора файла — обёртка над голым <input type=file>,
 * которого до этого не было видно среди остального UI приложения. */
function FilePickButton({
  accept,
  multiple,
  label,
  onPick,
}: {
  accept?: string;
  multiple?: boolean;
  label: string;
  onPick: (files: FileList) => void;
}) {
  return (
    <label className="btn btn-secondary" style={{ cursor: "pointer", width: "fit-content" }}>
      <Upload size={14} />
      {label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onPick(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
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

  const [rotateFile, setRotateFile] = useState<File | null>(null);
  const [angle, setAngle] = useState("90");
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState("");

  const [organizeFile, setOrganizeFile] = useState<File | null>(null);
  const [order, setOrder] = useState("");
  const [organizeBusy, setOrganizeBusy] = useState(false);
  const [organizeError, setOrganizeError] = useState("");

  const [wmFile, setWmFile] = useState<File | null>(null);
  const [wmText, setWmText] = useState("");
  const [wmOpacity, setWmOpacity] = useState(0.25);
  const [wmBusy, setWmBusy] = useState(false);
  const [wmError, setWmError] = useState("");

  const [numFile, setNumFile] = useState<File | null>(null);
  const [startAt, setStartAt] = useState("1");
  const [numBusy, setNumBusy] = useState(false);
  const [numError, setNumError] = useState("");

  const [imgFiles, setImgFiles] = useState<File[]>([]);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState("");

  const [signFile, setSignFile] = useState<File | null>(null);
  const [sigImage, setSigImage] = useState<File | null>(null);
  const [signBusy, setSignBusy] = useState(false);
  const [signError, setSignError] = useState("");

  const [protFile, setProtFile] = useState<File | null>(null);
  const [protPassword, setProtPassword] = useState("");
  const [protBusy, setProtBusy] = useState(false);
  const [protError, setProtError] = useState("");
  const [qpdfFound, setQpdfFound] = useState<boolean | null>(null);

  const [unlFile, setUnlFile] = useState<File | null>(null);
  const [unlPassword, setUnlPassword] = useState("");
  const [unlBusy, setUnlBusy] = useState(false);
  const [unlError, setUnlError] = useState("");

  const [jpgFile, setJpgFile] = useState<File | null>(null);
  const [jpgBusy, setJpgBusy] = useState(false);
  const [jpgError, setJpgError] = useState("");

  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrReady, setOcrReady] = useState<{ fitz: boolean; paddleocr: boolean; gpu: boolean } | null>(null);
  const [ocrInstall, setOcrInstall] = useState<{ state: string; progress: number; phase: string; error: string } | null>(
    null,
  );

  useEffect(() => {
    api.pdfProtectStatus().then((s) => setQpdfFound(s.found)).catch(() => setQpdfFound(false));
    api.pdfOcrStatus().then(setOcrReady).catch(() => {});
  }, []);

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

  const doRotate = async () => {
    if (!rotateFile) return;
    setRotateBusy(true);
    setRotateError("");
    try {
      const blob = await api.pdfRotate(rotateFile, parseInt(angle, 10));
      saveBlob(blob, "rotated.pdf");
    } catch (e) {
      setRotateError((e as Error).message);
    } finally {
      setRotateBusy(false);
    }
  };

  const doOrganize = async () => {
    if (!organizeFile || !order.trim()) return;
    setOrganizeBusy(true);
    setOrganizeError("");
    try {
      const blob = await api.pdfOrganize(organizeFile, order.trim());
      saveBlob(blob, "organized.pdf");
    } catch (e) {
      setOrganizeError((e as Error).message);
    } finally {
      setOrganizeBusy(false);
    }
  };

  const doWatermark = async () => {
    if (!wmFile || !wmText.trim()) return;
    setWmBusy(true);
    setWmError("");
    try {
      const blob = await api.pdfWatermark(wmFile, wmText.trim(), wmOpacity);
      saveBlob(blob, "watermarked.pdf");
    } catch (e) {
      setWmError((e as Error).message);
    } finally {
      setWmBusy(false);
    }
  };

  const doPageNumbers = async () => {
    if (!numFile) return;
    setNumBusy(true);
    setNumError("");
    try {
      const blob = await api.pdfPageNumbers(numFile, parseInt(startAt, 10) || 1);
      saveBlob(blob, "numbered.pdf");
    } catch (e) {
      setNumError((e as Error).message);
    } finally {
      setNumBusy(false);
    }
  };

  const doImagesToPdf = async () => {
    if (imgFiles.length === 0) return;
    setImgBusy(true);
    setImgError("");
    try {
      const blob = await api.pdfImagesToPdf(imgFiles);
      saveBlob(blob, "images.pdf");
    } catch (e) {
      setImgError((e as Error).message);
    } finally {
      setImgBusy(false);
    }
  };

  const doSign = async () => {
    if (!signFile || !sigImage) return;
    setSignBusy(true);
    setSignError("");
    try {
      const blob = await api.pdfSign(signFile, sigImage);
      saveBlob(blob, "signed.pdf");
    } catch (e) {
      setSignError((e as Error).message);
    } finally {
      setSignBusy(false);
    }
  };

  const doProtect = async () => {
    if (!protFile || !protPassword) return;
    setProtBusy(true);
    setProtError("");
    try {
      const blob = await api.pdfProtect(protFile, protPassword);
      saveBlob(blob, "protected.pdf");
    } catch (e) {
      setProtError((e as Error).message);
    } finally {
      setProtBusy(false);
    }
  };

  const doUnlock = async () => {
    if (!unlFile || !unlPassword) return;
    setUnlBusy(true);
    setUnlError("");
    try {
      const blob = await api.pdfUnlock(unlFile, unlPassword);
      saveBlob(blob, "unlocked.pdf");
    } catch (e) {
      setUnlError((e as Error).message);
    } finally {
      setUnlBusy(false);
    }
  };

  const doToJpg = async () => {
    if (!jpgFile) return;
    setJpgBusy(true);
    setJpgError("");
    try {
      const blob = await api.pdfToJpg(jpgFile);
      saveBlob(blob, "pages.zip");
    } catch (e) {
      setJpgError((e as Error).message);
    } finally {
      setJpgBusy(false);
    }
  };

  const doOcr = async () => {
    if (!ocrFile) return;
    setOcrBusy(true);
    setOcrError("");
    setOcrText(null);
    try {
      const result = await api.pdfOcr(ocrFile);
      setOcrText(result.text);
    } catch (e) {
      setOcrError((e as Error).message);
    } finally {
      setOcrBusy(false);
    }
  };

  const startOcrInstall = async () => {
    const st = await api.pdfOcrInstall(true, "auto");
    setOcrInstall(st);
  };

  useEffect(() => {
    if (!ocrInstall || ocrInstall.state !== "working") return undefined;
    const timer = window.setInterval(() => {
      api
        .pdfOcrInstallStatus()
        .then((s) => {
          setOcrInstall(s);
          if (s.state === "done") {
            api.pdfOcrStatus().then(setOcrReady).catch(() => {});
          }
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ocrInstall]);

  return (
    <>
      <SectionHead eyebrow={t("conv.pdfEyebrow")} title={t("conv.pdfTitle")} />
      <div className="pdf-toolkit-grid">

      {/* --- Слияние --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfMerge")}</div>
        <FilePickButton
          accept="application/pdf"
          multiple
          label={t("automation.browse")}
          onPick={(files) => setMergeFiles(Array.from(files))}
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
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setSplitFile(files[0])}
        />
        {splitFile && <div className="muted-sm">{splitFile.name}</div>}
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
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => {
            setTextFile(files[0]);
            setExtractedText(null);
          }}
        />
        {textFile && <div className="muted-sm">{textFile.name}</div>}
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

      {/* --- Поворот --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfRotate")}</div>
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setRotateFile(files[0])}
        />
        {rotateFile && <div className="muted-sm">{rotateFile.name}</div>}
        <Select
          value={angle}
          onChange={(e) => setAngle(e.target.value)}
          options={["90", "180", "270"].map((a) => ({ value: a, label: `${a}°` }))}
        />
        <Btn
          variant="primary"
          icon={rotateBusy ? RefreshCw : FileUp}
          disabled={!rotateFile || rotateBusy}
          onClick={() => void doRotate()}
          style={{ width: 220 }}
        >
          {rotateBusy ? t("conv.pdfWorking") : t("conv.pdfRotateGo")}
        </Btn>
        {rotateError && <div style={{ color: "var(--coral)" }}>{rotateError}</div>}
      </Glass>

      {/* --- Организация страниц --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfOrganize")}</div>
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setOrganizeFile(files[0])}
        />
        {organizeFile && <div className="muted-sm">{organizeFile.name}</div>}
        <input
          className="text-input"
          placeholder={t("conv.pdfOrderPlaceholder")}
          value={order}
          onChange={(e) => setOrder(e.target.value)}
        />
        <div className="muted-sm">{t("conv.pdfOrderHint")}</div>
        <Btn
          variant="primary"
          icon={organizeBusy ? RefreshCw : FileUp}
          disabled={!organizeFile || !order.trim() || organizeBusy}
          onClick={() => void doOrganize()}
          style={{ width: 220 }}
        >
          {organizeBusy ? t("conv.pdfWorking") : t("conv.pdfOrganizeGo")}
        </Btn>
        {organizeError && <div style={{ color: "var(--coral)" }}>{organizeError}</div>}
      </Glass>

      {/* --- Водяной знак --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfWatermark")}</div>
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setWmFile(files[0])}
        />
        {wmFile && <div className="muted-sm">{wmFile.name}</div>}
        <input
          className="text-input"
          placeholder={t("conv.pdfWatermarkText")}
          value={wmText}
          onChange={(e) => setWmText(e.target.value)}
        />
        <Field label={t("conv.pdfWatermarkOpacity", { pct: Math.round(wmOpacity * 100) })}>
          <input
            type="range"
            min={0.05}
            max={0.8}
            step={0.05}
            value={wmOpacity}
            onChange={(e) => setWmOpacity(parseFloat(e.target.value))}
          />
        </Field>
        <Btn
          variant="primary"
          icon={wmBusy ? RefreshCw : FileUp}
          disabled={!wmFile || !wmText.trim() || wmBusy}
          onClick={() => void doWatermark()}
          style={{ width: 220 }}
        >
          {wmBusy ? t("conv.pdfWorking") : t("conv.pdfWatermarkGo")}
        </Btn>
        {wmError && <div style={{ color: "var(--coral)" }}>{wmError}</div>}
      </Glass>

      {/* --- Номера страниц --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfPageNumbers")}</div>
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setNumFile(files[0])}
        />
        {numFile && <div className="muted-sm">{numFile.name}</div>}
        <input
          className="text-input"
          type="number"
          min={1}
          placeholder={t("conv.pdfStartAt")}
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
        />
        <Btn
          variant="primary"
          icon={numBusy ? RefreshCw : FileUp}
          disabled={!numFile || numBusy}
          onClick={() => void doPageNumbers()}
          style={{ width: 220 }}
        >
          {numBusy ? t("conv.pdfWorking") : t("conv.pdfPageNumbersGo")}
        </Btn>
        {numError && <div style={{ color: "var(--coral)" }}>{numError}</div>}
      </Glass>

      {/* --- JPG/PNG в PDF --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfImagesToPdf")}</div>
        <FilePickButton
          accept="image/jpeg,image/png"
          multiple
          label={t("automation.browse")}
          onPick={(files) => setImgFiles(Array.from(files))}
        />
        {imgFiles.length > 0 && (
          <div className="muted-sm">{t("conv.pdfFilesChosen", { n: imgFiles.length })}</div>
        )}
        <Btn
          variant="primary"
          icon={imgBusy ? RefreshCw : FileUp}
          disabled={imgFiles.length === 0 || imgBusy}
          onClick={() => void doImagesToPdf()}
          style={{ width: 220 }}
        >
          {imgBusy ? t("conv.pdfWorking") : t("conv.pdfImagesToPdfGo")}
        </Btn>
        {imgError && <div style={{ color: "var(--coral)" }}>{imgError}</div>}
      </Glass>

      {/* --- PDF в JPG/PNG --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfToJpg")}</div>
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setJpgFile(files[0])}
        />
        {jpgFile && <div className="muted-sm">{jpgFile.name}</div>}
        <div className="muted-sm">{t("conv.pdfToJpgHint")}</div>
        <Btn
          variant="primary"
          icon={jpgBusy ? RefreshCw : FileUp}
          disabled={!jpgFile || jpgBusy}
          onClick={() => void doToJpg()}
          style={{ width: 220 }}
        >
          {jpgBusy ? t("conv.pdfWorking") : t("conv.pdfToJpgGo")}
        </Btn>
        {jpgError && <div style={{ color: "var(--coral)" }}>{jpgError}</div>}
      </Glass>

      {/* --- Подписать PDF (визуально) --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfSign")}</div>
        <div className="muted-sm">{t("conv.pdfSignHint")}</div>
        <FilePickButton
          accept="application/pdf"
          label={t("conv.pdfSignPickPdf")}
          onPick={(files) => setSignFile(files[0])}
        />
        {signFile && <div className="muted-sm">{signFile.name}</div>}
        <FilePickButton
          accept="image/png,image/jpeg"
          label={t("conv.pdfSignPickImage")}
          onPick={(files) => setSigImage(files[0])}
        />
        {sigImage && <div className="muted-sm">{sigImage.name}</div>}
        <Btn
          variant="primary"
          icon={signBusy ? RefreshCw : FileUp}
          disabled={!signFile || !sigImage || signBusy}
          onClick={() => void doSign()}
          style={{ width: 220 }}
        >
          {signBusy ? t("conv.pdfWorking") : t("conv.pdfSignGo")}
        </Btn>
        {signError && <div style={{ color: "var(--coral)" }}>{signError}</div>}
      </Glass>

      {/* --- Защита паролем --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfProtect")}</div>
        {qpdfFound === false && <div className="muted-sm">{t("conv.pdfQpdfMissing")}</div>}
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setProtFile(files[0])}
        />
        {protFile && <div className="muted-sm">{protFile.name}</div>}
        <input
          className="text-input"
          type="password"
          placeholder={t("conv.pdfPassword")}
          value={protPassword}
          onChange={(e) => setProtPassword(e.target.value)}
        />
        <Btn
          variant="primary"
          icon={protBusy ? RefreshCw : FileUp}
          disabled={!protFile || !protPassword || protBusy || qpdfFound === false}
          onClick={() => void doProtect()}
          style={{ width: 220 }}
        >
          {protBusy ? t("conv.pdfWorking") : t("conv.pdfProtectGo")}
        </Btn>
        {protError && <div style={{ color: "var(--coral)" }}>{protError}</div>}
      </Glass>

      {/* --- Снять пароль --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfUnlock")}</div>
        {qpdfFound === false && <div className="muted-sm">{t("conv.pdfQpdfMissing")}</div>}
        <FilePickButton
          accept="application/pdf"
          label={t("automation.browse")}
          onPick={(files) => setUnlFile(files[0])}
        />
        {unlFile && <div className="muted-sm">{unlFile.name}</div>}
        <input
          className="text-input"
          type="password"
          placeholder={t("conv.pdfPassword")}
          value={unlPassword}
          onChange={(e) => setUnlPassword(e.target.value)}
        />
        <Btn
          variant="primary"
          icon={unlBusy ? RefreshCw : FileUp}
          disabled={!unlFile || !unlPassword || unlBusy || qpdfFound === false}
          onClick={() => void doUnlock()}
          style={{ width: 220 }}
        >
          {unlBusy ? t("conv.pdfWorking") : t("conv.pdfUnlockGo")}
        </Btn>
        {unlError && <div style={{ color: "var(--coral)" }}>{unlError}</div>}
      </Glass>

      {/* --- OCR (PaddleOCR, CPU/GPU) --- */}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="media-title">{t("conv.pdfOcr")}</div>
        {ocrReady && !ocrReady.paddleocr ? (
          <>
            <div className="muted-sm">
              {t(ocrReady.gpu ? "conv.pdfOcrNeedInstallGpu" : "conv.pdfOcrNeedInstallCpu")}
            </div>
            <Btn
              icon={ocrInstall?.state === "working" ? RefreshCw : Download}
              disabled={ocrInstall?.state === "working"}
              onClick={() => void startOcrInstall()}
              style={{ width: 240 }}
            >
              {ocrInstall?.state === "working"
                ? t("conv.pdfOcrInstalling", { phase: ocrInstall.phase })
                : t("conv.pdfOcrInstallGo")}
            </Btn>
            {ocrInstall?.state === "working" && <ProgressBar value={ocrInstall.progress} />}
            {ocrInstall?.state === "error" && (
              <div style={{ color: "var(--coral)" }}>{ocrInstall.error}</div>
            )}
          </>
        ) : (
          <>
            <FilePickButton
              accept="application/pdf"
              label={t("automation.browse")}
              onPick={(files) => {
                setOcrFile(files[0]);
                setOcrText(null);
              }}
            />
            {ocrFile && <div className="muted-sm">{ocrFile.name}</div>}
            <Btn
              variant="primary"
              icon={ocrBusy ? RefreshCw : FileUp}
              disabled={!ocrFile || ocrBusy}
              onClick={() => void doOcr()}
              style={{ width: 220 }}
            >
              {ocrBusy ? t("conv.pdfOcrRunning") : t("conv.pdfOcrGo")}
            </Btn>
            {ocrError && <div style={{ color: "var(--coral)" }}>{ocrError}</div>}
            {ocrText != null && (
              <>
                <textarea className="text-input" readOnly rows={8} value={ocrText || t("conv.pdfNoTextLayer")} />
                <Btn
                  icon={Download}
                  onClick={() => {
                    const blob = new Blob([ocrText], { type: "text/plain;charset=utf-8" });
                    saveBlob(blob, (ocrFile?.name.replace(/\.pdf$/i, "") || "ocr") + ".txt");
                  }}
                  style={{ width: 200 }}
                >
                  {t("conv.pdfDownloadText")}
                </Btn>
              </>
            )}
          </>
        )}
      </Glass>

      </div>
      <div className="muted-sm">{t("conv.pdfMoreHint")}</div>
    </>
  );
}

/**
 * Word/PowerPoint/Excel ⇄ PDF — через LibreOffice headless
 * (server/ts/officeConvert.ts). Движок ищется локально, как ffmpeg; не найден
 * — понятная ошибка с подсказкой, куда поставить (без тихой автозагрузки
 * 300-мегабайтного инсталлятора).
 */
function OfficeToolkit() {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState("pdf");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<boolean | null>(null);

  useEffect(() => {
    api.officeStatus().then((s) => setFound(s.found)).catch(() => setFound(false));
  }, []);

  const convert = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const { blob, name } = await api.officeConvert(file, target);
      saveBlob(blob, name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const targets = ["pdf", "docx", "pptx", "xlsx", "odt", "odp", "ods"];

  return (
    <>
      <SectionHead eyebrow={t("conv.officeEyebrow")} title={t("conv.officeTitle")} />
      {found === false && <div className="muted-sm">{t("conv.officeMissing")}</div>}
      <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8, maxWidth: 360 }}>
        <FilePickButton
          accept=".doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.ods,.pdf"
          label={t("automation.browse")}
          onPick={(files) => setFile(files[0])}
        />
        {file && <div className="muted-sm">{file.name}</div>}
        <Select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          options={targets.map((tg) => ({ value: tg, label: tg.toUpperCase() }))}
        />
        <Btn
          variant="primary"
          icon={busy ? RefreshCw : FileUp}
          disabled={!file || busy || found === false}
          onClick={() => void convert()}
          style={{ width: 220 }}
        >
          {busy ? t("conv.pdfWorking") : t("conv.officeConvertGo")}
        </Btn>
        {error && <div style={{ color: "var(--coral)" }}>{error}</div>}
      </Glass>
    </>
  );
}
