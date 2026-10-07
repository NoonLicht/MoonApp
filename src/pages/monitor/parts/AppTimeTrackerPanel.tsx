/**
 * Выделено из MonitorPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import { useI18n } from "@/app/i18n";
import { useState, useEffect } from "react";
import type { AppTimeToday } from "@/api/types";
import { api } from "@/api/client";
import { Glass, Btn } from "@/components/ui";
import { StopCircle, Play, Timer } from "lucide-react";
import { SubHead } from "@/pages/monitor/parts/MonitorSensors";
import { fmtDuration } from "@/pages/monitor/parts/MonitorDisk";

/**
 * Трекер времени за приложениями: опрос активного окна раз в 5с через
 * долгоживущий PowerShell-процесс (server/ts/appTimeTracker.ts). Данные
 * копятся по дням, ничего никуда не отправляется — только storage/*.json.
 */
export function AppTimeTrackerPanel() {
  const { t } = useI18n();
  const [tracking, setTracking] = useState(false);
  const [today, setToday] = useState<AppTimeToday | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [st, td] = await Promise.all([api.appTrackerStatus(), api.appTrackerToday()]);
      setTracking(st.tracking);
      setToday(td);
    } catch {
      /* сервер недоступен — пропускаем опрос */
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, []);

  const toggle = async () => {
    setError("");
    try {
      if (tracking) await api.appTrackerStop();
      else {
        const r = await api.appTrackerStart();
        if (!r.ok) {
          setError(r.error === "windows_only" ? t("monitor.appTrackerWindowsOnly") : r.error || "");
          return;
        }
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const maxSeconds = today?.apps[0]?.seconds || 1;

  return (
    <Glass className="chart-panel">
      <SubHead>{t("monitor.appTracker")}</SubHead>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        {t("monitor.appTrackerHint")}
      </div>
      <Btn
        variant="primary"
        icon={tracking ? StopCircle : Play}
        onClick={() => void toggle()}
        style={{ width: 200, marginBottom: 10 }}
      >
        {tracking ? t("monitor.appTrackerStop") : t("monitor.appTrackerStart")}
      </Btn>
      {error && <div style={{ color: "var(--coral)", marginBottom: 8 }}>{error}</div>}

      {today && today.apps.length === 0 && (
        <div className="muted-sm">{t("monitor.appTrackerEmpty")}</div>
      )}

      {today && today.apps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {today.apps.slice(0, 12).map((a) => (
            <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Timer size={13} className="muted-sm" />
              <span style={{ width: 160, fontSize: 12.5 }} title={a.name}>
                {a.name}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 8,
                  borderRadius: 4,
                  background: "var(--track, rgba(255,255,255,0.06))",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.max(2, (a.seconds / maxSeconds) * 100)}%`,
                    height: "100%",
                    background: "var(--amber)",
                  }}
                />
              </div>
              <span className="muted-sm" style={{ width: 90, textAlign: "right" }}>
                {fmtDuration(a.seconds)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Glass>
  );
}
