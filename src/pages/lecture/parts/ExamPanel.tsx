import { useCallback, useEffect, useState } from "react";
import { GraduationCap } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Deck = Awaited<ReturnType<typeof api.examDeck>>;
type Due = Awaited<ReturnType<typeof api.examDue>>["items"];
type Stats = Awaited<ReturnType<typeof api.examStats>>;
type Result = Awaited<ReturnType<typeof api.examSubmitQuiz>>;

const stamp = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/**
 * «Лекция → экзамен»: карточки и тест по записи, повторение по FSRS и
 * расписание повторений. Сворачивается; данные грузятся при раскрытии.
 */
export default function ExamPanel({ sessionId }: { sessionId: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [due, setDue] = useState<Due>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [withConspectus, setWithConspectus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [reveal, setReveal] = useState(false);
  const [answers, setAnswers] = useState<number[]>([]);
  const [result, setResult] = useState<Result | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, du, st] = await Promise.all([
        api.examDeck(sessionId),
        api.examDue(sessionId),
        api.examStats(),
      ]);
      setDeck(d);
      setDue(du.items);
      setStats(st);
      setAnswers(new Array(d.quiz.length).fill(-1));
      setResult(d.lastResult ?? null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const build = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.examBuild(sessionId, withConspectus);
      setMsg(t("lecture.exam.built", { cards: r.cards, quiz: r.quiz }));
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const grade = async (g: 1 | 2 | 3 | 4) => {
    const c = due[0];
    if (!c) return;
    setReveal(false);
    try {
      await api.examReview(c.id, g);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const submit = async () => {
    try {
      setResult(await api.examSubmitQuiz(sessionId, answers));
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const days = (n: number) => (n === 0 ? t("lecture.exam.minutes") : t("lecture.exam.days", { n }));
  const card = due[0];

  return (
    <div className="lec-panel">
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        <GraduationCap size={14} /> {t("lecture.exam.title")}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Btn disabled={busy} onClick={() => void build()}>
              {busy ? t("lecture.exam.building") : t("lecture.exam.build")}
            </Btn>
            <label className="muted-sm">
              <input
                type="checkbox"
                checked={withConspectus}
                onChange={(e) => setWithConspectus(e.target.checked)}
              />{" "}
              {t("lecture.exam.withConspectus")}
            </label>
          </div>
          {msg && <div className="muted-sm">{msg}</div>}

          {stats && (
            <div className="muted-sm">
              {t("lecture.exam.stats", {
                total: stats.total,
                due: stats.due,
                fresh: stats.fresh,
              })}
              {stats.schedule.length > 0 && (
                <div>
                  {t("lecture.exam.schedule")}:{" "}
                  {stats.schedule.map((s) => `${s.date.slice(5)} ×${s.count}`).join(" · ")}
                </div>
              )}
            </div>
          )}

          {card ? (
            <div className="lec-exam-card">
              <div className="muted-sm">
                {card.topic} {card.ms > 0 && `· ${stamp(card.ms)}`}
              </div>
              <div style={{ fontWeight: 600, margin: "4px 0" }}>{card.q}</div>
              {!reveal ? (
                <Btn onClick={() => setReveal(true)}>{t("lecture.exam.show")}</Btn>
              ) : (
                <>
                  <div style={{ margin: "4px 0 8px", userSelect: "text" }}>{card.a}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {([1, 2, 3, 4] as const).map((g) => (
                      <Btn key={g} variant={g === 3 ? undefined : "ghost"} onClick={() => void grade(g)}>
                        {t(`lecture.exam.grade${g}`)} · {days(card.intervals[g])}
                      </Btn>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            deck &&
            deck.cards.length > 0 && <div className="muted-sm">{t("lecture.exam.noDue")}</div>
          )}

          {deck && deck.quiz.length > 0 && (
            <div>
              <b>{t("lecture.exam.quiz")}</b>
              {deck.quiz.map((q, i) => (
                <div key={i} style={{ margin: "8px 0" }}>
                  <div>
                    {i + 1}. {q.q}
                  </div>
                  {q.options.map((o, j) => (
                    <label key={j} style={{ display: "block", marginLeft: 12 }}>
                      <input
                        type="radio"
                        name={`exam-${sessionId}-${i}`}
                        checked={answers[i] === j}
                        onChange={() => setAnswers((a) => a.map((v, k) => (k === i ? j : v)))}
                      />{" "}
                      {o}
                      {result && j === q.answer && " ✓"}
                    </label>
                  ))}
                </div>
              ))}
              <Btn onClick={() => void submit()} disabled={answers.some((a) => a < 0)}>
                {t("lecture.exam.check")}
              </Btn>
              {result && (
                <div style={{ marginTop: 8 }}>
                  <b>{t("lecture.exam.score", { correct: result.correct, total: result.total, percent: result.percent })}</b>
                  {result.weak.length > 0 && (
                    <div className="muted-sm">
                      {t("lecture.exam.weak")}:{" "}
                      {result.weak
                        .map((w) => `${w.topic} (${w.wrong}/${w.of})${w.ms > 0 ? ` @${stamp(w.ms)}` : ""}`)
                        .join("; ")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
