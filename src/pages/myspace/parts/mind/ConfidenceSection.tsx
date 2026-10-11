import { useCallback, useEffect, useState } from "react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Data = Awaited<ReturnType<typeof api.mindConfidence>>;

/**
 * Градус уверенности: метка «{70%: утверждение}» в заметке, напоминание
 * проверить к сроку и калибровка по итогам.
 */
export default function ConfidenceSection({
  path,
  content,
  onChange,
}: {
  path: string | null;
  content: string;
  onChange: (path: string, text: string) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Data | null>(null);
  const [pct, setPct] = useState(70);
  const [claim, setClaim] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api.mindConfidence());
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!path || !claim.trim()) return;
    const text = `${content.replace(/\s+$/, "")}\n\n{${pct}%: ${claim.trim()}}\n`;
    onChange(path, text);
    setClaim("");
    try {
      await api.mindConfidenceSync(path, text);
      await load();
      setMsg(t("myspace.mind.conf.added"));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const scan = async () => {
    try {
      const r = await api.mindConfidenceSync();
      setMsg(t("myspace.mind.conf.scanned", { n: r.added }));
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const resolve = async (id: string, outcome: boolean) => {
    await api.mindConfidenceResolve(id, outcome).catch(() => undefined);
    await load();
  };

  const c = data?.calibration;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.mind.conf.title")}</b>
      <div className="muted-sm">{t("myspace.mind.conf.hint")}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          style={{ width: 70 }}
          value={pct}
          onChange={(e) => setPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
        />
        <input
          className="input"
          style={{ flex: 1, minWidth: 140 }}
          placeholder={t("myspace.mind.conf.claim")}
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
        />
        <Btn disabled={!path || !claim.trim()} onClick={() => void add()}>
          {t("myspace.mind.conf.add")}
        </Btn>
        <Btn variant="ghost" onClick={() => void scan()}>
          {t("myspace.mind.conf.scan")}
        </Btn>
      </div>
      {msg && <div className="muted-sm">{msg}</div>}
      {data && data.due.length > 0 && (
        <div>
          <div className="muted-sm">{t("myspace.mind.conf.due")}</div>
          {data.due.map((e) => (
            <div key={e.id} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ flex: 1 }}>
                {e.pct}% · {e.claim} <span className="muted-sm">({e.due})</span>
              </span>
              <Btn variant="ghost" onClick={() => void resolve(e.id, true)}>
                {t("myspace.mind.conf.came")}
              </Btn>
              <Btn variant="ghost" onClick={() => void resolve(e.id, false)}>
                {t("myspace.mind.conf.notCame")}
              </Btn>
            </div>
          ))}
        </div>
      )}
      {c && c.resolved > 0 && (
        <div className="muted-sm">
          {t("myspace.mind.conf.calibration", { n: c.resolved, brier: c.brier ?? "—" })}
          {c.bias !== null && (
            <div>
              {c.bias > 5
                ? t("myspace.mind.conf.over", { n: c.bias })
                : c.bias < -5
                  ? t("myspace.mind.conf.under", { n: -c.bias })
                  : t("myspace.mind.conf.fine")}
            </div>
          )}
          {c.buckets.map((b) => (
            <div key={b.from}>
              {b.from}–{b.to}%: {t("myspace.mind.conf.bucket", { said: b.predicted, was: b.actual, n: b.n })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
