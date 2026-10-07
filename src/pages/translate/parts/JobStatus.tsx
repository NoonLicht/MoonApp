import { ProgressBar } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { TrJob } from "@/api/client";

const sec = (ms: number): string => (ms / 1000).toFixed(1);

/** Прогресс задания и живая статистика: скорость генерации, токены, префилл, загрузка модели. */
export default function JobStatus({ job }: { job: TrJob }) {
  const { t } = useI18n();
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div style={{ marginTop: 8 }}>
      <ProgressBar value={job.status === "done" ? 100 : pct} />
      <div className="muted-sm">
        {t(`translate.st.${job.status}`)} · {job.done}/{job.total}
        {job.provider ? ` · ${job.provider}/${job.variant}` : ""}
        {job.error ? ` · ${job.error}` : ""}
      </div>
      {job.tokens > 0 && (
        <div className="tr-stats">
          <span className="tr-tps">
            {job.tps.toFixed(1)} <small>{t("translate.tps")}</small>
          </span>
          <span className="muted-sm">
            {t("translate.statTokens", { n: job.tokens })} ·{" "}
            {t("translate.statPrefill", { s: sec(job.prefillMs) })} ·{" "}
            {t("translate.statGen", { s: sec(job.genMs) })}
            {job.loadMs > 500 ? ` · ${t("translate.statLoad", { s: sec(job.loadMs) })}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
