import { useEffect, useState } from "react";
import { Compass } from "lucide-react";
import { Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Report = Awaited<ReturnType<typeof api.drift>>;

/**
 * «Дрейф интересов»: по месяцам — главные темы заметок, закладок, лекций и
 * чатов, новые и угасающие. Как итоги года, но для мыслей. Считается по словам,
 * локально и без модели.
 */
export default function DriftPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || data) return;
    let live = true;
    void api
      .drift()
      .then((r) => live && setData(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, data]);

  return (
    <Glass style={{ marginTop: 12, padding: 12 }}>
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        <Compass size={14} /> {t("diary.drift.title")}
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {error && <div className="muted-sm">{error}</div>}
          {data && data.months.length === 0 && <div className="muted-sm">{t("diary.drift.empty")}</div>}
          {data && data.months.length > 0 && (
            <>
              <div>
                {data.topOverall && (
                  <div>
                    {t("diary.drift.overall")}: <b>{data.topOverall}</b>
                  </div>
                )}
                {data.persistent.length > 0 && (
                  <div className="muted-sm">
                    {t("diary.drift.persistent")}: {data.persistent.join(", ")}
                  </div>
                )}
                {data.biggestShift && (
                  <div className="muted-sm">
                    {t("diary.drift.biggest", {
                      month: data.biggestShift.month,
                      pct: Math.round(data.biggestShift.shift * 100),
                    })}
                  </div>
                )}
              </div>
              {[...data.months].reverse().map((m) => (
                <div key={m.month} className="lec-exam-card">
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <b>{m.month}</b>
                    <span className="muted-sm">
                      {t("diary.drift.docs", { n: m.docs })}
                      {m.shift !== null && ` · ${t("diary.drift.shift", { pct: Math.round(m.shift * 100) })}`}
                    </span>
                  </div>
                  <div>{m.top.slice(0, 6).map((x) => x.term).join(" · ")}</div>
                  {m.emerging.length > 0 && (
                    <div className="muted-sm">
                      ↑ {t("diary.drift.emerging")}: {m.emerging.join(", ")}
                    </div>
                  )}
                  {m.fading.length > 0 && (
                    <div className="muted-sm">
                      ↓ {t("diary.drift.fading")}: {m.fading.join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </Glass>
  );
}
