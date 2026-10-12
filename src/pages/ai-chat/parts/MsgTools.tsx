import { useState } from "react";
import { BookmarkPlus, SearchCheck, Scale } from "lucide-react";
import { api } from "@/api/client";

type Check = Awaited<ReturnType<typeof api.chatFactCheck>>["results"];
type Verdict = Awaited<ReturnType<typeof api.chatJudge>>;

const ICON: Record<string, string> = { supported: "✅", related: "🟡", none: "⚪" };

/**
 * Действия над ответом ассистента: сохранить в заметки и проверить утверждения
 * по заметкам (локально, без обращения к модели). Результат показывается под ответом.
 */
export default function MsgTools({
  question,
  answer,
  t,
}: {
  question: string;
  answer: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<Check | null>(null);
  const [err, setErr] = useState("");
  const [judging, setJudging] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const save = async () => {
    setErr("");
    try {
      const r = await api.chatSaveAnswer(question, answer);
      setSaved(r.path ?? "");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const check = async () => {
    setChecking(true);
    setErr("");
    try {
      setResults((await api.chatFactCheck(answer)).results);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const judge = async () => {
    setJudging(true);
    setErr("");
    try {
      setVerdict(await api.chatJudge(question, answer));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setJudging(false);
    }
  };

  return (
    <>
      <button onClick={() => void save()} title={t("aichat.saveToNotes")}>
        <BookmarkPlus size={11} /> {saved ? t("aichat.savedToNotes") : t("aichat.saveToNotes")}
      </button>
      <button onClick={() => void check()} disabled={checking} title={t("aichat.checkNotes")}>
        <SearchCheck size={11} /> {checking ? t("aichat.checking") : t("aichat.checkNotes")}
      </button>
      <button onClick={() => void judge()} disabled={judging} title={t("aichat.judge")}>
        <Scale size={11} /> {judging ? t("aichat.judging") : t("aichat.judge")}
      </button>
      {(err || saved || results || verdict) && (
        <div className="muted-sm" style={{ flexBasis: "100%", marginTop: 4 }}>
          {err && <div style={{ color: "var(--danger, #e66)" }}>{err}</div>}
          {saved && <div>{t("aichat.savedAs", { path: saved })}</div>}
          {verdict && (
            <div style={{ marginTop: 3 }}>
              <strong>{t("aichat.judgeScore", { n: verdict.score })}</strong>
              {verdict.summary && <span> — {verdict.summary}</span>}
              {verdict.issues.map((x, i) => (
                <div key={i}>• {x}</div>
              ))}
            </div>
          )}
          {results && results.length === 0 && <div>{t("aichat.checkNothing")}</div>}
          {results?.map((r, i) => (
            <div key={i} style={{ marginTop: 3 }}>
              {ICON[r.support]} {r.claim}
              {r.hits[0] && (
                <span style={{ opacity: 0.7 }}>
                  {" "}
                  — {r.hits[0].title} ({r.hits[0].score})
                </span>
              )}
            </div>
          ))}
          {results && results.length > 0 && <div style={{ opacity: 0.7 }}>{t("aichat.checkLegend")}</div>}
        </div>
      )}
    </>
  );
}
