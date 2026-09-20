import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CloudDownload,
  Cpu,
  Download,
  Gauge,
  HardDriveDownload,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Glass, Btn, Badge, ProgressBar } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { UpManifestInfo, UpModelInfo, UpParams, UpTrtStatus } from "@/api/types";
import { fmtDateTime } from "@/pages/upscale/parts/formatTime";

/**
 * Панель «Модели ONNX» — отдельный каталог со скачиванием, как «Модель и
 * ускорение» на странице лектория:
 *
 *  - карточки моделей со всеми фактами (размер, лицензия, множитель, архитектура),
 *  - фильтр по категориям (фото/видео/аниме/быстрые/детали/восстановление),
 *  - скачивание с полосой прогресса (прогресс отдаёт сервер, см. /models),
 *  - «Применить» — подставляет оптимальные настройки именно этой модели
 *    (тайл, перекрытие, резкость, шум, множитель интерполяции) из манифеста,
 *  - «Удалить» — освобождает место (файл уходит с диска, каталог остаётся).
 */
const TAG_ORDER = ["photo", "video", "anime", "fast", "detail", "restore", "heavy", "interp"];

/** «466 МБ» / «1.5 ГБ» */
function humanMb(mb: number): string {
  if (!mb) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Ошибка бэкенда → понятный текст (неизвестный код показываем как есть). */
function errorText(t: (k: string, v?: Record<string, unknown>) => string, raw: string): string {
  if (!raw) return "";
  const known = [
    "model_unknown",
    "model_no_url",
    "download_busy",
    "sha256_mismatch",
    "no_body",
    "runtime_missing",
    // Обновление каталога из GitHub (POST /api/upscale/models/sync).
    "manifest_fetch",
    "manifest_invalid",
    "manifest_empty",
    "manifest_too_big",
    "timeout",
  ];
  if (known.includes(raw)) return t(`up.mdlErr_${raw}`);
  if (raw.startsWith("http_")) return t("up.mdlErrHttp", { code: raw.replace("http_", "") });
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|abort|timeout/i.test(raw)) return t("up.mdlErrNet");
  return raw;
}

