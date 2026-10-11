import { useCallback, useEffect, useState } from "react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Data = Awaited<ReturnType<typeof api.mindTraces>>;

/**
 * «Следы» решений: запоминает контекст решения, через полгода спрашивает
 * «вы были правы?». Создать след можно из открытой заметки (и из трат —
 * в разделе «Бюджет»).
 */
export default function TracesSection({ path, content }: { path: string | null; content: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<Data | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setData(await api.mindTraces());
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!path) return;
    const title = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
    try {
      await api.mindTraceCreate({
        kind: "note",
        ref: path,
        title,
        decision: content.replace(/\s+/g, " ").trim().slice(0, 1500) || title,
        reason: reason.trim(),
      });
      setReason("");
      setMsg(t("myspace.mind.traces.saved"));
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const verdict = async (id: string, v: "right" | "partly" | "wrong") => {
    await api.mindTraceReview(id, v, notes[id] ?? "").catch(() => undefined);
    await load();
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.mind.traces.title")}</b>
      <div className="muted-sm">{t("myspace.mind.traces.hint")}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder={t("myspace.mind.traces.reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Btn disabled={!path} onClick={() => void create()}>
          {t("myspace.mind.traces.save")}
        </Btn>
      </div>
      {msg && <div className="muted-sm">{msg}</div>}
      {data && data.track.score !== null && (
        <div className="muted-sm">
          {t("myspace.mind.traces.track", { score: data.track.score, n: data.track.reviewed })}
        </div>
      )}
      {data?.due.map((tr) => (
        <div key={tr.id} className="lec-exam-card" style={{ fontSize: 12 }}>
          <b>{tr.title}</b> <span className="muted-sm">({new Date(tr.createdAt).toLocaleDateString()})</span>
          <div>{tr.decision.slice(0, 220)}</div>
          {tr.reason && (
            <div className="muted-sm">
              {t("myspace.mind.traces.because")}: {tr.reason}
            </div>
          )}
          {tr.context.map((c, i) => (
            <div key={i} className="muted-sm">
              · {c.title}: {c.text.slice(0, 140)}
            </div>
          ))}
          <div style={{ marginTop: 4, fontWeight: 600 }}>{t("myspace.mind.traces.ask")}</div>
          <input
            className="input"
            placeholder={t("myspace.mind.traces.note")}
            value={notes[tr.id] ?? ""}
            onChange={(e) => setNotes((n) => ({ ...n, [tr.id]: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <Btn onClick={() => void verdict(tr.id, "right")}>{t("myspace.mind.traces.right")}</Btn>
            <Btn variant="ghost" onClick={() => void verdict(tr.id, "partly")}>
              {t("myspace.mind.traces.partly")}
            </Btn>
            <Btn variant="ghost" onClick={() => void verdict(tr.id, "wrong")}>
              {t("myspace.mind.traces.wrong")}
            </Btn>
          </div>
        </div>
      ))}
      {data && data.due.length === 0 && data.items.length > 0 && (
        <div className="muted-sm">{t("myspace.mind.traces.waiting", { n: data.items.filter((x) => !x.verdict).length })}</div>
      )}
    </div>
  );
}
