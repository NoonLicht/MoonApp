import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { Glass, Btn, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { ProcRow } from "@/api/client";
import { describeResult } from "@/pages/tuning/parts/tuningShared";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

const PRIORITIES = ["Idle", "BelowNormal", "Normal", "AboveNormal", "High"];

/** Приоритет и привязка к ядрам процессов: на лету или навсегда (IFEO). */
export default function ProcessTool({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [cpus, setCpus] = useState(0);
  const [items, setItems] = useState<ProcRow[]>([]);
  const [pid, setPid] = useState(0);
  const [prio, setPrio] = useState("High");
  const [cores, setCores] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.tuningProcesses();
      setCpus(r.cpus);
      setItems(r.items);
    } catch (e) {
      ctx.notify((e as Error).message, false);
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = items.find((p) => p.pid === pid);

  const pick = (p: ProcRow) => {
    setPid(p.pid);
    setPrio(p.priority);
    const set = new Set<number>();
    for (let i = 0; i < cpus; i++) if (Math.floor(p.affinity / 2 ** i) % 2 === 1) set.add(i);
    setCores(set);
  };

  const mask = [...cores].reduce((m, i) => m + 2 ** i, 0);

  const apply = async () => {
    if (!selected || !mask) return;
    const r = await api.tuningProcessSet({ pid: selected.pid, priority: prio, affinity: mask });
    const d = describeResult(r, t, t("tuning.procApplied"));
    ctx.notify(d.text, d.ok);
    void load();
  };

  const persist = async () => {
    if (!selected) return;
    await ctx.run(() => api.tuningIfeoAdd(`${selected.name}.exe`, prio), t("tuning.ifeoSaved"));
  };

  return (
    <Glass style={{ padding: 14, marginTop: 12 }}>
      <div className="tn-sub">
        <b className="tn-card-title">{t("tuning.procTitle")}</b>
        <Btn icon={RefreshCw} onClick={() => void load()} disabled={loading}>
          {t("tuning.refresh")}
        </Btn>
      </div>
      <div className="muted-sm">{t("tuning.procHint")}</div>
      <div className="tn-proc-list">
        {items.map((p) => (
          <button
            key={p.pid}
            type="button"
            className={`tn-proc ${p.pid === pid ? "sel" : ""}`}
            onClick={() => pick(p)}
          >
            <span>{p.name}</span>
            <span className="muted-sm">
              {p.pid} · {p.priority} · {Math.round(p.mem / 1048576)} MB
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="tn-proc-edit">
          <Select
            value={prio}
            onChange={(e) => setPrio(e.target.value)}
            options={PRIORITIES.map((p) => ({ value: p, label: t(`tuning.prio.${p}`) }))}
          />
          <div className="tn-cores">
            {Array.from({ length: cpus }, (_, i) => (
              <label key={i} className={`tn-core ${cores.has(i) ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={cores.has(i)}
                  onChange={() => {
                    const n = new Set(cores);
                    if (n.has(i)) n.delete(i);
                    else n.add(i);
                    setCores(n);
                  }}
                />
                {i}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="primary" onClick={() => void apply()} disabled={!mask}>
              {t("tuning.procApply")}
            </Btn>
            <Btn onClick={() => void persist()}>{t("tuning.ifeoAdd")}</Btn>
          </div>
        </div>
      )}
      {ctx.ov.ifeo.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="muted-sm">{t("tuning.ifeoRules")}</div>
          {ctx.ov.ifeo.map((r) => (
            <div key={r.exe} className="tn-row">
              <div className="tn-row-main tn-row-title">
                {r.exe} → {t(`tuning.prio.${r.priority}`)}
              </div>
              <Btn
                icon={Trash2}
                onClick={() =>
                  void ctx.run(() => api.tuningIfeoRemove(r.exe), t("tuning.ifeoRemoved"))
                }
              />
            </div>
          ))}
        </div>
      )}
    </Glass>
  );
}
