import { Download, FolderOpen, Play, Square, Trash2, Upload } from "lucide-react";
import { Btn, Badge, Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";

/**
 * Пакетный режим апскейла: список выбранных файлов и их состояния.
 *
 * Каждый файл — отдельное задание в очереди движка (она последовательная), но
 * запускаются они одной кнопкой, а прогресс виден по каждому. Один и тот же
 * набор параметров применяется ко всем файлам — правки в панели справа по ходу
 * очереди не подхватываются (иначе первая и последняя картинка считались бы
 * по-разному).
 */
export interface BatchItem {
  /** Локальный ключ строки: имя + размер + время изменения. */
  key: string;
  file: File;
  /** id задания на сервере ("" — ещё не запускалось). */
  jobId: string;
  /** pending | queued | upscale | encode | done | error | stopped */
  stage: string;
  progress: number;
  error: string;
  outSize: number;
  outExt: string;
  /** Задание на паузе (кнопка «Пауза» у полосы прогресса общая для очереди). */
  paused?: boolean;
}

export default function UpscaleBatchList({
  items,
  busy,
  onAdd,
  onRun,
  onClear,
  onDownload,
  onDownloadAll,
  onReveal,
  onCancel,
}: {
  items: BatchItem[];
  /** Идёт хотя бы одно задание партии. */
  busy: boolean;
  onAdd: () => void;
  onRun: () => void;
  onClear: () => void;
  onDownload: (item: BatchItem) => void;
  onDownloadAll: () => void;
  onReveal: (item: BatchItem) => void;
  /** Мягкая остановка задания партии (маленькая кнопка у активной строки). */
  onCancel: (jobId: string) => void;
}) {
  const { t } = useI18n();
  const done = items.filter((x) => x.stage === "done").length;
  const failed = items.filter((x) => x.stage === "error").length;
  const started = items.filter((x) => x.jobId).length;

  return (
    <Glass className="up-card up-batch" style={{ flexDirection: "column", gap: 10 }}>
      <div className="up-batch-head">
        <div className="media-title up-ellipsis">{t("up.batchTitle", { n: items.length })}</div>
        <Badge tone={done && done === items.length ? "teal" : "neutral"}>
          {t("up.batchProgress", { done, total: items.length })}
        </Badge>
        {failed ? <Badge tone="coral">{t("up.batchFailed", { n: failed })}</Badge> : null}
      </div>
      <div className="muted-sm">{t("up.batchHint")}</div>

      <div className="up-batch-list">
        {items.map((it) => (
          <div className="up-batch-item" key={it.key}>
            <span className="up-batch-name" title={it.file.name}>
              {it.file.name}
            </span>
            <span className="up-batch-state">
              {it.stage === "error" ? (
                <Badge tone="coral">{t("up.batchError")}</Badge>
              ) : it.stage === "done" ? (
                <Badge tone="teal">{t("up.batchDone")}</Badge>
              ) : it.jobId ? (
                <span className="muted-sm">
                  {it.paused ? `${t("up.paused")} · ${it.progress}%` : `${it.progress}%`}
                </span>
              ) : (
                <span className="muted-sm">{t("up.batchWaiting")}</span>
              )}
            </span>
            {it.stage === "done" ? (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("up.batchDownload")}
                  onClick={() => onDownload(it)}
                >
                  <Download size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("ctx.reveal")}
                  onClick={() => onReveal(it)}
                >
                  <FolderOpen size={15} />
                </button>
              </>
            ) : it.jobId && it.stage !== "error" ? (
              /* Активный файл партии: маленький «Стоп» — прервать текущий,
                 остальные задания очереди можно остановить так же. */
              <button
                type="button"
                className="up-stop-btn"
                title={t("up.cancel")}
                aria-label={t("up.cancel")}
                onClick={() => onCancel(it.jobId)}
              >
                <Square size={11} />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="up-row-actions">
        <Btn
          variant="primary"
          icon={Play}
          onClick={onRun}
          disabled={busy || started === items.length}
        >
          {t("up.batchRun")}
        </Btn>
        <Btn icon={Upload} onClick={onAdd} disabled={busy}>
          {t("up.batchAdd")}
        </Btn>
        <Btn icon={Download} onClick={onDownloadAll} disabled={!done}>
          {t("up.batchDownloadAll")}
        </Btn>
        <Btn icon={Trash2} onClick={onClear} disabled={busy}>
          {t("up.batchClear")}
        </Btn>
      </div>
    </Glass>
  );
}
