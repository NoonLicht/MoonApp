import { useEffect, useState } from "react";
import { Power, XCircle } from "lucide-react";
import { Glass, Btn, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { BiosFacts } from "@/api/client";
import Checklist from "@/pages/tuning/parts/Checklist";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

type Verdict = "good" | "warn" | "info";

interface Fact {
  key: string;
  value: string;
  verdict: Verdict;
}

const yn = (v: boolean | null, t: (k: string) => string): string =>
  v === null ? t("tuning.unknown") : v ? t("tuning.yes") : t("tuning.no");

/** Что видно из Windows о прошивке + чек-лист настроек BIOS/UEFI. */
export default function BiosTab({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [f, setF] = useState<BiosFacts | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .tuningBios()
      .then(setF)
      .catch((e) => ctx.notify((e as Error).message, false))
      .finally(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const facts: Fact[] = f
    ? [
        {
          key: "board",
          value: `${f.board} · ${f.biosVendor} ${f.biosVersion} (${f.biosDate})`,
          verdict: "info",
        },
        { key: "cpu", value: `${f.cpu.trim()} · ${f.cores}C/${f.threads}T`, verdict: "info" },
        {
          key: "smt",
          value: f.threads > f.cores ? t("tuning.smtOn") : t("tuning.smtOff"),
          verdict: "info",
        },
        { key: "uefi", value: yn(f.uefi, t), verdict: f.uefi === false ? "warn" : "good" },
        { key: "secureBoot", value: yn(f.secureBoot, t), verdict: "info" },
        { key: "tpm", value: yn(f.tpm, t), verdict: "info" },
        {
          key: "virt",
          value: yn(f.virtualization, t),
          verdict: f.virtualization ? "warn" : "good",
        },
        {
          key: "ram",
          value: `${f.ramModules} × · ${f.ramConfigured} / ${f.ramSpeed} MHz`,
          verdict: f.ramConfigured && f.ramSpeed && f.ramConfigured < f.ramSpeed ? "warn" : "good",
        },
        { key: "gpu", value: f.gpu.join(", "), verdict: "info" },
        { key: "hags", value: yn(f.hags, t), verdict: "info" },
      ]
    : [];

  const reboot = async () => {
    if (!window.confirm(t("tuning.uefiConfirm"))) return;
    await ctx.run(() => api.tuningOpen("uefi"), t("tuning.uefiScheduled"));
  };

  return (
    <div>
      <Glass style={{ padding: 14 }}>
        <div className="tn-sub">
          <b className="tn-card-title">{t("tuning.biosFacts")}</b>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn icon={Power} onClick={() => void reboot()}>
              {t("tuning.uefiReboot")}
            </Btn>
            <Btn
              icon={XCircle}
              onClick={() => void ctx.run(() => api.tuningOpen("abort"), t("tuning.uefiAborted"))}
            >
              {t("tuning.uefiAbort")}
            </Btn>
          </div>
        </div>
        <div className="muted-sm">{t("tuning.biosHint")}</div>
        {loaded && !f && <div className="muted-sm">{t("tuning.biosUnavailable")}</div>}
        <div className="tn-facts">
          {facts.map((x) => (
            <div key={x.key} className="tn-fact">
              <span className="muted-sm">{t(`tuning.fact.${x.key}`)}</span>
              <span className="tn-row-title">{x.value}</span>
              {x.verdict !== "info" && (
                <Badge tone={x.verdict === "good" ? "teal" : "amber"}>
                  {t(`tuning.verdict.${x.key}.${x.verdict}`)}
                </Badge>
              )}
            </div>
          ))}
        </div>
      </Glass>
      <Glass style={{ padding: 14, marginTop: 12 }}>
        <Checklist section="bios" ctx={ctx} />
      </Glass>
    </div>
  );
}
