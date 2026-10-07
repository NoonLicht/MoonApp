import { useEffect, useRef, useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { BenchRun } from "@/api/client";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";
import { fmtDate } from "@/pages/tuning/parts/tuningShared";

/** Показатели замера: ключ, единицы, «меньше — лучше». */
const METRICS: { key: string; unit: string }[] = [
  { key: "timerCur", unit: "ms" },
  { key: "sleepAvg", unit: "ms" },
  { key: "sleepP99", unit: "ms" },
  { key: "sleepMax", unit: "ms" },
  { key: "dpcAvg", unit: "%" },
  { key: "dpcMax", unit: "%" },
  { key: "intAvg", unit: "%" },
  { key: "dpcRate", unit: "/s" },
];

interface MouseStat {
  avg: number;
  min: number;
  max: number;
  dev: number;
  n: number;
}

/** Частота опроса мыши по событиям pointermove (учитываются «склеенные» события). */
function MouseTester() {
  const { t } = useI18n();
  const last = useRef(0);
  const rates = useRef<number[]>([]);
  const [stat, setStat] = useState<MouseStat | null>(null);

  const onMove = (e: React.PointerEvent) => {
    const evs = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of evs) {
      const ts = ev.timeStamp;
      if (last.current) {
        const dt = ts - last.current;
        if (dt > 0.2 && dt < 100) rates.current.push(1000 / dt);
      }
      last.current = ts;
    }
    const r = rates.current;
    if (r.length > 30 && r.length % 20 === 0) {
      const avg = r.reduce((a, b) => a + b, 0) / r.length;
      const dev = Math.sqrt(r.reduce((a, b) => a + (b - avg) ** 2, 0) / r.length);
      setStat({ avg, min: Math.min(...r), max: Math.max(...r), dev, n: r.length });
    }
  };

  const reset = () => {
    rates.current = [];
    last.current = 0;
    setStat(null);
  };

  return (
    <Glass style={{ padding: 14, marginTop: 12 }}>
      <div className="tn-sub">
        <b className="tn-card-title">{t("tuning.mouseTitle")}</b>
        <Btn onClick={reset}>{t("tuning.mouseReset")}</Btn>
      </div>
      <div className="muted-sm">{t("tuning.mouseHint")}</div>
      <div className="tn-pad" onPointerMove={onMove} onPointerLeave={() => (last.current = 0)}>
        {stat ? (
          <div className="tn-pad-stat">
            <div className="tn-big">{Math.round(stat.avg)} Hz</div>
            <div className="muted-sm">
              min {Math.round(stat.min)} · max {Math.round(stat.max)} · σ {stat.dev.toFixed(0)} · n{" "}
              {stat.n}
            </div>
          </div>
        ) : (
          <span className="muted-sm">{t("tuning.mousePad")}</span>
        )}
      </div>
    </Glass>
  );
}

export default function BenchTab({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState("");

  const load = async () => {
    try {
      setRuns(await api.tuningBenchList());
    } catch (e) {
      ctx.notify((e as Error).message, false);
    }
  };

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.tuningBenchRun(label.trim() || fmtDate(Date.now()));
      if (!r.ok) ctx.notify(t("tuning.benchFailed"), false);
      else ctx.notify(t("tuning.benchDone"), true);
      setLabel("");
      await load();
    } catch (e) {
      ctx.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  const baseline = runs.find((r) => r.id === base) ?? runs[runs.length - 1];

  const delta = (run: BenchRun, key: string): string => {
    if (!baseline || baseline.id === run.id) return "";
    const a = baseline.data[key];
    const b = run.data[key];
    if (!a) return "";
    const p = ((b - a) / a) * 100;
    return `${p > 0 ? "+" : ""}${p.toFixed(0)}%`;
  };

  return (
    <div>
      <Glass style={{ padding: 14 }}>
        <div className="tn-sub">
          <b className="tn-card-title">{t("tuning.benchTitle")}</b>
        </div>
        <div className="muted-sm">{t("tuning.benchHint")}</div>
        <div className="tn-bench-bar">
          <input
            className="tn-input"
            value={label}
            placeholder={t("tuning.benchLabel")}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Btn variant="primary" icon={Play} disabled={busy} onClick={() => void start()}>
            {busy ? t("tuning.benchRunning") : t("tuning.benchRun")}
          </Btn>
        </div>
        {runs.length > 0 && (
          <div className="tn-bench-wrap">
            <table className="tn-bench">
              <thead>
                <tr>
                  <th>{t("tuning.benchRunCol")}</th>
                  {METRICS.map((m) => (
                    <th key={m.key}>{t(`tuning.metric.${m.key}`)}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={baseline?.id === r.id ? "base" : ""}>
                    <td>
                      <button
                        type="button"
                        className="tn-link"
                        onClick={() => setBase(r.id)}
                        title={t("tuning.benchBase")}
                      >
                        {r.label}
                      </button>
                      <div className="muted-sm">{fmtDate(r.at)}</div>
                    </td>
                    {METRICS.map((m) => (
                      <td key={m.key}>
                        {r.data[m.key]?.toFixed(m.unit === "ms" ? 3 : 2)}
                        <span className="muted-sm"> {delta(r, m.key)}</span>
                      </td>
                    ))}
                    <td>
                      <Btn
                        icon={Trash2}
                        onClick={() => void api.tuningBenchDelete(r.id).then(load)}
                        aria-label={t("tuning.delete")}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Glass>
      <MouseTester />
    </div>
  );
}
