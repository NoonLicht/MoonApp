import { useState } from "react";
import {
  ChevronRight,
  Download,
  FileVideo,
  Image as ImageIcon,
  Pause,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Square,
} from "lucide-react";
import { Btn, Badge, Select, Field, ProgressBar } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type {
  UpEstimate,
  UpGpuInfo,
  UpJob,
  UpModelInfo,
  UpPackState,
  UpParams,
  UpPreset,
  UpProbe,
} from "@/api/types";
import UpscaleProSettings from "@/pages/upscale/parts/UpscaleProSettings";
import UpscaleModelPicker from "@/pages/upscale/parts/UpscaleModelPicker";
import { fmtTime } from "@/pages/upscale/parts/formatTime";

/**
 * Правая колонка страницы апскейла — содержимое карточки настроек в стиле
 * страницы сжатия видео (`.cmp-card.cmp-fill`): пресеты, переключатель
 * Express/Pro, поля, оценка задания, прогресс и кнопки запуска.
 *
 * Прокручивается САМА карточка (класс up-fill): развёрнутые Pro-настройки
 * «уезжают» вниз внутри колонки, а не за край окна.
 *
 * Набор полей зависит от типа медиа: у картинки нет ни кодека, ни звука, ни
 * частоты кадров — таких ручек в её режиме не показываем вовсе.
 */
