import React, { useRef, useState } from "react";
import { Download, Cpu, Gauge, Film, HelpCircle, SlidersHorizontal } from "lucide-react";
import { Btn, Badge, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { BATCH_AUTO, BATCH_CHOICES, INTERP_BATCH_CHOICES } from "@/pages/upscale/parts/batchSizes";
import type { UpGpuInfo, UpModelInfo, UpPackState, UpParams } from "@/api/types";

/** «466 МБ» / «1.5 ГБ» — размеры пака и счётчик скачанного. */
function humanMb(mb: number): string {
  if (!mb) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Подпись состояния ступени пака: скачивание / распаковка / ошибка. */
function packStateText(t: (k: string) => string, state: string): string {
  if (state === "unpack") return t("up.packUnpack");
  if (state === "error") return t("up.packFailed");
  if (state === "done") return t("up.packDone");
  return t("up.packDownload");
}

/**
 * Подсказка к настройке: всплывает по наведению (или по фокусу) на «?».
 *
 * Координаты считаются от кнопки, а сам блок — `position: fixed`: панель настроек
 * прокручивается (`overflow: auto`), и подсказка внутри потока обрезалась бы её краем.
 */
function HelpTip({ text }: { text: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    // У края окна подсказку сдвигаем: центр по кнопке вывел бы её за экран.
    const half = 140;
    const x = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half);
    setPos({ x, y: r.bottom + 6 });
  };

  return (
    <>
      <button
        type="button"
        ref={btn}
        className="up-info-btn"
        aria-label={text}
        onMouseEnter={show}
        onFocus={show}
        onMouseLeave={() => setPos(null)}
        onBlur={() => setPos(null)}
        onClick={() => (pos ? setPos(null) : show())}
      >
        <HelpCircle size={11} />
      </button>
      {pos ? (
        <span className="up-tip" role="tooltip" style={{ left: pos.x, top: pos.y }}>
          {text}
        </span>
      ) : null}
    </>
  );
}

/** Строка настройки: подпись + «?» со всплывающим описанием и контрол справа. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="up-pro-row">
      <div className="up-pro-info">
        <span className="up-pro-label">{label}</span>
        {hint ? <HelpTip text={hint} /> : null}
      </div>
      <div className="up-pro-ctl">{children}</div>
    </div>
  );
}

/**
 * Pro-настройки апскейла: разворачиваются ВНИЗ в правой колонке, внутри той же
 * карточки, что Express-ручки (прокручивается колонка — как «Pro» на странице
 * сжатия видео: `.cmp-card.cmp-fill` там, `.up-card.up-fill` здесь).
 *
 * ВАЖНО: набор полей зависит от типа медиа. У картинки нет ни кадров, ни кодека,
 * ни звука, поэтому «Формат/качество», «Резкость», тайлинг и т.п. показываем
 * только для фото, а «Кодек/CRF/Звук», «Плавность», «Замедление», «Пакет кадров»
 * и «Лимит кадров» — только для видео. Смешивание моделей, тайлинг и провайдер
 * работают в обоих случаях.
 */

export default function UpscaleProSettings({
  params,
  onParams,
  models,
  modelCount,
  onOpenModels,
  kind,
  hw,
  batchUsed = 0,
  interpBatchUsed = 0,
  batchReason = "",
  pack,
  onPackInstall,
  onPackCancel,
  onPackRemove,
  onPackCheck,
}: {
  params: UpParams;
  onParams: (patch: Partial<UpParams>) => void;
  models: UpModelInfo[];
  /** Сколько моделей скачано (сводка + вход в каталог). */
  modelCount: { ready: number; total: number } | null;
  onOpenModels: () => void;
  /** Тип медиа: у фото нет видео-секций, у видео — фото-секций. */
  kind: "photo" | "video";
  /**
   * План аппаратного ускорения от сервера: какие кодировщики доступны сборке
   * ffmpeg. Нужен, чтобы подсказка не обещала NVENC там, где его нет.
   */
  hw?: UpGpuInfo;
  /** Фактическая пачка кадров из текущего задания: «Авто (N)» в подписи. */
  batchUsed?: number;
  /** Фактическая пачка тайлов интерполятора из задания (0 — интерполяция не считает пачками). */
  interpBatchUsed?: number;
  /**
   * Почему пачка выключена: "unsupported" — движок поймал отказ графа во время
   * задания. Тогда вместо селекта показываем «по одному кадру», иначе «Авто (64)»
   * обещало бы пачку, которой на деле нет.
   */
  batchReason?: string;
  /** GPU-пак: что установлено, прогресс и список доступных сборок. */
  pack: UpPackState | null;
  /** Поставить ступень пака (cuda / tensorrt). */
  onPackInstall: (step: string) => void;
  onPackCancel: () => void;
  onPackRemove: () => void;
  /** Тянет индекс сборок из репозитория («Проверить сборки»). */
  onPackCheck: () => void;
}) {
  const { t } = useI18n();
  const isVideo = kind === "video";
  /** «x264 · NVENC, AV1 · NVENC» — что реально сработает при включённой галке. */
  const hwSummary = hw
    ? `x264 · ${hw.x264 || "CPU"}, x265 · ${hw.x265 || "CPU"}, AV1 · ${hw.av1 || "CPU"}${
        hw.decode ? `, ${hw.decode}` : ""
      }`
    : "";
  /** GPU-пакет: с ним доступны CUDA/TensorRT, без него — обычный путь DirectML/CPU. */
  const packText = hw?.pack?.installed
    ? t("up.packOn", { v: hw.pack.provider || "CUDA" })
    : t("up.packOff");
  /** Ступень пака, которая ставится сейчас (для полосы прогресса). */
  const packStep = pack?.busy ? pack.states[pack.busy] : null;
  /** Что можно скачать: список приходит из индекса после «Проверить сборки». */
  const packSteps = (pack?.index?.steps || []).filter(
    (s) => !(pack?.installed && (s.id === "cuda" || pack.backends.includes("tensorrt"))),
  );

  const scaleOptions = [
    { value: "2", label: "×2" },
    { value: "3", label: "×3" },
    { value: "4", label: "×4" },
  ];
  const tileOptions = [
    { value: "0", label: t("up.tileAuto") },
    { value: "256", label: "256" },
    { value: "512", label: "512" },
    { value: "1024", label: "1024" },
  ];
  const providerOptions = ["auto", "cpu", "cuda", "dml"].concat(
    // TensorRT предлагаем только там, где провайдер реально собран в рантайм.
    hw?.trt?.available ? ["tensorrt"] : [],
  );
  // Каталоги не смешиваются: интерполятор нельзя поставить апскейлером и наоборот.
  const upModels = models.filter((m) => m.kind !== "interp");
  const interpList = models.filter((m) => m.kind === "interp");
  const blendOptions = [{ value: "", label: t("up.blendOff") }].concat(
    upModels.filter((m) => m.id !== params.model).map((m) => ({ value: m.id, label: m.label })),
  );
  const interpModel =
    interpList.find((m) => m.id === params.interpModel) ||
    interpList.find((m) => m.available) ||
    interpList[0];
  // Предел множителя плавности для выбранной ONNX-модели: CAIN умеет только ×2,
  // RIFE/IFRNet — до ×4 (см. interpMultMax на сервере).
  const interpMultMax = params.interpMode === "model" ? interpModel?.multMax || 4 : 4;
  /** Выбран режим «без апскейла»: множитель разрешения не применяется. */
  const noUpscale = params.model === "none";
  /**
   * Умеет ли выбранная модель пачку кадров. `batch === 1` — граф ждёт ровно один
   * кадр за проход: копить пачку нечем, поэтому настройку не показываем вовсе
   * (движок в этом случае тоже не держит очередь). `batch === 0` — факт ещё не
   * проверен: движок попробует и откатится сам, настройка остаётся доступной.
   */
  const upModel = upModels.find((m) => m.id === params.model) || null;
  const canBatchFrames = !noUpscale && (!upModel || upModel.batch !== 1);
  /** Тот же вопрос для интерполятора: у него пачка измеряется в тайлах пары. */
  const canInterpBatch = params.interpMode === "model" && !!interpModel && interpModel.batch !== 1;

  return (
    <div className="up-pro-inline">
      <div className="up-pro-section-title">
        <SlidersHorizontal size={14} /> {t("up.proTitle")}
      </div>
      <div className="muted-sm up-pro-hint">{t("up.proHint")}</div>

      {/* --- Модели: короткая сводка + вход в каталог (скачивание — в панели) --- */}
      <div className="up-pro-section">
        <div className="up-pro-section-title">
          <Download size={14} /> {t("up.modelsTitle")}
          <HelpTip text={t("up.mdlOpenHint")} />
        </div>
        <div className="up-row-inline">
          <Badge tone={modelCount && modelCount.ready ? "teal" : "coral"}>
            {modelCount
              ? t("up.mdlInstalledOf", { done: modelCount.ready, total: modelCount.total })
              : t("up.noModels")}
          </Badge>
          <Btn icon={Download} onClick={onOpenModels}>
            {t("up.mdlOpen")}
          </Btn>
        </div>
      </div>

      {/* --- Размер --- */}
      <div className="up-pro-section">
        <div className="up-pro-section-title">{t("up.sectionSize")}</div>
        {noUpscale ? (
          <Row label={t("up.modelNone")} hint={t("up.modelNoneHint")}>
            <span className="muted-sm">{t("up.modelNoneNote")}</span>
          </Row>
        ) : (
          <>
            <Row label={t("up.scale")} hint={t("up.scaleHint")}>
              <Select
                value={String(params.scale)}
                onChange={(e) => onParams({ scale: Number(e.target.value) })}
                options={scaleOptions}
                style={{ width: "min(100px, 100%)" }}
              />
            </Row>
          </>
        )}
        <Row label={t("up.targetSize")} hint={t("up.targetSizeHint")}>
          <input
            type="number"
            className="text-input"
            style={{ width: "min(90px, 100%)" }}
            value={params.targetW || ""}
            placeholder="0"
            aria-label={t("up.targetW")}
            title={t("up.targetW")}
            onChange={(e) => onParams({ targetW: Number(e.target.value) || 0 })}
          />
          <span className="muted-sm">×</span>
          <input
            type="number"
            className="text-input"
            style={{ width: "min(90px, 100%)" }}
            value={params.targetH || ""}
            placeholder="0"
            aria-label={t("up.targetH")}
            title={t("up.targetH")}
            onChange={(e) => onParams({ targetH: Number(e.target.value) || 0 })}
          />
        </Row>
      </div>

      {/* --- Память и тайлинг --- */}
      <div className="up-pro-section">
        <div className="up-pro-section-title">
          <Cpu size={14} /> {t("up.sectionMemory")}
        </div>
        <Row label={t("up.tile")} hint={t("up.tileHint")}>
          <Select
            value={String(params.tile)}
            onChange={(e) => onParams({ tile: Number(e.target.value) })}
            options={tileOptions}
            style={{ width: "min(130px, 100%)" }}
          />
        </Row>
        <Row label={t("up.overlap", { v: params.overlap })} hint={t("up.overlapHint")}>
          <input
            type="range"
            min={0}
            max={64}
            step={4}
            value={params.overlap}
            onChange={(e) => onParams({ overlap: Number(e.target.value) })}
            style={{ width: "min(180px, 100%)" }}
          />
        </Row>
        <Row label={t("up.threads")} hint={t("up.threadsHint")}>
          <input
            type="number"
            className="text-input"
            min={0}
            max={64}
            style={{ width: "min(80px, 100%)" }}
            value={params.threads || ""}
            placeholder="0"
            onChange={(e) => onParams({ threads: Number(e.target.value) || 0 })}
          />
        </Row>
        <Row label={t("up.provider")} hint={t("up.providerHint")}>
          <Select
            value={params.provider}
            onChange={(e) => onParams({ provider: e.target.value })}
            options={providerOptions}
            style={{ width: "min(150px, 100%)" }}
          />
        </Row>
        {/* GPU-пакет: отдельная сборка рантайма с CUDA/TensorRT. Ступени ставятся
            по одной — первая даёт CUDA, вторая добавляет TensorRT. Без пака всё
            работает на DirectML/CPU, поэтому состояние показываем честно. */}
        <Row label={t("up.packTitle")} hint={t("up.packHint")}>
          <div className="up-pack">
            <span className="muted-sm up-pro-note">{packText}</span>
            {pack?.restart ? (
              <span className="muted-sm up-pro-note">{t("up.packRestart")}</span>
            ) : null}
            {pack?.busy ? (
              <>
                <ProgressBar value={packStep?.percent || 0} />
                <span className="muted-sm up-pro-note">
                  {packStateText(t, packStep?.state || "download")} ·{" "}
                  {humanMb(packStep?.gotMb || 0)} / {humanMb(packStep?.totalMb || 0)}
                </span>
                <Btn onClick={onPackCancel}>{t("up.packCancel")}</Btn>
              </>
            ) : (
              <div className="up-pack-actions">
                {packSteps.map((s) => (
                  <Btn key={s.id} onClick={() => onPackInstall(s.id)}>
                    {t("up.packGet", { title: s.title, mb: humanMb(s.mb) })}
                  </Btn>
                ))}
                <Btn onClick={onPackCheck}>{t("up.packCheck")}</Btn>
                {pack?.installed ? (
                  <Btn onClick={onPackRemove}>{t("up.packRemove", { mb: humanMb(pack.mb) })}</Btn>
                ) : null}
              </div>
            )}
            {/* Ошибку показываем как есть: это код вида pack_sha_mismatch — по нему
                понятно, что именно пошло не так. */}
            {pack?.error ? <span className="muted-sm up-pro-note">{pack.error}</span> : null}
          </div>
        </Row>
        {/* Точность: у ONNX-модели она такая, как её выпустили, а вот TensorRT
            компилирует граф под GPU и умеет FP16 — это и есть «кнопка точности»
            для NVIDIA. AMD/Intel/CPU работают обычным ONNX-путём. */}
        <Row label={t("up.precision")} hint={t("up.precisionHint")}>
          <span className="muted-sm up-pro-note">
            {params.provider === "tensorrt" ? t("up.precisionTrt") : t("up.precisionOnnx")}
          </span>
        </Row>
      </div>

      {/* --- Пост-обработка --- */}
      <div className="up-pro-section">
        <div className="up-pro-section-title">{t("up.sectionPost")}</div>
        <Row label={t("up.sharpen", { v: params.sharpen })} hint={t("up.sharpenHint")}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={params.sharpen}
            onChange={(e) => onParams({ sharpen: Number(e.target.value) })}
            style={{ width: "min(180px, 100%)" }}
          />
        </Row>
        <Row label={t("up.denoise", { v: params.denoise })} hint={t("up.denoiseHint")}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={params.denoise}
            onChange={(e) => onParams({ denoise: Number(e.target.value) })}
            style={{ width: "min(180px, 100%)" }}
          />
        </Row>
        {/* Формат и качество — только у картинки: у видео свои кодек и CRF. */}
        {!isVideo ? (
          <>
            <Row label={t("up.format")} hint={t("up.formatHint")}>
              <Select
                value={params.format}
                onChange={(e) => onParams({ format: e.target.value })}
                options={["png", "jpeg", "webp", "avif"]}
                style={{ width: "min(120px, 100%)" }}
              />
            </Row>
            <Row label={t("up.quality")} hint={t("up.qualityHint")}>
              <input
                type="number"
                className="text-input"
                min={1}
                max={100}
                style={{ width: "min(80px, 100%)" }}
                value={params.quality}
                onChange={(e) => onParams({ quality: Number(e.target.value) || 92 })}
              />
            </Row>
          </>
        ) : null}
      </div>

      {/* --- Смешивание двух моделей --- */}
      <div className="up-pro-section">
        <div className="up-pro-section-title">{t("up.sectionBlend")}</div>
        <Row label={t("up.blendModel")} hint={t("up.blendModelHint")}>
          <Select
            value={params.model2}
            onChange={(e) => onParams({ model2: e.target.value })}
            options={blendOptions}
            style={{ width: "min(220px, 100%)" }}
          />
        </Row>
        <Row label={t("up.blendAmount", { v: params.blendAmount })} hint={t("up.blendAmountHint")}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={params.blendAmount}
            disabled={!params.model2}
            onChange={(e) => onParams({ blendAmount: Number(e.target.value) })}
            style={{ width: "min(180px, 100%)" }}
          />
        </Row>
      </div>

      {/* --- Видео и плавность: у картинки кадров нет --- */}
      {isVideo ? (
        <>
          <div className="up-pro-section">
            <div className="up-pro-section-title">
              <Film size={14} /> {t("up.sectionVideo")}
            </div>
            <Row label={t("up.vcodec")} hint={t("up.vcodecHint")}>
              <Select
                value={params.vcodec}
                onChange={(e) => onParams({ vcodec: e.target.value })}
                options={["x264", "x265", "av1"]}
                style={{ width: "min(110px, 100%)" }}
              />
            </Row>
            <Row label={t("up.vcrf", { v: params.vcrf })} hint={t("up.vcrfHint")}>
              <input
                type="range"
                min={0}
                /* У AV1 шкала качества длиннее (0–63), у H.264/HEVC — 0–51. */
                max={params.vcodec === "av1" ? 63 : 51}
                step={1}
                value={params.vcrf}
                onChange={(e) => onParams({ vcrf: Number(e.target.value) })}
                style={{ width: "min(180px, 100%)" }}
              />
            </Row>
            {/* Кодирование и распаковку можно отдать видеокарте (NVENC/QSV/AMF).
                Подсказка показывает, что сборка ffmpeg умеет на этой машине. */}
            <Row label={t("up.hwAccel")} hint={`${t("up.hwAccelHint")} ${hwSummary}`.trim()}>
              <Select
                value={params.hwAccel ? "on" : "off"}
                onChange={(e) => onParams({ hwAccel: e.target.value === "on" })}
                options={[
                  { value: "on", label: t("up.hwOn") },
                  { value: "off", label: t("up.hwOff") },
                ]}
                style={{ width: "min(150px, 100%)" }}
              />
            </Row>
            <Row label={t("up.audio")} hint={t("up.audioHint")}>
              <Select
                value={params.audioAction}
                onChange={(e) => onParams({ audioAction: e.target.value })}
                options={[
                  { value: "copy", label: t("up.audioCopy") },
                  { value: "aac", label: t("up.audioAac") },
                ]}
                style={{ width: "min(150px, 100%)" }}
              />
            </Row>
            <Row label={t("up.slowMotion")} hint={t("up.slowMotionHint")}>
              <Select
                value={String(params.slowMotion)}
                onChange={(e) => onParams({ slowMotion: Number(e.target.value) })}
                options={[
                  { value: "1", label: t("up.slowOff") },
                  { value: "0.5", label: "0.5×" },
                  { value: "0.25", label: "0.25×" },
                ]}
                style={{ width: "min(120px, 100%)" }}
              />
            </Row>
          </div>

          {/* --- Производительность и превью: только видео (кадров у фото нет) --- */}
          <div className="up-pro-section">
            <div className="up-pro-section-title">
              <Film size={14} /> {t("up.sectionVideoPerf")}
            </div>
            {canBatchFrames && batchReason !== "unsupported" ? (
              <Row
                label={
                  params.batchFrames === BATCH_AUTO && batchUsed > 1
                    ? t("up.batchFramesAutoUsed", { n: batchUsed })
                    : t("up.batchFrames")
                }
                hint={t("up.batchFramesHint")}
              >
                <Select
                  value={String(params.batchFrames)}
                  onChange={(e) => onParams({ batchFrames: Number(e.target.value) })}
                  /* «Авто» + тот же список, что BATCH_SIZES на сервере: движок сам
                     подбирает пачку по видеопамяти, ручные значения урезает по памяти. */
                  options={BATCH_CHOICES.map((n) => ({
                    value: String(n),
                    label: n === BATCH_AUTO ? t("up.batchAuto") : String(n),
                  }))}
                  style={{ width: "min(90px, 100%)" }}
                />
              </Row>
            ) : (
              /* Модель считает по одному кадру за проход (batch=1 в каталоге):
                 настройка пачки не просто бесполезна — она бы только держала
                 десятки полных кадров в памяти. Поэтому поля здесь нет. */
              <Row label={t("up.batchFrames")} hint={t("up.batchSingleHint")}>
                <span className="muted-sm">{t("up.batchSingle")}</span>
              </Row>
            )}
            <Row label={t("up.frameLimit")} hint={t("up.frameLimitHint")}>
              <input
                type="number"
                className="text-input"
                min={0}
                max={100000}
                step={10}
                style={{ width: "min(100px, 100%)" }}
                value={params.frameLimit || ""}
                placeholder={t("up.frameLimitOff")}
                onChange={(e) => onParams({ frameLimit: Number(e.target.value) || 0 })}
              />
            </Row>
          </div>

          {/* --- Интерполяция кадров (плавность) --- */}
          <div className="up-pro-section">
            <div className="up-pro-section-title">
              <Gauge size={14} /> {t("up.sectionInterp")}
            </div>
            <Row label={t("up.interpMode")} hint={t("up.interpModeHint")}>
              <Select
                value={params.interpMode}
                onChange={(e) => onParams({ interpMode: e.target.value })}
                options={[
                  { value: "off", label: t("up.interpOff") },
                  { value: "ffmpeg", label: t("up.interpFfmpeg") },
                  { value: "model", label: t("up.interpModelLabel") },
                ]}
                style={{ width: "min(220px, 100%)" }}
              />
            </Row>
            {/* Модель-интерполятор: свой каталог (kind="interp") — у неё нет
                множителя апскейла, зато есть схема входов и ×кадров. */}
            {params.interpMode === "model" ? (
              <Row label={t("up.interpModel")} hint={t("up.interpModelHint")}>
                <Select
                  value={params.interpModel || (interpModel ? interpModel.id : "")}
                  onChange={(e) => onParams({ interpModel: e.target.value })}
                  options={
                    interpList.length
                      ? interpList.map((m) => ({
                          value: m.id,
                          // «· по тайлу» — у модели пачка не поддерживается: видно
                          // прямо в списке, не открывая каталог.
                          label: `${m.label} (×${m.mult})${
                            m.batch === 1 ? ` · ${t("up.batchTilesNone")}` : ""
                          }${m.available ? "" : ` · ${t("up.modelMissing")}`}`,
                        }))
                      : [{ value: "", label: t("up.interpNoModel") }]
                  }
                  style={{ width: "min(220px, 100%)" }}
                />
                {interpModel && !interpModel.available ? (
                  <Badge tone="coral">{t("up.interpModelNeedsDownload")}</Badge>
                ) : null}
              </Row>
            ) : null}
            {/* Режим minterpolate и сторона расчёта — только у ffmpeg-интерполяции. */}
            {/* Множитель плавности — общий для обоих режимов: у ONNX-модели
                предел зависит от схемы (CAIN умеет только ×2, RIFE/IFRNet — до ×4). */}
            {params.interpMode !== "off" ? (
              <Row
                label={t("up.interpMult", { v: params.interpMult })}
                hint={
                  params.interpMode === "model"
                    ? `${t("up.interpMultHint")} ${t("up.interpMultModelHint")}`
                    : t("up.interpMultHint")
                }
              >
                <Select
                  value={String(params.interpMult)}
                  onChange={(e) => onParams({ interpMult: Number(e.target.value) })}
                  options={[2, 3, 4]
                    .filter((n) => n <= (params.interpMode === "model" ? interpMultMax : 4))
                    .map((n) => ({ value: String(n), label: `×${n}` }))}
                  style={{ width: "min(100px, 100%)" }}
                />
              </Row>
            ) : null}
            {params.interpMode === "ffmpeg" ? (
              <>
                <Row label={t("up.minterpMode")} hint={t("up.minterpModeHint")}>
                  <Select
                    value={params.minterpolateMode}
                    onChange={(e) => onParams({ minterpolateMode: e.target.value })}
                    options={[
                      { value: "mci", label: t("up.minterpMci") },
                      { value: "blend", label: t("up.minterpBlend") },
                      { value: "dup", label: t("up.minterpDup") },
                    ]}
                    style={{ width: "min(220px, 100%)" }}
                  />
                </Row>
              </>
            ) : null}
            {params.interpMode === "model" ? (
              canInterpBatch ? (
                <Row
                  label={
                    params.interpBatch === BATCH_AUTO && interpBatchUsed > 1
                      ? t("up.interpBatchAutoUsed", { n: interpBatchUsed })
                      : t("up.interpBatch")
                  }
                  hint={t("up.interpBatchHint")}
                >
                  <Select
                    value={String(params.interpBatch)}
                    onChange={(e) => onParams({ interpBatch: Number(e.target.value) })}
                    options={INTERP_BATCH_CHOICES.map((n) => ({
                      value: String(n),
                      label: n === BATCH_AUTO ? t("up.batchAuto") : String(n),
                    }))}
                    style={{ width: "min(90px, 100%)" }}
                  />
                </Row>
              ) : (
                /* У наших интерполяторов ось batch в графе фиксирована: второй
                   настройки пачки для них нет — считаем по тайлу за раз. */
                <Row label={t("up.interpBatch")} hint={t("up.interpBatchSingleHint")}>
                  <span className="muted-sm">{t("up.batchSingle")}</span>
                </Row>
              )
            ) : null}
            {/* Сторона расчёта — общая настройка: у minterpolate это сторона
                фильтра, у ONNX-модели — где считать вставки (апскейл и
                интерполятор меняются местами по цене). */}
            {params.interpMode !== "off" ? (
              <Row label={t("up.minterpSide")} hint={t("up.minterpSideHint")}>
                <Select
                  value={params.minterpolateSide}
                  onChange={(e) => onParams({ minterpolateSide: e.target.value })}
                  options={[
                    { value: "decode", label: t("up.minterpDecode") },
                    { value: "encode", label: t("up.minterpEncode") },
                  ]}
                  style={{ width: "min(220px, 100%)" }}
                />
              </Row>
            ) : null}
            {/* Порог сцены общий для обоих режимов: у модели по нему переключаемся
                на дубли, у minterpolate это scd_threshold. */}
            <Row
              label={t("up.sceneCut", { v: params.sceneCutThreshold })}
              hint={t("up.sceneCutHint")}
            >
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={params.sceneCutThreshold}
                onChange={(e) => onParams({ sceneCutThreshold: Number(e.target.value) })}
                style={{ width: "min(180px, 100%)" }}
              />
            </Row>
          </div>
        </>
      ) : null}
    </div>
  );
}
