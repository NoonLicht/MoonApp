import { useEffect, useState } from "react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Overview = Awaited<ReturnType<typeof api.gaps>>;
type Suggest = Awaited<ReturnType<typeof api.gapsSuggest>>;

/**
 * Карта белых пятен: чем у вас много заметок, на что есть ссылки без заметок и
 * какие связанные подтемы не раскрыты (их предлагает модель, покрытие считается
 * по вашим заметкам).
 */
export default function GapsSection() {
  const { t } = useI18n();
  const [ov, setOv] = useState<Overview | null>(null);
  const [topic, setTopic] = useState("");
  const [res, setRes] = useState<Suggest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    void api
      .gaps()
      .then((r) => live && setOv(r))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, []);

  const suggest = async (name: string) => {
    if (!name.trim() || busy) return;
    setTopic(name);
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      setRes(await api.gapsSuggest(name.trim()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.mind.gaps.title")}</b>
      {ov && ov.topics.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {ov.topics.slice(0, 14).map((x) => (
            <button key={x.term} className="btn" onClick={() => void suggest(x.term)} title={`${x.docs}`}>
              {x.term} · {x.docs}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder={t("myspace.mind.gaps.placeholder")}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void suggest(topic)}
        />
        <Btn disabled={busy || !topic.trim()} onClick={() => void suggest(topic)}>
          {busy ? "…" : t("myspace.mind.gaps.find")}
        </Btn>
      </div>
      {err && <div className="muted-sm">{err}</div>}
      {res && (
        <div>
          <div className="muted-sm">{t("myspace.mind.gaps.covered", { topic: res.topic, n: res.covered })}</div>
          {res.items.map((i) => (
            <div key={i.topic} style={{ fontSize: 12 }}>
              {i.gap ? "◌" : "●"} {i.topic} — {t("myspace.mind.gaps.notes", { n: i.docs })}
            </div>
          ))}
        </div>
      )}
      {ov && ov.dangling.length > 0 && (
        <div>
          <div className="muted-sm">{t("myspace.mind.gaps.dangling")}</div>
          {ov.dangling.slice(0, 8).map((d) => (
            <div key={d.target} style={{ fontSize: 12 }}>
              [[{d.target}]] × {d.mentions}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
