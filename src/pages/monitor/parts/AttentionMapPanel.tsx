import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Week = Awaited<ReturnType<typeof api.attentionWeek>>;

const hh = (h: number) => String(h).padStart(2, "0");

/**
 * Карта внимания: неделя × 24 часа (приложения, лекции, задачи, вероятный сон)
 * и вопрос к ИИ «куда уходит время». Данные почасовые — с момента включения
 * трекера времени в приложениях.
 */
export function AttentionMapPanel() {
  const { t } = useI18n();
  const [data, setData] = useState<Week | null>(null);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void api
      .attentionWeek()
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setError("");
    setAnswer("");
    try {
      const r = await api.attentionAsk(question.trim());
      setAnswer(r.answer);
    } catch (e) {
      const m = (e as Error).message;
      setError(m === "no_data" ? t("monitor.attention.noData") : m);
    } finally {
      setBusy(false);
    }
  };

  const week = data?.week;
  const f = data?.facts;

  return (
    <section className="card" style={{ padding: 12, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Eye size={16} /> <b>{t("monitor.attention.title")}</b>
      </div>
      {error && <div className="muted-sm">{error}</div>}
      {data && !data.hasData && <div className="muted-sm">{t("monitor.attention.noData")}</div>}
      {week && data?.hasData && (
        <>
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gap: 2, minWidth: 520 }}>
              <div
                style={{ display: "grid", gridTemplateColumns: "64px repeat(24, 1fr)", gap: 2, fontSize: 10 }}
                className="muted-sm"
              >
                <span />
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} style={{ textAlign: "center" }}>
                    {h % 3 === 0 ? hh(h) : ""}
                  </span>
                ))}
              </div>
              {week.days.map((d) => (
                <div
                  key={d.date}
                  style={{ display: "grid", gridTemplateColumns: "64px repeat(24, 1fr)", gap: 2 }}
                >
                  <span className="muted-sm" style={{ fontSize: 11 }}>
                    {d.date.slice(5)}
                  </span>
                  {d.cells.map((c, h) => {
                    const v = week.maxAppSec ? c.appSec / week.maxAppSec : 0;
                    const sleeping =
                      d.sleep &&
                      (d.sleep.from <= d.sleep.to
                        ? h >= d.sleep.from && h < d.sleep.to
                        : false);
                    return (
                      <span
                        key={h}
                        title={`${hh(h)}:00 · ${c.topApp || "—"} · ${Math.round(c.appSec / 60)} ${t("monitor.attention.min")}${
                          c.lectureSec ? ` · ${t("monitor.attention.lecture")} ${Math.round(c.lectureSec / 60)}` : ""
                        }${c.tasks ? ` · ${t("monitor.attention.tasks")} ${c.tasks}` : ""}`}
                        style={{
                          height: 16,
                          borderRadius: 3,
                          background:
                            v > 0
                              ? `color-mix(in srgb, var(--accent, #7c5cff) ${Math.round(15 + v * 85)}%, transparent)`
                              : sleeping
                                ? "color-mix(in srgb, #4a6fa5 30%, transparent)"
                                : "var(--track)",
                          outline: c.lectureSec ? "2px solid var(--amber, #e0a030)" : "none",
                          outlineOffset: -2,
                          boxShadow: c.tasks ? "inset 0 -3px 0 var(--green, #3fb27f)" : "none",
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="muted-sm">{t("monitor.attention.legend")}</div>
          {f && (
            <div className="muted-sm">
              {t("monitor.attention.facts", {
                active: f.avgActiveHours,
                evening: Math.round(f.eveningShare * 100),
                streak: f.longestStreakHours,
                sleep: f.avgSleepHours ?? "—",
              })}
            </div>
          )}
          {data.insights.map((k) => {
            const [kind, val] = k.split(":");
            return (
              <div key={k} className="muted-sm">
                • {t(`monitor.attention.insight.${kind}`, { n: val })}
              </div>
            );
          })}
        </>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 220 }}
          placeholder={t("monitor.attention.placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask(q)}
        />
        <Btn disabled={busy || !q.trim()} onClick={() => void ask(q)}>
          {busy ? "…" : t("monitor.attention.ask")}
        </Btn>
        <Btn variant="ghost" disabled={busy} onClick={() => void ask(t("monitor.attention.evening"))}>
          {t("monitor.attention.evening")}
        </Btn>
      </div>
      {answer && <div style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{answer}</div>}
    </section>
  );
}
