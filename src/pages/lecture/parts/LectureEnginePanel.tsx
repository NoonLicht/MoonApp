import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Download, Trash2, X, Check, AlertTriangle, Zap } from "lucide-react";
import { Btn, Badge, ProgressBar } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { TranslateFn } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  LectureGigaamInfo,
  WhisperGgufInfo,
  WhisperGgufModel,
  WhisperQuant,
} from "@/api/client";

/**
 * Панель распознавания речи: GigaAM v3 (ONNX, по умолчанию) и модели Whisper в GGUF
 * (Base / Small / Medium / Large…, по умолчанию квантование Q4_K_M).
 *
 * Whisper считает библиотека transcribe.cpp на видеокарте (Vulkan) или процессоре;
 * файлы качаются в storage/asr (server/ts/asrGguf.ts → /api/lecture/engine/whisper).
 */

/** Коды ошибок бэкенда → ключ перевода (неизвестный код показываем как есть). */
function errorText(t: TranslateFn, raw: string): string {
  if (!raw) return "";
  const map: Record<string, string> = {
    busy: "errBusy",
    unknown_model: "errUnknownModel",
    model_not_downloaded: "errModelNotDownloaded",
    cancelled: "errCancelled",
    gigaam_not_installed: "errGigaamMissing",
    runtime_missing: "errRuntimeMissing",
  };
  const key = map[raw];
  if (key) return t(`lecture.setup.${key}`);
  if (raw.startsWith("download_http_"))
    return t("lecture.setup.errDownload", { code: raw.replace("download_http_", "") });
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|aborted|timeout/i.test(raw))
    return t("lecture.setup.errNetwork");
  return raw;
}

