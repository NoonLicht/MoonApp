import type { TuningOverview, TuningResult } from "@/api/client";
import type { TranslateFn } from "@/app/i18n";

/** Общий контекст вкладок страницы «Тюнинг ПК». */
export interface TuningCtx {
  ov: TuningOverview;
  reload: () => Promise<void>;
  notify: (text: string, ok?: boolean) => void;
  /** Выполнить действие с блокировкой кнопок и показом результата. */
  run: (fn: () => Promise<TuningResult>, okText?: string) => Promise<void>;
}

/** Человекочитаемый итог операции (UAC отменён, ошибки, нужна перезагрузка). */
export function describeResult(
  r: TuningResult,
  t: TranslateFn,
  okText: string,
): { text: string; ok: boolean } {
  if (r.error === "uac_cancelled") return { text: t("tuning.uacCancelled"), ok: false };
  if (r.error) return { text: `${t("tuning.error")}: ${r.error}`, ok: false };
  if (r.failed.length)
    return { text: t("tuning.failedSome", { n: r.failed.length, first: r.failed[0] }), ok: false };
  return { text: r.needsReboot ? `${okText} ${t("tuning.rebootNeeded")}` : okText, ok: true };
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}
