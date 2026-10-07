import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Trash2, ArrowUpCircle } from "lucide-react";
import { Glass, Btn, Badge, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { WuApp } from "@/api/client";
import { describeResult } from "@/pages/tuning/parts/tuningShared";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

/**
 * Установка программ через winget — каталог взят из winutil
 * (ChrisTitusTech/winutil, MIT). Выбор переключателями, действие над выбранным.
 */
export default function WinutilApps({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [apps, setApps] = useState<WuApp[]>([]);
  const [installed, setInstalled] = useState<Set<string> | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .wuApps()
      .then(setApps)
      .catch((e: Error) => ctx.notify(e.message, false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = useMemo(() => [...new Set(apps.map((a) => a.cat))].sort(), [apps]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return apps.filter(
      (a) => (!cat || a.cat === cat) && (!s || a.name.toLowerCase().includes(s)),
    );
  }, [apps, q, cat]);

  const toggle = (id: string) =>
    setSel((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const detect = async () => {
    setBusy(true);
    try {
      setInstalled(new Set(await api.wuAppsInstalled()));
    } catch (e) {
      ctx.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  const run = async (mode: "install" | "uninstall" | "upgrade") => {
    if (!sel.size) return;
    if (!window.confirm(t("tuning.wu.appsConfirm", { mode: t(`tuning.wu.mode.${mode}`), n: sel.size })))
      return;
    setBusy(true);
    try {
      const d = describeResult(await api.wuAppsRun([...sel], mode), t, t("tuning.fixDone"));
      ctx.notify(d.text, d.ok);
      if (d.ok) {
        setSel(new Set());
        await detect();
      }
    } catch (e) {
      ctx.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="muted-sm" style={{ margin: "4px 0 8px" }}>
        {t("tuning.wu.appsHint")}
      </div>
      <div className="tn-bar glass">
        <input
          className="tn-input"
          placeholder={t("tuning.wu.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 120 }}
        />
        <Select
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          options={[{ value: "", label: t("tuning.wu.allCats") }, ...cats]}
        />
        <Btn icon={RefreshCw} disabled={busy} onClick={() => void detect()}>
          {t("tuning.wu.detect")}
        </Btn>
      </div>
      <div className="tn-bar glass">
        <span className="muted-sm">{t("privacy.selected", { n: sel.size })}</span>
        <Btn onClick={() => setSel(new Set())} disabled={!sel.size || busy}>
          {t("tuning.discard")}
        </Btn>
        <Btn icon={Trash2} onClick={() => void run("uninstall")} disabled={!sel.size || busy}>
          {t("tuning.wu.mode.uninstall")}
        </Btn>
        <Btn icon={ArrowUpCircle} onClick={() => void run("upgrade")} disabled={!sel.size || busy}>
          {t("tuning.wu.mode.upgrade")}
        </Btn>
        <Btn
          variant="primary"
          icon={Download}
          onClick={() => void run("install")}
          disabled={!sel.size || busy}
        >
          {busy ? t("tuning.working") : t("tuning.wu.mode.install")}
        </Btn>
      </div>
      <Glass style={{ padding: "4px 14px", marginTop: 8 }}>
        {shown.map((a) => {
          const checked = sel.has(a.id);
          return (
            <div key={a.id} className="tn-row">
              <div className="tn-row-main">
                <div className="tn-row-title">{a.name}</div>
                <div className="muted-sm">{a.cat}</div>
              </div>
              {installed?.has(a.id) && <Badge tone="teal">{t("tuning.wu.installed")}</Badge>}
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={a.name}
                className={`tn-switch ${checked ? "on" : ""}`}
                onClick={() => toggle(a.id)}
              />
            </div>
          );
        })}
      </Glass>
    </div>
  );
}