/** МБ → «466 MB» / «1.5 GB». */
function humanMb(mb: number): string {
  if (!mb) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`;
}

const QUANTS: WhisperQuant[] = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"];

/** Подпись семейства: whisper-large-v3-turbo → «large-v3-turbo». */
function familyLabel(family: string): string {
  return family.replace(/^whisper-/, "");
}

interface Family {
  family: string;
  note: WhisperGgufModel["note"];
  files: Record<string, WhisperGgufModel>;
}

function groupFamilies(models: WhisperGgufModel[]): Family[] {
  const out: Family[] = [];
  for (const m of models) {
    let f = out.find((x) => x.family === m.family);
    if (!f) {
      f = { family: m.family, note: m.note, files: {} };
      out.push(f);
    }
    f.files[m.quant] = m;
  }
  return out;
}

export default function LectureEnginePanel({
  onClose,
  inline = false,
  onChanged,
}: {
  onClose?: () => void;
  inline?: boolean;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const alive = useRef(true);
  const [giga, setGiga] = useState<LectureGigaamInfo | null>(null);
  const [wh, setWh] = useState<WhisperGgufInfo | null>(null);
  // Выбранное квантование по семействам (по умолчанию Q4_K_M).
  const [quants, setQuants] = useState<Record<string, WhisperQuant>>({});

  const refreshGiga = useCallback(async () => {
    try {
      const g = await api.lectureGigaam();
      if (alive.current) setGiga(g);
    } catch {
      /* бэкенд ещё поднимается */
    }
  }, []);

  const refreshWh = useCallback(async () => {
    try {
      const w = await api.lectureWhisper();
      if (alive.current) setWh(w);
    } catch {
      /* бэкенд ещё поднимается */
    }
  }, []);

  const gigaAction = useCallback(
    async (action: "download" | "cancel" | "remove" | "use-gigaam" | "use-whisper") => {
      setError("");
      try {
        const g = await api.lectureGigaamAction(action);
        if (alive.current) setGiga(g);
        onChanged?.();
      } catch (e) {
        setError(errorText(t, String((e as Error)?.message || e)));
      }
    },
    [onChanged, t],
  );

  const whAction = useCallback(
    async (
      action: "download" | "cancel" | "remove" | "select" | "gpu",
      extra: { id?: string; mode?: "auto" | "off" } = {},
    ) => {
      setError("");
      try {
        const w = await api.lectureWhisperAction(action, extra);
        if (alive.current) setWh(w);
        // «Использовать Whisper» меняет и выбранный движок — обновим GigaAM-блок.
        void refreshGiga();
        onChanged?.();
      } catch (e) {
        setError(errorText(t, String((e as Error)?.message || e)));
      }
    },
    [onChanged, refreshGiga, t],
  );

  useEffect(() => {
    alive.current = true;
    void refreshGiga();
    void refreshWh();
    return () => {
      alive.current = false;
    };
  }, [refreshGiga, refreshWh]);

  // Пока что-то скачивается — опрашиваем прогресс.
  const gigaWorking = giga?.task.state === "working";
  const whWorking = wh?.task.state === "working";
  useEffect(() => {
    if (!gigaWorking && !whWorking) return;
    const timer = setInterval(() => {
      if (gigaWorking) void refreshGiga();
      if (whWorking) void refreshWh();
      onChanged?.();
    }, 900);
    return () => clearInterval(timer);
  }, [gigaWorking, whWorking, refreshGiga, refreshWh, onChanged]);

  const families = groupFamilies(wh?.models || []);
  const whisperActive = giga?.preferred === "whisper";
  const ready = !!(giga?.installed || wh?.installed);
  const pill = giga?.installed && !whisperActive ? "GigaAM v3" : wh?.installed ? "Whisper" : null;

  const body = (
    <div className={inline ? "lecs-inline-body" : "lecs-panel"}>
      <div className="lecs-head">
        <span className="lecs-icon">
          <Zap size={17} />
        </span>
        <div className="lecs-title">
          <div className="lecs-eyebrow">{t("lecture.setup.eyebrow")}</div>
          <div className="lecs-h1">{t("lecture.setup.title")}</div>
        </div>
        <span className={`lecs-pill ${ready ? "on" : "off"}`}>
          {ready && pill ? pill : t("lecture.setup.notReady")}
        </span>
        {!inline && (
          <button className="lecs-close" onClick={onClose} title={t("common.close")}>
            <X size={15} />
          </button>
        )}
      </div>

      {!!error && <div className="lecs-error">{error}</div>}

      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.setup.asrTitle")}</div>
        <div className="lecs-list">
          {/* --- GigaAM v3 --- */}
          <div className={`lecs-row ${giga && giga.preferred === "gigaam" ? "active" : ""}`}>
            <div className="lecs-row-main">
              <div className="lecs-row-name">
                GigaAM v3
                <Badge tone="teal" mono>
                  {humanMb(giga?.installed ? giga.downloadedMb : giga?.sizeMb || 215)}
                </Badge>
                <Badge tone="violet" mono>
                  {t("lecture.setup.gigaamNote")}
                </Badge>
              </div>
              <div className="lecs-dim">
                {giga?.installed ? t("lecture.setup.downloaded") : t("lecture.setup.notDownloaded")}
                {giga?.installed && giga.preferred === "gigaam"
                  ? ` · ${t("lecture.setup.active")}`
                  : ""}
              </div>
              {giga && !giga.runtime && (
                <div className="lecs-warn">
                  <AlertTriangle size={13} />
                  <span>{t("lecture.setup.errRuntimeMissing")}</span>
                </div>
              )}
              {giga && giga.preferred === "gigaam" && !giga.languageOk && (
                <div className="lecs-dim lecs-hint">{t("lecture.setup.gigaamLang")}</div>
              )}
            </div>
            <div className="lecs-row-actions">
              {giga && !giga.installed && (
                <Btn
                  variant="secondary"
                  icon={Download}
                  onClick={() => void gigaAction("download")}
                  disabled={gigaWorking || whWorking}
                >
                  {gigaWorking ? t("lecture.setup.downloading") : t("lecture.setup.download")}
                </Btn>
              )}
              {giga?.installed && giga.preferred !== "gigaam" && (
                <Btn variant="secondary" icon={Check} onClick={() => void gigaAction("use-gigaam")}>
                  {t("lecture.setup.use")}
                </Btn>
              )}
              {giga?.installed && (
                <Btn
                  variant="ghost"
                  icon={Trash2}
                  onClick={() => void gigaAction("remove")}
                  disabled={gigaWorking}
                  title={t("common.delete")}
                />
              )}
            </div>
          </div>

          {/* --- Whisper GGUF: по строке на семейство, квантование выбирается рядом --- */}
          {families.map((f) => {
            const q = quants[f.family] || wh?.defaultQuant || "Q4_K_M";
            const file = f.files[q];
            if (!file) return null;
            const isActive = whisperActive && file.active;
            const installing = wh?.task.state === "working" && wh.task.id === file.id;
            const downloadedQuants = QUANTS.filter((x) => f.files[x]?.downloaded);
            return (
              <div className={`lecs-row ${isActive ? "active" : ""}`} key={f.family}>
                <div className="lecs-row-main">
                  <div className="lecs-row-name">
                    Whisper {familyLabel(f.family)}
                    <Badge tone={isActive ? "teal" : "neutral"} mono>
                      {humanMb(file.downloaded ? file.downloadedMb : file.sizeMb)}
                    </Badge>
                    <Badge tone="violet" mono>
                      {t(`lecture.setup.wnote.${f.note}`)}
                    </Badge>
                  </div>
                  <div className="lecs-dim">
                    {file.downloaded
                      ? t("lecture.setup.downloaded")
                      : t("lecture.setup.notDownloaded")}
                    {isActive ? ` · ${t("lecture.setup.active")}` : ""}
                    {downloadedQuants.length > 0 && !file.downloaded
                      ? ` · ${downloadedQuants.join(", ")}`
                      : ""}
                  </div>
                </div>
                <div className="lecs-row-actions">
                  <select
                    className="lecs-select"
                    value={q}
                    onChange={(e) =>
                      setQuants((m) => ({ ...m, [f.family]: e.target.value as WhisperQuant }))
                    }
                    title={t("lecture.setup.quantLabel")}
                  >
                    {QUANTS.map((x) => (
                      <option key={x} value={x}>
                        {x}
                        {x === wh?.defaultQuant ? ` · ${t("lecture.setup.quantDefault")}` : ""}
                        {f.files[x]?.downloaded ? " ✓" : ""}
                      </option>
                    ))}
                  </select>
                  {!file.downloaded && (
                    <Btn
                      variant="secondary"
                      icon={Download}
                      onClick={() => void whAction("download", { id: file.id })}
                      disabled={gigaWorking || whWorking}
                    >
                      {installing ? t("lecture.setup.downloading") : t("lecture.setup.download")}
                    </Btn>
                  )}
                  {file.downloaded && !isActive && (
                    <Btn
                      variant="secondary"
                      icon={Check}
                      onClick={() => void whAction("select", { id: file.id })}
                    >
                      {t("lecture.setup.use")}
                    </Btn>
                  )}
                  {file.downloaded && (
                    <Btn
                      variant="ghost"
                      icon={Trash2}
                      onClick={() => void whAction("remove", { id: file.id })}
                      disabled={whWorking}
                      title={t("common.delete")}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {giga && giga.task.state === "working" && (
          <div className="lecs-task">
            <div className="lecs-task-top">
              <span className="lecs-row-name">GigaAM v3</span>
              <span className="lecs-dim">
                {humanMb(Math.round(giga.task.received / 1048576))}
                {giga.task.total > 0 ? ` / ${humanMb(Math.round(giga.task.total / 1048576))}` : ""}
              </span>
            </div>
            <ProgressBar value={giga.task.progress} />
            <div className="lecs-task-foot">
              <span className="lecs-dim">{giga.task.progress}%</span>
              <div className="lecs-task-actions">
                <Btn variant="ghost" icon={X} onClick={() => void gigaAction("cancel")}>
                  {t("common.cancel")}
                </Btn>
              </div>
            </div>
          </div>
        )}
        {wh && wh.task.state === "working" && (
          <div className="lecs-task">
            <div className="lecs-task-top">
              <span className="lecs-row-name">{wh.task.id}</span>
              <span className="lecs-dim">
                {humanMb(Math.round(wh.task.received / 1048576))}
                {wh.task.total > 0 ? ` / ${humanMb(Math.round(wh.task.total / 1048576))}` : ""}
              </span>
            </div>
            <ProgressBar value={wh.task.progress} />
            <div className="lecs-task-foot">
              <span className="lecs-dim">{wh.task.progress}%</span>
              <div className="lecs-task-actions">
                <Btn variant="ghost" icon={X} onClick={() => void whAction("cancel")}>
                  {t("common.cancel")}
                </Btn>
              </div>
            </div>
          </div>
        )}
        {giga && giga.task.state === "error" && (
          <div className="lecs-error">{errorText(t, giga.task.error)}</div>
        )}
        {wh && wh.task.state === "error" && (
          <div className="lecs-error">{errorText(t, wh.task.error)}</div>
        )}
        {wh && !wh.runtime && (
          <div className="lecs-warn">
            <AlertTriangle size={13} />
            <span>{t("lecture.setup.errRuntimeMissing")}</span>
          </div>
        )}
        <div className="lecs-dim lecs-hint">{t("lecture.setup.asrHint")}</div>
        <div className="lecs-dim lecs-hint">{t("lecture.setup.whisperHint")}</div>
      </div>

      {/* --- Где считать Whisper: видеокарта (Vulkan) или процессор --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.setup.hwTitle")}</div>
        <div className="lecs-mode">
          <button
            className={`lecs-mode-btn ${wh?.gpu !== "off" ? "on" : ""}`}
            onClick={() => void whAction("gpu", { mode: "auto" })}
          >
            <Zap size={13} /> {t("lecture.setup.modeGpu")}
          </button>
          <button
            className={`lecs-mode-btn ${wh?.gpu === "off" ? "on" : ""}`}
            onClick={() => void whAction("gpu", { mode: "off" })}
          >
            <Cpu size={13} /> {t("lecture.setup.modeCpu")}
          </button>
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.setup.gpuHintGguf")}</div>
      </div>
    </div>
  );

  // inline — встроенная панель (Настройки), иначе модальное окно поверх страницы.
  if (inline) return body;
  return (
    <div className="lecs-overlay" onClick={onClose}>
      <div className="lecs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="lecs-body">{body}</div>
      </div>
    </div>
  );
}
