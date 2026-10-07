import { useEffect, useState } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { Glass, Btn, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { DriverRow } from "@/api/client";

/** Инвентаризация драйверов (видео, сеть, звук, USB, диски) и режим MSI для PCI-устройств. */
export default function DriversTable({ onError }: { onError: (m: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<DriverRow[] | null>(null);

  const load = async () => {
    setRows(null);
    try {
      setRows(await api.tuningDrivers());
    } catch (e) {
      onError((e as Error).message);
      setRows([]);
    }
  };

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Glass style={{ padding: 14, marginTop: 12 }}>
      <div className="tn-sub">
        <b className="tn-card-title">{t("tuning.driversTitle")}</b>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn icon={ExternalLink} onClick={() => void api.tuningOpen("devmgmt")}>
            {t("tuning.openDevmgmt")}
          </Btn>
          <Btn icon={RefreshCw} onClick={() => void load()}>
            {t("tuning.refresh")}
          </Btn>
        </div>
      </div>
      <div className="muted-sm">{t("tuning.driversHint")}</div>
      {rows === null && <div className="muted-sm">{t("tuning.loading")}</div>}
      <div className="tn-table">
        {rows?.map((r) => (
          <div key={r.id} className="tn-row">
            <div className="tn-row-main">
              <div className="tn-row-title">{r.name}</div>
              <div className="muted-sm">
                {r.cls} · {r.provider} · {r.version} · {r.date}
              </div>
            </div>
            {r.msi !== null && (
              <Badge tone={r.msi ? "teal" : "neutral"}>
                {r.msi ? t("tuning.msiOn") : t("tuning.msiOff")}
              </Badge>
            )}
          </div>
        ))}
      </div>
    </Glass>
  );
}
