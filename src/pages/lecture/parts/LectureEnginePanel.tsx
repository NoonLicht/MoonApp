import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cpu,
  Download,
  Trash2,
  X,
  RefreshCw,
  Check,
  AlertTriangle,
  Zap,
  FolderOpen,
  FileText,
} from "lucide-react";
import { Btn, Badge, ProgressBar } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { TranslateFn } from "@/app/i18n";
import { api } from "@/api/client";
import type { LectureEngineSetup } from "@/api/client";

/**
 * Панель настройки движка распознавания лекций (whisper.cpp).
 *
 * Что решает: пользователь сам выбирает модель (tiny … large-v3) и сборку
 * движка — обычную CPU, OpenBLAS (быстрее на процессоре) или CUDA (счёт на
 * видеокарте NVIDIA). Скачивание идёт в storage/whisper на бэкенде, прогресс
 * виден здесь (server/whisperEngine.js → POST /api/lecture/engine/*).
 *
 * Self-test гоняет активную модель на синтетическом WAV: наличие ggml-cuda.dll
 * ещё не значит, что ядро запустится (сборки собраны под CUDA 12.4, а
 * Blackwell/RTX 50xx требует sm_120), поэтому итог показывает реальность.
 */

/** Коды ошибок бэкенда → ключ перевода (неизвестный код показываем как есть). */
function errorText(t: TranslateFn, raw: string): string {
  if (!raw) return "";
  const map: Record<string, string> = {
    busy: "errBusy",
    unknown_model: "errUnknownModel",
    unknown_build: "errUnknownBuild",
    model_not_downloaded: "errModelNotDownloaded",
    build_not_installed: "errBuildNotInstalled",
    build_no_exe: "errBuildNoExe",
    bin_not_found: "errBinNotFound",
    cancelled: "errCancelled",
  };
  const key = map[raw];
  if (key) return t(`lecture.setup.${key}`);
  if (raw.startsWith("download_http_"))
    return t("lecture.setup.errDownload", { code: raw.replace("download_http_", "") });
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|aborted|timeout/i.test(raw))
    return t("lecture.setup.errNetwork");
  return raw;
}

