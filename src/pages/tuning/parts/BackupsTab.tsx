import { useEffect, useState } from "react";
import { Archive, History, RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { Glass, Btn, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TuningBackup } from "@/api/client";
import { describeResult, fmtDate } from "@/pages/tuning/parts/tuningShared";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

/** Резервные копии настроек, точка восстановления Windows, откат и журнал действий. */
export default function BackupsTab({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [list, setList] = useState<TuningBackup[]>([]);
  const [label, setLabel] = useState("");

  const load = async () => {
    try {
      setList(await api.tuningBackups());
    } catch (e) {
      ctx.notify((e as Error).message, false);
    }
  };

  useEffect(() => {
    void load();
  }, [ctx.ov.history.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    await api.tuningBackupCreate(label.trim() || t("tuning.backupManual"));
    setLabel("");
    ctx.notify(t("tuning.backupCreated"), true);
    await ctx.reload();
    await load();
  };

  const restore = async (b: TuningBackup) => {
    if (!window.confirm(t("tuning.restoreConfirm", { label: b.label }))) return;
    const r = await api.tuningBackupRestore(b.id);
    const d = describeResult(r, t, t("tuning.restored"));
    ctx.notify(d.text, d.ok);
    await ctx.reload();
  };

  const rollback = async () => {
    if (!window.confirm(t("tuning.rollbackConfirm", { n: ctx.ov.applied }))) return;
    const r = await api.tuningRollbackAll();
    const d = describeResult(r, t, t("tuning.rolledBack"));
    ctx.notify(d.text, d.ok);
    await ctx.reload();
  };

  return (
    <div>
      <Glass style={{ padding: 14 }}>
        <div className="tn-sub">
          <b className="tn-card-title">{t("tuning.backupsTitle")}</b>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn icon={Undo2} onClick={() => void rollback()} disabled={ctx.ov.applied === 0}>
              {t("tuning.rollbackAll")} ({ctx.ov.applied})
            </Btn>
            <Btn
              icon={Archive}
              onClick={() =>
                void ctx.run(() => api.tuningRestorePoint(), t("tuning.restorePointDone"))
              }
            >
              {t("tuning.restorePoint")}
            </Btn>
            <Btn icon={RotateCcw} onClick={() => void api.tuningOpen("restore")}>
              {t("tuning.openRestore")}
            </Btn>
          </div>
        </div>
        <div className="muted-sm">{t("tuning.backupsHint")}</div>
        <div className="tn-bench-bar">
          <input
            className="tn-input"
            value={label}
            placeholder={t("tuning.backupLabel")}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Btn variant="primary" icon={Save} onClick={() => void create()}>
            {t("tuning.backupCreate")}
          </Btn>
        </div>
        {list.length === 0 && <div className="muted-sm">{t("tuning.backupsEmpty")}</div>}
        {list.map((b) => (
          <div key={b.id} className="tn-row">
            <div className="tn-row-main">
              <div className="tn-row-title">
                {b.label} {b.auto && <Badge tone="neutral">{t("tuning.auto")}</Badge>}
              </div>
              <div className="muted-sm">
                {fmtDate(b.at)} · {t("tuning.backupTweaks", { n: b.tweaks })}
              </div>
            </div>
            <Btn icon={RotateCcw} onClick={() => void restore(b)}>
              {t("tuning.restore")}
            </Btn>
            <Btn
              icon={Trash2}
              aria-label={t("tuning.delete")}
              onClick={() => void api.tuningBackupDelete(b.id).then(load)}
            />
          </div>
        ))}
      </Glass>
      <Glass style={{ padding: 14, marginTop: 12 }}>
        <div className="tn-sub">
          <b className="tn-card-title">
            <History size={14} /> {t("tuning.historyTitle")}
          </b>
        </div>
        {ctx.ov.history.length === 0 && <div className="muted-sm">{t("tuning.historyEmpty")}</div>}
        {ctx.ov.history.map((h, i) => (
          <div key={i} className="tn-row">
            <div className="tn-row-main">
              <div className="tn-row-title">{h.detail}</div>
              <div className="muted-sm">{fmtDate(h.at)}</div>
            </div>
            <Badge tone={h.ok ? "teal" : "coral"}>{t(`tuning.kind.${h.kind}`)}</Badge>
          </div>
        ))}
      </Glass>
    </div>
  );
}