export default function UpscaleDashboard({
  file,
  probe,
  params,
  onParams,
  presets,
  customPresets,
  onPreset,
  onDeletePreset,
  mode,
  onMode,
  models,
  modelCount,
  onOpenModels,
  estimate,
  job,
  busy,
  batchCount,
  onStart,
  onReset,
  onSavePreset,
  onCancel,
  stopping,
  onPause,
  pausing,
  hw,
  pack,
  onPackInstall,
  onPackCancel,
  onPackRemove,
  onPackCheck,
}: {
  file: File | null;
  probe: UpProbe | null;
  params: UpParams;
  onParams: (patch: Partial<UpParams>) => void;
  presets: UpPreset[];
  customPresets: UpPreset[];
  onPreset: (p: UpPreset) => void;
  onDeletePreset: (name: string) => void;
  mode: "express" | "pro";
  onMode: (m: "express" | "pro") => void;
  models: UpModelInfo[];
  /** Сколько моделей скачано (кнопка каталога). */
  modelCount: { ready: number; total: number } | null;
  onOpenModels: () => void;
  estimate: UpEstimate | null;
  job: UpJob | null;
  busy: boolean;
  /** Файлов в партии: > 0 — кнопка запускает пакет, а не один файл. */
  batchCount?: number;
  onStart: () => void;
  onReset: () => void;
  onSavePreset: () => void;
  /** Мягкая остановка текущего задания (маленькая кнопка-иконка у прогресса). */
  onCancel: () => void;
  /** Запрос остановки уже отправлен — кнопка блокируется, чтобы не спамить. */
  stopping?: boolean;
  /**
   * Пауза/продолжение всей очереди: обработка замирает на текущем кадре,
   * процессы и модели остаются живыми.
   */
  onPause: (next: boolean) => void;
  /** Запрос паузы отправлен — кнопка блокируется на время запроса. */
  pausing?: boolean;
  /** Что умеет сборка ffmpeg: подсказка про видеокарту в Pro-настройках. */
  hw?: UpGpuInfo;
  /** GPU-пак: статус, прогресс и действия (Pro-настройки показывают строку пака). */
  pack: UpPackState | null;
  onPackInstall: (step: string) => void;
  onPackCancel: () => void;
  onPackRemove: () => void;
  /** Тянет индекс сборок из репозитория («Проверить сборки»). */
  onPackCheck: () => void;
}) {
  const { t } = useI18n();
  /** Пакетный режим: параметры общие, файлов много. */
  const batchMode = (batchCount || 0) > 0;
  // Тип медиа известен сразу по файлу (расширение), проба уточняет fps/кодек.
  const kind: "photo" | "video" = probe?.kind || job?.kind || "photo";
  const isVideo = kind === "video";
  const done = !!job?.done;
  // Пресеты своего типа: системные всегда с kind, у пользовательских он может
  // отсутствовать (сохранены раньше) — такие показываем в обоих режимах.
  const kindPresets = presets.filter((pr) => (pr.kind || "photo") === kind);
  const kindCustom = customPresets.filter((pr) => !pr.kind || pr.kind === kind);
  // Каталоги не смешиваются: интерполятор нельзя выбрать моделью апскейла.
  const upModels = models.filter((m) => m.kind !== "interp");
  const interpModels = models.filter((m) => m.kind === "interp");

  const presetLabel = (p: UpPreset) => (p.id ? t(`up.preset_${p.id}`) : String(p.name || ""));
  /** Пресеты можно свернуть: они занимают строку, даже когда режим подобран вручную. */
  const [presetsOpen, setPresetsOpen] = useState(true);
  /** Активный пресет своего типа — его видно и в свёрнутой строке. */
  const activePreset =
    kindPresets.find((pr) => pr.id === params.presetId) ||
    kindCustom.find((pr) => String(pr.name) === params.presetId) ||
    null;
  /** Выбран режим «без апскейла»: множитель разрешения не имеет смысла. */
  const noUpscale = params.model === "none";
  // Плавность: одно поле вместо трёх — режим и множитель вместе.
  const smoothValue =
    params.interpMode === "off" ? "off" : `${params.interpMode}:${params.interpMult}`;

  return (
    <>
      {/* --- Пресеты выбранного типа медиа --- */}
      <div className="up-row-inline">
        {/* Свернуть/развернуть строку пресетов: свёрнутая показывает только
            активный пресет, а место в панели остаётся настройкам. */}
        <button
          type="button"
          className={`up-fold${presetsOpen ? " is-open" : ""}`}
          onClick={() => setPresetsOpen((v) => !v)}
          aria-expanded={presetsOpen}
          title={presetsOpen ? t("up.presetsCollapse") : t("up.presetsExpand")}
        >
          <ChevronRight size={14} />
        </button>
        <span className="field-label">{t("up.presets")}</span>
        <Badge tone="neutral">
          {isVideo ? <FileVideo size={12} /> : <ImageIcon size={12} />}
          {isVideo ? t("up.video") : t("up.photo")}
        </Badge>
        {presetsOpen ? (
          <>
            {kindPresets.map((pr) => (
              <Badge
                key={pr.id}
                tone="violet"
                active={params.presetId === pr.id}
                onClick={() => onPreset(pr)}
              >
                {presetLabel(pr)}
              </Badge>
            ))}
            {kindCustom.map((pr) => (
              <span
                key={pr.name}
                title={t("up.deletePreset")}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onDeletePreset(String(pr.name));
                }}
              >
                <Badge
                  tone="teal"
                  active={params.presetId === String(pr.name)}
                  onClick={() => onPreset(pr)}
                >
                  {presetLabel(pr)}
                </Badge>
              </span>
            ))}
            {kindPresets.length === 0 && kindCustom.length === 0 ? (
              <span className="muted-sm">{t("up.noPresets")}</span>
            ) : null}
            <Btn icon={Save} onClick={onSavePreset} disabled={!file}>
              {t("up.savePreset")}
            </Btn>
          </>
        ) : (
          <span className="muted-sm">
            {activePreset ? presetLabel(activePreset) : t("up.noPresets")}
          </span>
        )}
      </div>

      {/* --- Режим: Express / Pro (как на странице сжатия видео) --- */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Badge
          tone={mode === "express" ? "amber" : "neutral"}
          active={mode === "express"}
          onClick={() => onMode("express")}
        >
          {t("up.express")}
        </Badge>
        <Badge
          tone={mode === "pro" ? "violet" : "neutral"}
          active={mode === "pro"}
          onClick={() => onMode("pro")}
        >
          {t("up.pro")}
        </Badge>
        <span className="muted-sm">{mode === "pro" ? t("up.proHint") : t("up.expressHint")}</span>
        <span style={{ flex: 1 }} />
        <Btn icon={Download} onClick={onOpenModels}>
          {t("up.mdlOpen")}
          {modelCount ? ` · ${modelCount.ready}/${modelCount.total}` : ""}
        </Btn>
      </div>

      {/* --- Быстрые поля: у фото и видео они разные --- */}
      <div className="up-fields">
        <Field label={t("up.model")}>
          <UpscaleModelPicker
            models={upModels}
            value={params.model}
            noneLabel={t("up.modelNone")}
            onPick={(id) => onParams({ model: id, presetId: "" })}
            onOpenCatalog={onOpenModels}
          />
        </Field>
        {noUpscale ? (
          // Множитель разрешения без апскейла смысла не имеет: показываем пояснение.
          <Field label={t("up.sectionSize")}>
            <span className="muted-sm">{t("up.modelNoneNote")}</span>
          </Field>
        ) : (
          <Field label={t("up.scale")}>
            <Select
              value={String(params.scale)}
              onChange={(e) => onParams({ scale: Number(e.target.value), presetId: "" })}
              options={[
                { value: "2", label: "×2" },
                { value: "3", label: "×3" },
                { value: "4", label: "×4" },
              ]}
            />
          </Field>
        )}
        {isVideo ? (
          <>
            <Field label={t("up.smooth")}>
              <Select
                value={smoothValue}
                onChange={(e) => {
                  const [nextMode, mult] = e.target.value.split(":");
                  onParams(
                    nextMode === "off"
                      ? { interpMode: "off", presetId: "" }
                      : { interpMode: nextMode, interpMult: Number(mult) || 2, presetId: "" },
                  );
                }}
                options={[
                  { value: "off", label: t("up.smoothOff") },
                  { value: "ffmpeg:2", label: "×2" },
                  { value: "ffmpeg:3", label: "×3" },
                  { value: "ffmpeg:4", label: "×4" },
                  ...(interpModels.length
                    ? [
                        { value: "model:2", label: `${t("up.kindInterp")} ×2` },
                        { value: "model:3", label: `${t("up.kindInterp")} ×3` },
                        { value: "model:4", label: `${t("up.kindInterp")} ×4` },
                      ]
                    : []),
                ]}
              />
            </Field>
            <Field label={t("up.vcodec")}>
              <Select
                value={params.vcodec}
                onChange={(e) => onParams({ vcodec: e.target.value, presetId: "" })}
                options={["x264", "x265", "av1"]}
              />
            </Field>
            <Field label={t("up.vcrf")}>
              <input
                type="number"
                className="text-input"
                min={0}
                max={51}
                style={{ width: "min(84px, 100%)" }}
                value={params.vcrf}
                onChange={(e) => onParams({ vcrf: Number(e.target.value) || 0, presetId: "" })}
              />
            </Field>
            <Field label={t("up.audio")}>
              <Select
                value={params.audioAction}
                onChange={(e) => onParams({ audioAction: e.target.value, presetId: "" })}
                options={[
                  { value: "copy", label: t("up.audioCopy") },
                  { value: "aac", label: t("up.audioAac") },
                ]}
              />
            </Field>
            <Field label={t("up.slowMotion")}>
              <Select
                value={String(params.slowMotion)}
                onChange={(e) => onParams({ slowMotion: Number(e.target.value), presetId: "" })}
                options={[
                  { value: "1", label: t("up.slowOff") },
                  { value: "0.5", label: "0.5×" },
                  { value: "0.25", label: "0.25×" },
                ]}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={t("up.format")}>
              <Select
                value={params.format}
                onChange={(e) => onParams({ format: e.target.value, presetId: "" })}
                options={["png", "jpeg", "webp", "avif"]}
              />
            </Field>
            <Field label={t("up.quality")}>
              <input
                type="number"
                className="text-input"
                min={1}
                max={100}
                style={{ width: "min(84px, 100%)" }}
                value={params.quality}
                onChange={(e) => onParams({ quality: Number(e.target.value) || 92, presetId: "" })}
              />
            </Field>
            <Field label={t("up.sharpen")}>
              <input
                type="number"
                className="text-input"
                min={0}
                max={100}
                style={{ width: "min(84px, 100%)" }}
                value={params.sharpen}
                onChange={(e) => onParams({ sharpen: Number(e.target.value) || 0, presetId: "" })}
              />
            </Field>
          </>
        )}
      </div>

      {/* --- Pro: те же ручки глубже; набор зависит от типа медиа --- */}
      {mode === "pro" ? (
        <UpscaleProSettings
          params={params}
          onParams={onParams}
          models={models}
          modelCount={modelCount}
          onOpenModels={onOpenModels}
          kind={kind}
          hw={hw}
          batchUsed={job?.batchUsed || 0}
          interpBatchUsed={job?.interpBatchUsed || 0}
          batchReason={job?.batchReason || ""}
          pack={pack}
          onPackInstall={onPackInstall}
          onPackCancel={onPackCancel}
          onPackRemove={onPackRemove}
          onPackCheck={onPackCheck}
        />
      ) : null}

      {/* --- Прогресс задания --- */}
      {busy && job ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <span className="muted-sm">
              {t(`up.stage_${job.stage}`)} · {job.model}
            </span>
            <span className="muted-sm">
              {job.progress}%{job.etaSec ? ` · ETA ${job.etaSec}s` : ""}
            </span>
          </div>
          <div className="up-progress-row">
            <ProgressBar value={job.progress} />
            {/* Кадры — прямо у полосы: по ним видно, растёт ли обработка. */}
            {job.kind === "video" && job.framesTotal > 0 ? (
              <span className="muted-sm up-progress-frames">
                {t("up.frames", { done: job.framesDone, total: job.framesTotal })}
                {job.fps ? ` · ${job.fps} fps` : ""}
              </span>
            ) : null}
            {/* Маленькая кнопка «Пауза/Продолжить»: очередь стоит на текущем кадре. */}
            <button
              type="button"
              className={`up-stop-btn${job.paused ? " is-active" : ""}`}
              title={job.paused ? t("up.resume") : t("up.pause")}
              aria-label={job.paused ? t("up.resume") : t("up.pause")}
              disabled={pausing || job.stage === "done" || job.stage === "error"}
              onClick={() => onPause(!job.paused)}
            >
              {job.paused ? <Play size={11} /> : <Pause size={11} />}
            </button>
            {/* Маленькая кнопка «Стоп»: мягкая остановка, результат не удаляем. */}
            <button
              type="button"
              className="up-stop-btn"
              title={t("up.cancel")}
              aria-label={t("up.cancel")}
              disabled={stopping || job.stage === "done" || job.stage === "error"}
              onClick={onCancel}
            >
              <Square size={11} />
            </button>
          </div>
          {job.kind === "video" && job.fpsOut && job.info?.fps && job.fpsOut !== job.info.fps ? (
            <span className="muted-sm">
              {t("up.fpsOut", {
                from: Number(job.info.fps).toFixed(2),
                to: Number(job.fpsOut).toFixed(2),
              })}
            </span>
          ) : null}
          {job.error ? (
            <span className="up-err">
              {t(`up.err_${job.error}`) === `up.err_${job.error}`
                ? job.error
                : t(`up.err_${job.error}`)}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* --- Оценка результата до запуска: видно, что получится и сколько ждать --- */}
      {!busy && estimate ? (
        <div className="up-badges">
          <Badge tone="violet" mono>
            {estimate.outWidth}×{estimate.outHeight}
          </Badge>
          {estimate.kind === "video" ? (
            <>
              <Badge tone="neutral">{t("up.estFrames", { n: estimate.outFrames })}</Badge>
              {estimate.fpsOut > 0 ? (
                <Badge tone="neutral">{`${estimate.fpsOut.toFixed(2)} fps`}</Badge>
              ) : null}
              {estimate.durationSec ? (
                <Badge tone="neutral">{fmtTime(estimate.durationSec)}</Badge>
              ) : null}
              {estimate.slowMotion < 1 ? (
                <Badge tone="coral">{`${estimate.slowMotion}×`}</Badge>
              ) : null}
            </>
          ) : (
            <Badge tone="neutral">{`${estimate.totalMegapixels} MP`}</Badge>
          )}
          <span className="muted-sm">
            {estimate.etaSec != null
              ? t("up.estTime", { t: fmtTime(estimate.etaSec) })
              : t("up.estNoTime")}
          </span>
          {estimate.warnings.map((wn) => (
            <Badge key={wn} tone="coral">
              {t(`up.est_${wn}`)}
            </Badge>
          ))}
        </div>
      ) : null}

      {/* --- Запуск: скачивание результата слева, здесь только старт --- */}
      {!busy ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant="primary" icon={Sparkles} onClick={onStart} disabled={!file && !batchMode}>
            {batchMode ? t("up.batchRun") : t("up.start")}
          </Btn>
          <Btn icon={RotateCcw} onClick={onReset} disabled={!file && !job && !batchMode}>
            {done ? t("up.newMedia") : t("up.rechoose")}
          </Btn>
        </div>
      ) : null}
    </>
  );
}
