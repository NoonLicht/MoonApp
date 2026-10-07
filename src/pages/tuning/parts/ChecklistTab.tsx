import { Activity, ListChecks } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import Checklist from "@/pages/tuning/parts/Checklist";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

const SECTIONS = ["physical", "cooling", "peripherals", "stability", "install", "maintenance"];

/** Ручные шаги из гайда, которые нельзя автоматизировать: железо, охлаждение, периферия, обслуживание. */
export default function ChecklistTab({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  return (
    <div>
      <Glass style={{ padding: 14 }}>
        <div className="tn-sub">
          <b className="tn-card-title">{t("tuning.checklistTitle")}</b>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn icon={ListChecks} onClick={() => void api.tuningOpen("msinfo")}>
              {t("tuning.openMsinfo")}
            </Btn>
            <Btn icon={Activity} onClick={() => void api.tuningOpen("eventvwr")}>
              {t("tuning.openEvents")}
            </Btn>
          </div>
        </div>
        <div className="muted-sm">{t("tuning.checklistHint")}</div>
      </Glass>
      {SECTIONS.map((s) => (
        <Glass key={s} style={{ padding: 14, marginTop: 12 }}>
          <Checklist section={s} ctx={ctx} />
        </Glass>
      ))}
    </div>
  );
}
