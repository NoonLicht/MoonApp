import { useEffect, useRef, useState } from "react";
import { FileText, Stethoscope } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";

type Slow = Awaited<ReturnType<typeof api.slowdownStatus>>;
type Passport = Awaited<ReturnType<typeof api.pcPassport>>;

/**
 * Диагностика ПК: «Тормозит» — 30 секунд замеров и вывод «кто, когда, почему»;
 * «Паспорт» — железо, драйверы, история изменений и сбоев одним документом.
 */
export function DiagnosticsPanel() {
  const { t } = useI18n();
  const [slow, setSlow] = useState<Slow | null>(null);
  const [passport, setPassport] = useState<Passport | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  const investigate = async () => {
    setErr("");
    setSlow(null);
    setBusy("slow");
    try {
      const { id } = await api.slowdownStart(30);
      timer.current = window.setInterval(async () => {
        try {
          const s = await api.slowdownStatus(id);
          setSlow(s);
          if (!s.running) {
            if (timer.current) window.clearInterval(timer.current);
            timer.current = null;
            setBusy("");
          }
        } catch (e) {
          if (timer.current) window.clearInterval(timer.current);
          setErr((e as Error).message);
          setBusy("");
        }
      }, 1500);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m === "windows_only" ? t("monitor.diag.windowsOnly") : m);
      setBusy("");
    }
  };

  const makePassport = async () => {
    setErr("");
    setBusy("passport");
    try {
      setPassport(await api.pcPassport());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const download = async (anonymize: boolean) => {
    try {
      saveBlob(await api.pcPassportFile(anonymize), "pc-passport.md");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const v = slow?.verdict;
  const secs = (n: number) => `${Math.round(n)} ${t("monitor.diag.sec")}`;

  return (
    <section className="card" style={{ padding: 12, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Stethoscope size={16} /> <b>{t("monitor.diag.title")}</b>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn disabled={busy !== ""} onClick={() => void investigate()}>
          {busy === "slow" ? t("monitor.diag.measuring") : t("monitor.diag.slow")}
        </Btn>
        <Btn icon={FileText} variant="ghost" disabled={busy !== ""} onClick={() => void makePassport()}>
          {busy === "passport" ? "…" : t("monitor.diag.passport")}
        </Btn>
      </div>
      {err && <div className="muted-sm">{err}</div>}

      {slow && slow.running && (
        <div className="muted-sm">
          {t("monitor.diag.progress", { elapsed: slow.elapsed, total: slow.seconds, n: slow.samples })}
        </div>
      )}
      {v && (
        <div style={{ display: "grid", gap: 4 }}>
          <b>
            {v.main === "none" ? t("monitor.diag.fine") : t(`monitor.diag.cause.${v.main}`)}
          </b>
          <div className="muted-sm">
            {t("monitor.diag.avg", {
              cpu: v.avg.cpu,
              disk: v.avg.diskPct,
              mem: v.avg.memAvailMb,
              seconds: v.seconds,
            })}
          </div>
          {v.findings.map((f) => (
            <div key={f.cause} style={{ fontSize: 13 }}>
              • {t(`monitor.diag.find.${f.cause}`, { v: f.value })}{" "}
              {f.why && <span className="muted-sm">— {t(`monitor.diag.why.${f.why}`)}</span>}
            </div>
          ))}
          {v.culprits.length > 0 && (
            <div className="muted-sm">
              {v.culprits.map((c) => (
                <div key={c.name}>
                  <b>{c.name}</b>: CPU {c.avgCpu}% ({t("monitor.diag.peak")} {c.peakCpu}% {t("monitor.diag.at")}{" "}
                  {secs(c.peakAt)}), {t("monitor.diag.io")} {c.avgIoMbs} {t("monitor.diag.mbs")}, {c.memMb}{" "}
                  {t("monitor.diag.mb")}
                </div>
              ))}
            </div>
          )}
          {v.peak.cpu > 0 && (
            <div className="muted-sm">
              {t("monitor.diag.peaks", { cpu: v.peak.cpu, cpuAt: secs(v.peak.cpuAt), disk: v.peak.diskPct, diskAt: secs(v.peak.diskAt) })}
            </div>
          )}
        </div>
      )}

      {passport && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => void download(false)}>
              {t("monitor.diag.save")}
            </Btn>
            <Btn variant="ghost" onClick={() => void download(true)}>
              {t("monitor.diag.saveAnon")}
            </Btn>
          </div>
          {passport.stale.length > 0 && (
            <div className="muted-sm">
              {t("monitor.diag.stale")}: {passport.stale.map((d) => `${d.name} (${d.date})`).join(", ")}
            </div>
          )}
          <pre className="muted-sm" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", userSelect: "text" }}>
            {passport.markdown}
          </pre>
        </div>
      )}
    </section>
  );
}
