import React, { useState, useEffect, useMemo, useRef } from "react";
import { Repeat, Check, AlertTriangle, RefreshCw, FileUp, Terminal } from "lucide-react";
import {
  Glass,
  Btn,
  Badge,
  Field,
  Select,
  SectionHead,
  EmptyHint,
  ProgressBar,
} from "../components/ui";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { ConvertTools, ConvertResult, ConvertInstallStatus } from "../api/types";

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
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
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
        <Glass className="media-preview">
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
    </div>
  );
}