/** МБ → «466 МБ» / «1.5 ГБ» (в каталоге модели до 3 ГБ, влезать в экран нужно). */
function humanMb(mb: number): string {
  if (!mb) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`;
}

/** Подпись активного бэкенда: cuda → «CUDA (видеокарта)» и т.п. */
function backendLabel(t: TranslateFn, backend: string | null): string {
  const key = String(backend || "cpu").replace("cpu+", "");
  const known = ["cpu", "blas", "cuda", "vulkan"];
  return known.includes(key) ? t(`lecture.setup.backend.${key}`) : String(backend || "");
}

/** Тон подсказки «лучше для вашего ПК»: teal — рекомендуем, amber — тяжело, coral — не подходит. */
function fitClass(level: string): string {
  return `lecs-fit lecs-fit-${level}`;
}

/**
 * Подсказка «лучше для вашего ПК»: уровень («лучше для вашего ПК» / «подойдёт» /
 * «тяжело» / «не для вашего ПК») и КОРОТКОЕ объяснение, почему именно так.
 *
 * Зачем: без этого списка моделей недостаточно — «пусть будет 3 ГБ» ломается о
 * процессор без видеокарты, где расшифровка идёт медленнее реального времени.
 * Причину считает сервер (lecture.setup.fitWhy.*), здесь только показываем.
 */
function FitHint({
  fit,
  t,
}: {
  fit?: { level: string; reason: string; gb: number };
  t: TranslateFn;
}) {
  if (!fit) return null;
  const tone = fit.level === "best" ? "teal" : fit.level === "heavy" ? "amber" : "neutral";
  return (
    <div className={fitClass(fit.level)}>
      {fit.level === "unfit" && <AlertTriangle size={11} />}
      {fit.level === "best" && <Zap size={11} />}
      <Badge tone={tone}>{t(`lecture.setup.fit.${fit.level}`)}</Badge>
      {!!fit.reason && <span>{t(`lecture.setup.fitWhy.${fit.reason}`, { gb: fit.gb })}</span>}
    </div>
  );
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
  const [setup, setSetup] = useState<LectureEngineSetup | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [binDraft, setBinDraft] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const alive = useRef(true);

  const apply = useCallback((s: LectureEngineSetup) => {
    if (!alive.current) return;
    setSetup(s);
  }, []);

  /** Обёртка над API-вызовами: единый busy/error и запись нового состояния. */
  const run = useCallback(
    async (key: string, fn: () => Promise<LectureEngineSetup>) => {
      setBusy(key);
      setError("");
      try {
        apply(await fn());
        // Хост-страница обновляет свой бейдж «Whisper.cpp готов · backend» и имя модели.
        onChanged?.();
      } catch (e) {
        setError(errorText(t, String((e as Error)?.message || e)));
      }
      setBusy("");
    },
    [apply, onChanged, t],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await api.lectureEngineSetup());
    } catch {
      /* бэкенд ещё поднимается — панель отрисует «нет данных» */
    }
  }, [apply]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Пока идёт скачивание — опрашиваем прогресс (GET /engine/setup, task.state).
  const working = setup?.task.state === "working";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      void refresh();
    }, 900);
    return () => clearInterval(timer);
  }, [working, refresh]);

  const engine = setup?.engine || null;
  const gpu = setup?.gpu || null;
  const task = setup?.task || null;
  const verify = setup?.verify || null;
  const models = setup?.models || [];
  const builds = setup?.builds || [];
  const cudaDevices = (gpu?.devices || []).filter((d) => d.cuda);

  const modelAction = (id: string, action: "select" | "download" | "remove") =>
    void run(`model:${action}:${id}`, () => api.lectureEngineModel(id, action));
  const buildAction = (id: string, action: "select" | "download") =>
    void run(`build:${action}:${id}`, () => api.lectureEngineBuild(id, action));
  const setGpu = (mode: "auto" | "off", deviceId?: number) =>
    void run("gpu", () => api.lectureEngineGpu(mode, deviceId));
  const runVerify = () => void run("verify", () => api.lectureEngineVerify());
  const saveBin = () => void run("bin", () => api.lectureEngineBin((binDraft ?? "").trim()));
  const cancelTask = () => void run("cancel", () => api.lectureEngineCancel());

  /** Предупреждения движка: CUDA без NVIDIA и Blackwell (RTX 50xx / sm_120). */
  const warnings = engine?.warnings || [];

  const gpuMode = engine?.gpu || "auto";
  const activeModelId = models.find((m) => m.active)?.id || engine?.modelId || "";
  // «Ваш ПК» + что именно ему подходит (считает сервер: whisperEngine.detectSystem).
  const system = setup?.system || null;
  const bestModelId = models.find((m) => m.recommend?.best)?.id || "";
  const bestBuild = builds.find((b) => b.recommend?.best);
  const bestBuildLabel = bestBuild
    ? t(`lecture.setup.build.${bestBuild.id}`)
    : t("lecture.setup.autoBuild");

  const body = (
    <div className={inline ? "lecs-inline-body" : "lecs-panel"}>
      {/* Шапка */}
      <div className="lecs-head">
        <span className="lecs-icon">
          <Zap size={17} />
        </span>
        <div className="lecs-title">
          <div className="lecs-eyebrow">{t("lecture.setup.eyebrow")}</div>
          <div className="lecs-h1">{t("lecture.setup.title")}</div>
        </div>
        <span className={`lecs-pill ${engine?.ready ? "on" : "off"}`}>
          {engine?.ready ? `${backendLabel(t, engine.backend)}` : t("lecture.setup.notReady")}
        </span>
        {!inline && (
          <button className="lecs-close" onClick={onClose} title={t("common.close")}>
            <X size={15} />
          </button>
        )}
      </div>

      {!!error && <div className="lecs-error">{error}</div>}

      {warnings.map((w) => (
        <div className="lecs-warn" key={w}>
          <AlertTriangle size={13} />
          <span>{t(`lecture.setup.warn.${w}`)}</span>
        </div>
      ))}

      {/* --- Ваш ПК: что реально потянет это железо --- */}
      {system?.detected && (
        <div className="lecs-block lecs-sys">
          <div className="lecs-block-label">{t("lecture.setup.systemTitle")}</div>
          <div className="lecs-sys-line">
            {t("lecture.setup.systemLine", {
              cpu: system.cpu || "—",
              cores: system.cores,
              threads: system.threads,
              ram: system.ramGb,
            })}
          </div>
          <div className="lecs-dim lecs-hint">
            {system.cuda
              ? `${system.gpu}${system.gpuGb ? ` · ${system.gpuGb} GB VRAM` : ""}`
              : t("lecture.setup.systemNoGpu")}
          </div>
          {!!bestModelId && (
            <div className="lecs-ok">
              <Zap size={12} />
              <span>
                {t("lecture.setup.systemHint", { model: bestModelId, build: bestBuildLabel })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Прогресс скачивания (одна задача за раз: модель ИЛИ сборка) */}
      {task && task.state !== "idle" && (
        <div className="lecs-task">
          <div className="lecs-task-top">
            <span className="lecs-row-name">
              {task.kind === "model"
                ? t("lecture.setup.downloadingModel")
                : t("lecture.setup.downloadingBuild")}
              {task.id ? ` · ${task.id}` : ""}
            </span>
            <span className="lecs-dim">
              {task.total > 0
                ? `${humanMb(Math.round(task.received / 1048576))} / ${humanMb(Math.round(task.total / 1048576))}`
                : humanMb(Math.round(task.received / 1048576))}
            </span>
          </div>
          <ProgressBar value={task.progress} />
          <div className="lecs-task-foot">
            <span className="lecs-dim">
              {t(`lecture.setup.phase.${task.phase || "download"}`)} · {task.progress}%
            </span>
            <div className="lecs-task-actions">
              {task.state === "working" && (
                <Btn variant="ghost" icon={X} onClick={cancelTask} disabled={busy === "cancel"}>
                  {t("common.cancel")}
                </Btn>
              )}
              {task.state === "done" && (
                <span className="lecs-ok">
                  <Check size={12} /> {t("lecture.setup.done")}
                </span>
              )}
              {task.state === "error" && (
                <span className="lecs-bad">{errorText(t, task.error)}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- Железо: где считать — видеокарта или процессор --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.setup.hwTitle")}</div>
        <div className="lecs-hw">
          <Cpu size={14} />
          <div className="lecs-hw-text">
            <div className="lecs-row-name">
              {gpu?.pending
                ? t("lecture.setup.gpuPending")
                : gpu?.cudaCapable
                  ? gpu.name
                  : gpu?.name || t("lecture.setup.gpuNone")}
            </div>
            <div className="lecs-dim">
              {gpu?.cudaCapable ? `${humanMb(gpu.memoryMb)} VRAM` : t("lecture.setup.gpuNoCuda")}
              {gpu?.driver ? ` · ${t("lecture.setup.driver")} ${gpu.driver}` : ""}
              {gpu?.cpu ? ` · CPU: ${gpu.cpu}` : ""}
            </div>
          </div>
        </div>
        <div className="lecs-mode">
          <button
            className={`lecs-mode-btn ${gpuMode === "auto" ? "on" : ""}`}
            onClick={() => setGpu("auto")}
            disabled={busy === "gpu"}
          >
            <Zap size={13} /> {t("lecture.setup.modeGpu")}
          </button>
          <button
            className={`lecs-mode-btn ${gpuMode === "off" ? "on" : ""}`}
            onClick={() => setGpu("off")}
            disabled={busy === "gpu"}
          >
            <Cpu size={13} /> {t("lecture.setup.modeCpu")}
          </button>
          {cudaDevices.length > 1 && (
            <select
              className="lecs-select"
              value={String(engine?.deviceId ?? 0)}
              onChange={(e) => setGpu(gpuMode, Number(e.target.value))}
            >
              {cudaDevices.map((d, i) => (
                <option key={`${d.name}-${i}`} value={String(i)}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.setup.gpuHint")}</div>
        <div className="lecs-verify">
          <Btn
            variant="secondary"
            icon={RefreshCw}
            onClick={runVerify}
            disabled={busy === "verify" || !engine?.ready}
          >
            {busy === "verify" ? t("lecture.setup.verifying") : t("lecture.setup.verify")}
          </Btn>
          {verify && busy !== "verify" && (
            <span className={`lecs-verify-result ${verify.ok ? "ok" : "bad"}`}>
              {verify.ok
                ? t("lecture.setup.verifyOk", {
                    backend: backendLabel(t, verify.backend),
                    ms: verify.elapsedMs,
                  })
                : `${t("lecture.setup.verifyFail")}: ${errorText(t, verify.error)}`}
            </span>
          )}
          {!!verify?.log && (
            <button className="lecs-link" onClick={() => setShowLog((v) => !v)}>
              <FileText size={12} />
              {showLog ? t("lecture.setup.hideLog") : t("lecture.setup.showLog")}
            </button>
          )}
        </div>
        {showLog && !!verify?.log && <pre className="lecs-log">{verify.log}</pre>}
      </div>

      {/* --- Модели: точность против скорости --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.setup.modelsTitle")}</div>
        <div className="lecs-list">
          {models.map((m) => {
            const isActive = m.id === activeModelId;
            const installing =
              task?.state === "working" && task.kind === "model" && task.id === m.id;
            return (
              <div className={`lecs-row ${isActive ? "active" : ""}`} key={m.id}>
                <div className="lecs-row-main">
                  <div className="lecs-row-name">
                    {m.id}
                    <Badge tone={isActive ? "teal" : "neutral"} mono>
                      {humanMb(m.downloaded ? m.downloadedMb : m.sizeMb)}
                    </Badge>
                    <Badge tone="violet" mono>
                      {t(`lecture.setup.note.${m.note}`)}
                    </Badge>
                  </div>
                  <div className="lecs-dim">
                    {m.downloaded
                      ? t("lecture.setup.downloaded")
                      : t("lecture.setup.notDownloaded")}
                    {isActive ? ` · ${t("lecture.setup.active")}` : ""}
                  </div>
                  <FitHint fit={m.recommend} t={t} />
                </div>
                <div className="lecs-row-actions">
                  {!m.downloaded && (
                    <Btn
                      variant="secondary"
                      icon={Download}
                      onClick={() => modelAction(m.id, "download")}
                      disabled={!!busy || working}
                    >
                      {installing ? t("lecture.setup.downloading") : t("lecture.setup.download")}
                    </Btn>
                  )}
                  {m.downloaded && !isActive && (
                    <Btn
                      variant="secondary"
                      icon={Check}
                      onClick={() => modelAction(m.id, "select")}
                      disabled={!!busy}
                    >
                      {t("lecture.setup.use")}
                    </Btn>
                  )}
                  {m.downloaded && (
                    <Btn
                      variant="ghost"
                      icon={Trash2}
                      onClick={() => modelAction(m.id, "remove")}
                      disabled={!!busy || working}
                      title={t("common.delete")}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.setup.modelsHint")}</div>
      </div>
      {/* --- Сборки движка: CPU / OpenBLAS / CUDA --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.setup.buildsTitle")}</div>
        <div className="lecs-list">
          <div
            className={`lecs-row ${!engine?.build || engine.build === "auto" ? "active" : ""}`}
            key="auto"
          >
            <div className="lecs-row-main">
              <div className="lecs-row-name">
                {t("lecture.setup.autoBuild")}
                <Badge tone="violet" mono>
                  auto
                </Badge>
              </div>
              <div className="lecs-dim">
                {engine?.build
                  ? `${t("lecture.setup.active")}: ${engine.build}`
                  : t("lecture.setup.notReady")}
              </div>
            </div>
            <div className="lecs-row-actions">
              <Btn
                variant="secondary"
                icon={RefreshCw}
                onClick={() => buildAction("auto", "select")}
                disabled={!!busy}
              >
                {t("lecture.setup.use")}
              </Btn>
            </div>
          </div>
          {builds.map((b) => {
            const installing =
              task?.state === "working" && task.kind === "build" && task.id === b.id;
            return (
              <div className={`lecs-row ${b.active ? "active" : ""}`} key={b.id}>
                <div className="lecs-row-main">
                  <div className="lecs-row-name">
                    {t(`lecture.setup.build.${b.id}`)}
                    {b.sizeMb != null && (
                      <Badge tone="neutral" mono>
                        {humanMb(b.sizeMb)}
                      </Badge>
                    )}
                    {b.gpu && (
                      <Badge tone="teal" mono>
                        {backendLabel(t, "cuda")}
                      </Badge>
                    )}
                  </div>
                  <div className="lecs-dim">
                    {b.installed ? t("lecture.setup.installed") : t("lecture.setup.notInstalled")}
                    {b.active ? ` · ${t("lecture.setup.active")}` : ""}
                  </div>
                  <FitHint fit={b.recommend} t={t} />
                </div>
                <div className="lecs-row-actions">
                  {!b.installed && !b.legacy && (
                    <Btn
                      variant="secondary"
                      icon={Download}
                      onClick={() => buildAction(b.id, "download")}
                      disabled={!!busy || working}
                    >
                      {installing ? t("lecture.setup.downloading") : t("lecture.setup.download")}
                    </Btn>
                  )}
                  {b.installed && !b.active && (
                    <Btn
                      variant="secondary"
                      icon={Check}
                      onClick={() => buildAction(b.id, "select")}
                      disabled={!!busy}
                    >
                      {t("lecture.setup.use")}
                    </Btn>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.setup.buildsHint")}</div>
      </div>

      {/* --- Свой путь к whisper-cli (если движок уже собран вручную) --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.setup.binTitle")}</div>
        <div className="lecs-bin">
          <input
            className="lecs-input"
            value={binDraft ?? engine?.bin ?? ""}
            placeholder={t("lecture.setup.binPlaceholder")}
            onChange={(e) => setBinDraft(e.target.value)}
            spellCheck={false}
          />
          <Btn
            variant="secondary"
            icon={Check}
            onClick={saveBin}
            disabled={busy === "bin" || binDraft === null}
          >
            {t("common.save")}
          </Btn>
          <span className="lecs-dim lecs-hint">{t("lecture.setup.binHint")}</span>
        </div>
        {!!engine?.buildDir && (
          <div className="lecs-dim lecs-path">
            <FolderOpen size={12} /> {engine.buildDir}
          </div>
        )}
      </div>
    </div>
  );

  // inline — встроенная панель (Настройки), иначе модальное окно поверх страницы.
  if (inline) return body;
  return (
    <div className="lecs-overlay" onClick={onClose}>
      <div className="lecs-modal" onClick={(e) => e.stopPropagation()}>
        {/* .lecs-body — тело со скроллом (шапка с крестиком остаётся видимой).
            Без этой обёртки каталог моделей и сборок обрезался: у .lecs-modal
            overflow:hidden, а скроллить было нечему. */}
        <div className="lecs-body">{body}</div>
      </div>
    </div>
  );
}
