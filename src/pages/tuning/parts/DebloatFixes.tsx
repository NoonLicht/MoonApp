import { useState } from "react";
import { Wrench } from "lucide-react";
import { Glass, Btn, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { describeResult } from "@/pages/tuning/parts/tuningShared";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

const FIX_IDS = ["sfc", "dism", "winsock-reset", "explorer-restart", "store-reset", "wu-reset"];
const FIX_ADMIN = new Set(["sfc", "dism", "winsock-reset", "wu-reset"]);

/**
 * Разовые действия восстановления (не твики: откатить «SFC /scannow» нельзя,
 * поэтому они живут отдельно от списка переключателей, как кнопки с результатом).
 */
export default function DebloatFixes({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string) => {
    if (!window.confirm(t("tuning.fixConfirm", { name: t(`tuning.fix.${id}.t`) }))) return;
    setBusy(id);
    try {
      const r = await api.tuningFix(id);
      const d = describeResult(r, t, t("tuning.fixDone"));
      ctx.notify(d.text, d.ok);
    } catch (e) {
      ctx.notify((e as Error).message, false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Glass style={{ padding: 14, marginTop: 12 }}>
      <b className="tn-card-title">
        <Wrench size={14} /> {t("tuning.fixTitle")}
      </b>
      <div className="muted-sm">{t("tuning.fixHint")}</div>
      <div className="tn-list">
        {FIX_IDS.map((id) => (
          <div key={id} className="tn-row">
            <div className="tn-row-main">
              <div className="tn-row-title">{t(`tuning.fix.${id}.t`)}</div>
              <div className="muted-sm">{t(`tuning.fix.${id}.d`)}</div>
            </div>
            {FIX_ADMIN.has(id) && !ctx.ov.admin && (
              <Badge tone="amber">{t("tuning.adminYes")}</Badge>
            )}
            <Btn disabled={busy !== null} onClick={() => void run(id)}>
              {busy === id ? t("tuning.working") : t("tuning.fixRun")}
            </Btn>
          </div>
        ))}
      </div>
    </Glass>
  );
}
