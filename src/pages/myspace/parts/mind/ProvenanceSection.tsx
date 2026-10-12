import { useEffect, useState } from "react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { publishProvenance } from "@/pages/myspace/parts/provenanceMarks";

type Res = Awaited<ReturnType<typeof api.mindProvenanceClassify>>;

const COLOR = { own: "#3fb27f", copied: "#e0a030", ai: "#5b8def" } as const;

/**
 * Автор мысли: какие абзацы вы написали сами, какие вставили и какие пришли от
 * ИИ. Показывается цветной разметкой абзацев и долями.
 */
export default function ProvenanceSection({ path, content }: { path: string | null; content: string }) {
  const { t } = useI18n();
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState("");

  // Разметка в тексте живёт, пока открыта панель и та же заметка.
  useEffect(() => {
    return () => publishProvenance(null);
  }, [path]);

  const run = async () => {
    if (!path) return;
    setErr("");
    try {
      const r = await api.mindProvenanceClassify(path, content);
      setRes(r);
      publishProvenance(r.paragraphs);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.mind.author.title")}</b>
      <div className="muted-sm">{t("myspace.mind.author.hint")}</div>
      <Btn disabled={!path} onClick={() => void run()}>
        {t("myspace.mind.author.run")}
      </Btn>
      {err && <div className="muted-sm">{err}</div>}
      {res && (
        <>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden" }}>
            {(["own", "copied", "ai"] as const).map((k) => (
              <span key={k} style={{ width: `${res.summary.pct[k]}%`, background: COLOR[k] }} />
            ))}
          </div>
          <div className="muted-sm">
            <span style={{ color: COLOR.own }}>■</span> {t("myspace.mind.author.own")} {res.summary.pct.own}% ·{" "}
            <span style={{ color: COLOR.copied }}>■</span> {t("myspace.mind.author.copied")}{" "}
            {res.summary.pct.copied}% · <span style={{ color: COLOR.ai }}>■</span> {t("myspace.mind.author.ai")}{" "}
            {res.summary.pct.ai}%
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            {res.paragraphs.map((p, i) => (
              <div
                key={i}
                title={t(`myspace.mind.author.${p.origin}`)}
                style={{
                  fontSize: 12,
                  borderLeft: `4px solid ${COLOR[p.origin]}`,
                  paddingLeft: 6,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {content.slice(p.start, Math.min(p.end, p.start + 90)).replace(/\s+/g, " ")}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
