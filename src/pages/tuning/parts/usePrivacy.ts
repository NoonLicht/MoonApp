import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { PrivacyOverview } from "@/api/client";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

type ItemResult = { ok: boolean; removed: number; error?: string };

/**
 * Состояние и логика вкладки «Приватность» вынесены из компонента, чтобы
 * TuningPage мог показать строку выбора и кнопку зачистки в собственной
 * закреплённой панели — как у вкладок с твиками (TweaksList + tn-bar),
 * а не внутри прокручиваемого содержимого вкладки, где кнопка «терялась».
 */
export function usePrivacy(notify: (text: string, ok?: boolean) => void) {
  const { t } = useI18n();
  const [ov, setOv] = useState<PrivacyOverview | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [lastResults, setLastResults] = useState<Record<string, ItemResult> | null>(null);

  const reload = useCallback(async () => {
    try {
      const o = await api.privacyOverview();
      setOv(o);
      setSel((s) => new Set([...s].filter((id) => o.items.some((i) => i.id === id))));
    } catch (e) {
      notify((e as Error).message, false);
    }
  }, [notify]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = useCallback((id: string) => {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const clearSel = useCallback(() => setSel(new Set()), []);

  const runWipe = useCallback(
    async (ids: string[], confirmText: string) => {
      if (!ov || !ids.length) return;
      if (!window.confirm(confirmText)) return;
      setBusy(true);
      try {
        const r =
          ids.length === ov.items.length ? await api.privacyPanic() : await api.privacyWipe(ids);
        setLastResults(r.results as never);
        notify(
          r.failed.length
            ? t("privacy.doneWithErrors", { removed: r.removed, failed: r.failed.length })
            : t("privacy.done", { removed: r.removed, bytes: fmtBytes(r.bytes) }),
          r.failed.length === 0,
        );
        setSel(new Set());
        await reload();
      } catch (e) {
        notify((e as Error).message, false);
      } finally {
        setBusy(false);
      }
    },
    [ov, notify, reload, t],
  );

  const panic = useCallback(
    () => runWipe(ov?.items.map((i) => i.id) ?? [], t("privacy.panicConfirm")),
    [ov, runWipe, t],
  );

  const wipeSelected = useCallback(
    () => runWipe([...sel], t("privacy.confirmSelected", { n: sel.size })),
    [sel, runWipe, t],
  );

  return { ov, sel, busy, lastResults, toggle, clearSel, panic, wipeSelected, reload };
}

export type UsePrivacy = ReturnType<typeof usePrivacy>;