export default function UpscaleModelsPanel({
  models,
  params,
  busy,
  runtime,
  runtimeError,
  apiDown,
  dir,
  manifest,
  syncing,
  bulk,
  onDownload,
  onRemove,
  onDownloadAll,
  onRemoveAll,
  onApply,
  onOpenDir,
  onSync,
  onClose,
  trt,
  trtBusy,
  onBuildTrt,
}: {
  models: UpModelInfo[];
  params: UpParams;
  /** Ид модели, которая сейчас скачивается (блокирует кнопки). */
  busy: string;
  runtime: boolean;
  /** Причина, по которой рантайм не найден (показываем как есть). */
  runtimeError: string;
  /** API апскейла недоступен (нет ответа сервера) — отдельный текст, не про ONNX. */
  apiDown: boolean;
  dir: string;
  /** TensorRT: есть ли провайдер в сборке и сколько движков уже собрано. */
  trt: UpTrtStatus | null;
  /** Ид модели, для которой сейчас собирается движок TensorRT ("" — ничего). */
  trtBusy: string;
  onBuildTrt: (id: string, tile?: number) => void;
  onDownload: (id: string, force: boolean) => void;
  onRemove: (id: string) => void;
  /**
   * Пакетная операция над всеми файлами: сервер качает/удаляет по одному, поэтому
   * страница ведёт последовательность и отдаёт сюда прогресс «{done} из {total}».
   */
  bulk: { kind: "down" | "del"; done: number; total: number } | null;
  /** «Скачать все»: скачать файлы всех ещё не загруженных моделей. Ошибка — строкой. */
  onDownloadAll: () => Promise<string>;
  /** «Удалить все»: снести файлы всех скачанных моделей. Ошибка — строкой. */
  onRemoveAll: () => Promise<string>;
  /** Применить оптимальные настройки модели (rec из манифеста). */
  onApply: (m: UpModelInfo) => void;
  onOpenDir: () => void;
  /** Скачать свежий манифест из GitHub; возвращает текст ошибки ("" — успех). */
  onSync: () => Promise<string>;
  /** Откуда взят каталог (скачан кнопкой или вшит в сборку). */
  manifest?: UpManifestInfo;
  /** Идёт обновление каталога из GitHub (блокирует кнопку). */
  syncing: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tag, setTag] = useState<string>("");
  const [err, setErr] = useState("");
  /** TensorRT есть в сборке — только тогда показываем кнопку сборки движка. */
  const trtAvailable = !!trt?.available;

  // Esc закрывает панель — привычно для модалок.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * «Обновить каталог»: тянем свежий манифест из GitHub (или своего адреса).
   * Именно это позволяет добавить модель без обновления приложения.
   */
  const doSync = async () => {
    setErr("");
    const msg = await onSync();
    if (msg) setErr(msg);
  };

  /**
   * Пакетная операция по всем файлам сразу. «Удалить все» необратимо, поэтому
   * спрашиваем подтверждение; прогресс показывает страница (проп `bulk`).
   */
  const doAll = async (kind: "down" | "del") => {
    setErr("");
    if (kind === "del" && !window.confirm(t("up.mdlDeleteAllConfirm"))) return;
    const msg = kind === "down" ? await onDownloadAll() : await onRemoveAll();
    if (msg) setErr(msg);
  };
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of models) for (const tg of m.tags) c[tg] = (c[tg] || 0) + 1;
    return c;
  }, [models]);
  const tags = TAG_ORDER.filter((tg) => counts[tg]);
  const list = tag ? models.filter((m) => m.tags.includes(tag)) : models;
  const downloaded = models.filter((m) => m.available).length;
  const totalMb = models.filter((m) => m.available).reduce((s, m) => s + m.sizeMb, 0);
  /** Активна ли модель в текущих параметрах (для бейджа «выбрана»). */
  const inUse = (m: UpModelInfo) =>
    m.kind === "interp" ? params.interpModel === m.id : params.model === m.id;
  /** Модели с адресом, но без файла на диске — их и скачает «Скачать все». */
  const pending = models.filter((m) => !m.available && !!m.url).length;
  /**
   * Скачанные файлы, которые можно снести: выбранную сейчас модель «Удалить все»
   * пропускает (как и кнопка «Удалить» в её карточке) — иначе задача упадёт.
   */
  const removable = models.filter((m) => m.available && !inUse(m)).length;
  /** Пакетная операция идёт — блокируем и одиночные кнопки, и обе массовые. */
  const bulking = !!bulk;

  return (
    <div className="modal-overlay up-mdl-overlay" onClick={onClose}>
      {/* glass-solid — общая «непрозрачная» подложка модалок: страница не
          просвечивает сквозь каталог (как в окне выбора движка на лектории). */}
      <Glass
        className="up-mdl-panel glass-solid"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="up-mdl-head">
          <div className="up-mdl-title">
            <HardDriveDownload size={15} />
            <span>{t("up.modelsTitle")}</span>
            <Badge tone="teal">
              {t("up.mdlInstalledOf", { done: downloaded, total: models.length })}
            </Badge>
            {totalMb > 0 ? <Badge tone="neutral">{humanMb(totalMb)}</Badge> : null}
          </div>
          <div className="up-mdl-head-actions">
            <Btn
              icon={Download}
              disabled={bulking || pending === 0}
              onClick={() => void doAll("down")}
              title={t("up.mdlDownloadAllHint")}
            >
              {bulk?.kind === "down"
                ? t("up.mdlBulkDone", { done: bulk.done, total: bulk.total })
                : t("up.mdlDownloadAll")}
            </Btn>
            <Btn
              icon={Trash2}
              disabled={bulking || removable === 0}
              onClick={() => void doAll("del")}
              title={t("up.mdlDeleteAllConfirm")}
            >
              {bulk?.kind === "del"
                ? t("up.mdlBulkDone", { done: bulk.done, total: bulk.total })
                : t("up.mdlDeleteAll")}
            </Btn>
            <Btn
              variant="primary"
              icon={CloudDownload}
              disabled={syncing || bulking}
              onClick={() => void doSync()}
              title={t("up.mdlSyncHint")}
            >
              {syncing ? t("up.mdlSyncing") : t("up.mdlSync")}
            </Btn>
            <Btn icon={HardDriveDownload} onClick={onOpenDir} title={t("up.mdlFolder")}>
              {t("up.mdlFolder")}
            </Btn>
            <button className="up-icon-x" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Откуда каталог: важно видеть, что модель появилась из GitHub, а не
            из вшитого в сборку списка (и когда его обновляли). */}
        <div className="muted-sm up-mdl-src">
          <CloudDownload size={12} />
          <span>
            {manifest?.source === "remote"
              ? t("up.mdlSrcRemote", {
                  count: manifest.count,
                  date: fmtDateTime(manifest.updatedAt),
                })
              : t("up.mdlSrcBundled")}
          </span>
        </div>

        {apiDown ? (
          <div className="up-alert up-alert-warn">
            <AlertTriangle size={14} />
            <span>{t("up.apiDown")}</span>
          </div>
        ) : null}
        {!apiDown && !runtime ? (
          <div className="up-alert up-alert-warn up-alert-stack">
            <div className="up-alert-row">
              <Cpu size={14} />
              <span>{t("up.runtimeMissing")}</span>
              <code className="up-code">npm install onnxruntime-node</code>
            </div>
            {runtimeError ? (
              <div className="muted-sm up-runtime-why" title={runtimeError}>
                {t("up.runtimeWhy")} {runtimeError}
              </div>
            ) : null}
          </div>
        ) : null}
        {!apiDown && runtime ? (
          <div
            className="muted-sm up-mdl-trt"
            title={trtAvailable ? t("up.mdlTrtHint") : t("up.mdlTrtMissing")}
          >
            <Zap size={12} />
            {trtAvailable
              ? `${t("up.mdlTrtDone")} · ${trt?.engines.length ?? 0}`
              : t("up.mdlTrtMissing")}
          </div>
        ) : null}
        {err ? (
          <div className="up-alert">
            <AlertTriangle size={14} />
            <span className="up-err">{errorText(t, err)}</span>
          </div>
        ) : null}

        <div className="up-mdl-tags">
          <Badge tone={tag ? "neutral" : "violet"} active={!tag} onClick={() => setTag("")}>
            {t("up.mdlAll")}
          </Badge>
          {tags.map((tg) => (
            <Badge
              key={tg}
              tone="neutral"
              active={tag === tg}
              onClick={() => setTag(tag === tg ? "" : tg)}
            >
              {t(`up.tag_${tg}`)} · {counts[tg]}
            </Badge>
          ))}
          <span className="muted-sm up-mdl-dir" title={dir}>
            {dir}
          </span>
        </div>

        <div className="up-mdl-list">
          {list.map((m) => {
            const dl = m.downloading;
            const isBusy = busy === m.id || !!dl || bulking;
            return (
              <div key={m.id} className={`up-mdl-row${m.available ? " is-ready" : ""}`}>
                <div className="up-mdl-main">
                  <div className="up-mdl-name">
                    <span>{m.label}</span>
                    <Badge tone={m.kind === "interp" ? "violet" : "neutral"} mono>
                      {m.kind === "interp" ? `${t("up.kindInterp")} ×${m.mult}` : `×${m.scale}`}
                    </Badge>
                    {inUse(m) ? <Badge tone="amber">{t("up.mdlInUse")}</Badge> : null}
                    {/* Провайдер модели: часть графов (Anime4K) не идёт на DirectML —
                        каталог рекомендует CPU, движок ставит его первым. */}
                    {m.provider ? (
                      <span className="up-mdl-prov" title={t("up.mdlProviderCpu")}>
                        <Cpu size={12} /> {m.provider.toUpperCase()}
                      </span>
                    ) : null}
                    {/* Кратность сторон входа: Real-CUGAN принимает только чётные. */}
                    {m.align > 1 ? (
                      <span className="up-mdl-align" title={t("up.mdlAlignHint")}>
                        {t("up.mdlAlign")} {m.align}
                      </span>
                    ) : null}
                    {/* Пачка: у апскейлеров — кадров за проход, у интерполяторов — тайлов.
                        «1» — граф ждёт ровно один, поэтому настройки пачки в Pro нет. */}
                    {m.batch === 1 ? (
                      <Badge tone="coral">{t("up.mdlBatchFixed")}</Badge>
                    ) : m.batch > 1 ? (
                      <Badge tone="teal">{t("up.mdlBatchMax", { n: m.batch })}</Badge>
                    ) : (
                      <Badge tone="neutral">{t("up.mdlBatchUnknown")}</Badge>
                    )}
                    {m.sha256 ? (
                      <span title={`sha256 ${m.sha256}`}>
                        <Badge tone="neutral" mono>
                          sha256
                        </Badge>
                      </span>
                    ) : null}
                    {m.available ? (
                      <Badge tone="teal">{t("up.modelReady")}</Badge>
                    ) : m.url ? (
                      <Badge tone="neutral">{t("up.mdlNotDownloaded")}</Badge>
                    ) : (
                      <Badge tone="coral">{t("up.modelNoUrl")}</Badge>
                    )}
                  </div>
                  <div className="muted-sm up-mdl-facts">
                    <span>{humanMb(m.sizeMb)}</span>
                    <span className="up-dot">·</span>
                    <span>{m.license}</span>
                    <span className="up-dot">·</span>
                    <span>
                      {t("up.mdlArch")}: {m.arch}
                      {m.inputSig ? ` (${m.inputSig})` : ""}
                    </span>
                    {m.tags.map((tg) => (
                      <Badge key={tg} tone="neutral">
                        {t(`up.tag_${tg}`)}
                      </Badge>
                    ))}
                  </div>
                  <div className="muted-sm up-mdl-rec">
                    <Gauge size={12} />
                    <span>
                      {t("up.mdlRecRow", {
                        scale: m.rec.scale ?? m.scale,
                        tile: m.rec.tile ?? 0,
                        overlap: m.rec.overlap ?? 16,
                        denoise: m.rec.denoise ?? 0,
                        sharpen: m.rec.sharpen ?? 0,
                      })}
                    </span>
                  </div>
                  {m.hint ? <div className="muted-sm up-mdl-hint">{m.hint}</div> : null}
                  {dl ? (
                    <div className="up-mdl-progress">
                      <ProgressBar value={dl.percent} />
                      <span className="muted-sm">
                        {t("up.mdlProgress", {
                          got: dl.gotMb,
                          total: dl.totalMb || "?",
                          pct: dl.percent,
                        })}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="up-mdl-actions">
                  {!m.available && m.url ? (
                    <Btn
                      variant="primary"
                      icon={Download}
                      disabled={isBusy}
                      onClick={() => {
                        setErr("");
                        onDownload(m.id, false);
                      }}
                    >
                      {isBusy ? t("up.downloading") : t("up.downloadModel")}
                    </Btn>
                  ) : null}
                  {m.available ? (
                    <>
                      <Btn
                        icon={m.kind === "interp" ? Sparkles : Check}
                        disabled={!!busy || inUse(m)}
                        onClick={() => onApply(m)}
                      >
                        {t("up.mdlApply")}
                      </Btn>
                      {m.url ? (
                        <Btn
                          icon={RefreshCw}
                          disabled={isBusy}
                          onClick={() => {
                            setErr("");
                            onDownload(m.id, true);
                          }}
                          title={t("up.mdlRedownload")}
                        >
                          {t("up.mdlRedownload")}
                        </Btn>
                      ) : null}
                      {trtAvailable && m.kind === "upscale" ? (
                        <Btn
                          icon={Zap}
                          disabled={!!busy || !!bulking || !!trtBusy}
                          onClick={() => {
                            setErr("");
                            onBuildTrt(m.id, m.rec.tile);
                          }}
                          title={t("up.mdlTrtHint")}
                        >
                          {trtBusy ? t("up.mdlTrtBusy") : t("up.mdlTrtBuild")}
                        </Btn>
                      ) : null}
                      <Btn
                        icon={Trash2}
                        disabled={isBusy || inUse(m)}
                        onClick={() => {
                          setErr("");
                          onRemove(m.id);
                        }}
                        title={t("up.mdlRemoveHint")}
                      >
                        {t("up.delete")}
                      </Btn>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Glass>
    </div>
  );
}
