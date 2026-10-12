import { useCallback, useEffect, useState } from "react";
import { BellRing, HardDrive } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { Glass, Btn, EmptyHint } from "@/components/ui";
import { SubHead } from "@/pages/monitor/parts/MonitorSensors";
import { api } from "@/api/client";

type Data = Awaited<ReturnType<typeof api.monitorAlerts>>;
type Hist = Awaited<ReturnType<typeof api.monitorHistory>>;

/** Мини-график: линия значений в рамке 100×30 (null-точки пропускаются). */
function Spark({ values, max = 100 }: { values: (number | null)[]; max?: number }) {
  const pts = values
    .map((v, i) => (v === null ? null : `${(i / Math.max(1, values.length - 1)) * 100},${30 - (Math.min(v, max) / max) * 30}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: "100%", height: 48 }}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * История температур/загрузки за последний час, список сработавших алертов
 * и состояние дисков (SMART). Сбор по умолчанию выключен — включается здесь.
 */
export function MonitorAlertsPanel() {
  const { t } = useI18n();
  const [data, setData] = useState<Data | null>(null);
  const [hist, setHist] = useState<Hist>([]);
  const [error, setError] = useState("");
  const [hourly, setHourly] = useState<Awaited<ReturnType<typeof api.monitorHourly>>>([]);

  const load = useCallback(async () => {
    try {
      setData(await api.monitorAlerts());
      setHist(await api.monitorHistory(60));
      setHourly(await api.monitorHourly());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = async () => {
    if (!data) return;
    await api.updateSettings({ monitor: { alertsEnabled: !data.enabled } });
    await load();
  };

  return (
    <Glass className="p-4 mt-4">
      <SubHead>{t("monitor.alertsTitle")}</SubHead>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <Btn variant={data?.enabled ? "primary" : "ghost"} onClick={toggle}>
          <BellRing size={14} /> {data?.enabled ? t("monitor.alertsOn") : t("monitor.alertsOff")}
        </Btn>
        <span className="muted-sm">{t("monitor.alertsHint")}</span>
      </div>
      {error && <div style={{ color: "var(--danger, #e66)", fontSize: 12 }}>{error}</div>}
      {hist.length > 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <div>
            <div className="muted-sm">{t("monitor.alertsCpuTemp")}</div>
            <Spark values={hist.map((h) => h.cpuTemp)} />
          </div>
          <div>
            <div className="muted-sm">{t("monitor.alertsGpuTemp")}</div>
            <Spark values={hist.map((h) => h.gpuTemp)} />
          </div>
          <div>
            <div className="muted-sm">{t("monitor.alertsLoad")}</div>
            <Spark values={hist.map((h) => h.cpuLoad)} />
          </div>
        </div>
      )}
      {hourly.some((h) => h.samples > 0) && (
        <div style={{ marginTop: 12 }}>
          <div className="muted-sm">{t("monitor.alertsHeat")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(24, 1fr)", gap: 2, marginTop: 4 }}>
            {hourly.map((h) => {
              const v = h.cpuLoad ?? 0;
              return (
                <div
                  key={h.hour}
                  title={`${h.hour}:00 — CPU ${h.cpuLoad ?? "—"}%${h.cpuTemp !== null ? `, ${h.cpuTemp} °C` : ""}`}
                  style={{
                    height: 26,
                    borderRadius: 3,
                    background: h.samples
                      ? `color-mix(in srgb, var(--coral) ${Math.min(100, v)}%, var(--track))`
                      : "var(--track)",
                    fontSize: 9,
                    textAlign: "center",
                    paddingTop: 6,
                    boxSizing: "border-box",
                  }}
                >
                  {h.hour}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {data && data.smart.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {data.smart.map((d) => (
            <div key={d.name} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "center" }}>
              <HardDrive size={13} /> {d.name} — {d.health || "?"}
              {d.temperatureC !== null ? ` · ${d.temperatureC} °C` : ""}
              {d.wearPercent !== null ? ` · ${t("monitor.alertsWear", { n: d.wearPercent })}` : ""}
            </div>
          ))}
        </div>
      )}
      {data && data.alerts.length === 0 && (
        <EmptyHint icon={BellRing} text={t("monitor.alertsEmpty")} />
      )}
      {data?.alerts.map((a) => (
        <div key={a.id} style={{ fontSize: 12, marginTop: 6 }}>
          <span className="muted-sm">{new Date(a.at).toLocaleString()}</span> — {a.message}
        </div>
      ))}
    </Glass>
  );
}
