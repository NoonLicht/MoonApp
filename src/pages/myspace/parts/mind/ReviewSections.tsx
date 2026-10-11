import { useState } from "react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

/** Секции «Мышления», работающие с текстом открытой заметки: противоречия и рецензент. */
export function ContradictionsSection({ path, content }: { path: string | null; content: string }) {
  const { t } = useI18n();
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.mindContradictions>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    if (!path || busy) return;
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      setRes(await api.mindContradictions(path, content));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.mind.contra.title")}</b>
      <Btn disabled={!path || busy} onClick={() => void run()}>
        {busy ? "…" : t("myspace.mind.contra.run")}
      </Btn>
      {err && <div className="muted-sm">{err}</div>}
      {res && res.findings.length === 0 && (
        <div className="muted-sm">
          {res.claims === 0 ? t("myspace.mind.contra.noClaims") : t("myspace.mind.contra.none")}
        </div>
      )}
      {res?.model === "failed" && res.findings.length > 0 && (
        <div className="muted-sm">{t("myspace.mind.contra.heuristic")}</div>
      )}
      {res?.findings.map((f, i) => (
        <div key={i} className="lec-exam-card" style={{ fontSize: 12 }}>
          <div>
            <b>{t("myspace.mind.contra.now")}:</b> {f.claim}
          </div>
          <div>
            <b>
              {t("myspace.mind.contra.before")} «{f.source}»:
            </b>{" "}
            {f.passage}
          </div>
          <div className="muted-sm">
            {f.by === "model" ? f.why : t(`myspace.mind.contra.why.${f.why}`)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ReviewSection({ content }: { content: string }) {
  const { t } = useI18n();
  const [focus, setFocus] = useState<"general" | "evidence" | "audience" | "logic">("general");
  const [qs, setQs] = useState<{ quote: string; question: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    setQs(null);
    try {
      setQs((await api.mindReview(content, focus)).questions);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m === "text_too_short" ? t("myspace.mind.review.short") : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.mind.review.title")}</b>
      <div className="muted-sm">{t("myspace.mind.review.hint")}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <select
          className="input"
          value={focus}
          onChange={(e) => setFocus(e.target.value as typeof focus)}
        >
          <option value="general">{t("myspace.mind.review.general")}</option>
          <option value="evidence">{t("myspace.mind.review.evidence")}</option>
          <option value="audience">{t("myspace.mind.review.audience")}</option>
          <option value="logic">{t("myspace.mind.review.logic")}</option>
        </select>
        <Btn disabled={busy} onClick={() => void run()}>
          {busy ? "…" : t("myspace.mind.review.run")}
        </Btn>
      </div>
      {err && <div className="muted-sm">{err}</div>}
      {qs?.length === 0 && <div className="muted-sm">{t("myspace.mind.review.empty")}</div>}
      {qs?.map((q, i) => (
        <div key={i} style={{ fontSize: 13 }}>
          {q.quote && <span className="muted-sm">«{q.quote}» — </span>}
          {q.question}
        </div>
      ))}
    </div>
  );
}
