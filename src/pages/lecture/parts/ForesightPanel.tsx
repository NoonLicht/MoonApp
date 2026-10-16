import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, FilePlus2, Lightbulb, Send, Sparkles, X } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { ForesightCard } from "@/api/apiTypesLecture";
import { fmtTs } from "@/pages/lecture/parts/LectureRecorderHelpers";
import { copyToClipboard } from "@/components/ContextMenu";

const POLL_MS = 4000;

/**
 * Foresight: подсказки по ходу встречи.
 *  • вопросы, прозвучавшие в расшифровке, ищутся в личной базе знаний — ответ приходит карточкой;
 *  • «Раскрыть заметки» превращает короткие пометки в связный текст по расшифровке.
 * Всё считается локально (EmbeddingGemma для поиска, локальная модель для текста).
 */
export default function ForesightPanel({
  sessionId,
  live,
  notes,
  onInsertNotes,
}: {
  sessionId: number | null;
  live: boolean;
  notes: string;
  onInsertNotes: (text: string) => void;
}) {
  const { t } = useI18n();
  const [cards, setCards] = useState<ForesightCard[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [expanding, setExpanding] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Карточки обновляются опросом: пока запись идёт — со сканированием новых вопросов,
  // иначе только подтягиваем ответы, которые ещё считаются.
  const pending = cards.some((c) => c.status === "searching");
  const tick = useCallback(async (): Promise<void> => {
    if (sessionId == null) return;
    try {
      const r = live
        ? (await api.foresightScan(sessionId)).cards
        : (await api.foresightCards(sessionId)).cards;
      if (alive.current) setCards(r.slice());
    } catch (e) {
      if (alive.current) setError(String((e as Error).message));
    }
  }, [sessionId, live]);

  useEffect(() => {
    if (sessionId == null) {
      setCards([]);
      return;
    }
    void tick();
  }, [sessionId, tick]);

  useEffect(() => {
    if (sessionId == null || !(live || pending)) return;
    const timer = setInterval(() => void tick(), POLL_MS / (pending ? 2 : 1));
    return () => clearInterval(timer);
  }, [sessionId, live, pending, tick]);

  const ask = async (): Promise<void> => {
    const q = question.trim();
    if (!q || sessionId == null) return;
    setError("");
    try {
      const r = await api.foresightAsk(sessionId, q);
      setCards(r.cards.slice());
      setQuestion("");
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const dismiss = async (id: string): Promise<void> => {
    if (sessionId == null) return;
    setCards((c) => c.filter((x) => x.id !== id));
    await api.foresightDismiss(sessionId, id).catch(() => undefined);
  };

  const expand = async (): Promise<void> => {
    if (sessionId == null) return;
    setError("");
    setExpanding(true);
    try {
      setExpanded((await api.foresightExpand(sessionId, notes)).markdown);
    } catch (e) {
      const m = String((e as Error).message);
      setError(m === "empty_notes" ? t("lecture.foresight.emptyNotes") : m);
    } finally {
      setExpanding(false);
    }
  };

  const sorted = cards.slice().sort((a, b) => b.atMs - a.atMs);

  return (
    <div className="lec-foresight">
      <div className="lec-fs-col">
        <div className="lec-fs-head">
          <Lightbulb size={15} /> <strong>{t("lecture.foresight.title")}</strong>
          <span className="lec-dim">{t("lecture.foresight.sub")}</span>
        </div>
        <div className="lec-fs-ask">
          <input
            value={question}
            placeholder={t("lecture.foresight.askPlaceholder")}
            disabled={sessionId == null}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void ask()}
          />
          <Btn
            icon={Send}
            disabled={sessionId == null || !question.trim()}
            onClick={() => void ask()}
          >
            {t("lecture.foresight.ask")}
          </Btn>
        </div>
        {sessionId == null && <div className="lec-dim">{t("lecture.foresight.noSession")}</div>}
        {sessionId != null && sorted.length === 0 && (
          <div className="lec-dim">{t("lecture.foresight.empty")}</div>
        )}
        <div className="lec-fs-cards">
          {sorted.map((c) => (
            <div key={c.id} className={`lec-fs-card st-${c.status}`}>
              <div className="lec-fs-q">
                {!c.manual && <span className="lec-ts">{fmtTs(c.atMs)}</span>}
                <span>{c.question}</span>
                <button
                  className="icon-btn"
                  aria-label={t("common.delete")}
                  title={t("common.delete")}
                  onClick={() => void dismiss(c.id)}
                >
                  <X size={13} />
                </button>
              </div>
              {c.status === "searching" && (
                <div className="lec-dim">{t("lecture.foresight.searching")}</div>
              )}
              {c.status === "none" && <div className="lec-dim">{t("lecture.foresight.none")}</div>}
              {c.status === "error" && (
                <div className="lec-error">{t("lecture.foresight.error")}</div>
              )}
              {c.answer && <div className="lec-fs-a">{c.answer}</div>}
              {c.sources.length > 0 && (
                <div className="lec-fs-src">
                  {c.sources.map((s) => (
                    <span key={`${s.source}:${s.ref}`} className="lec-fs-chip" title={s.snippet}>
                      {s.title || s.ref}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="lec-fs-col">
        <div className="lec-fs-head">
          <Sparkles size={15} /> <strong>{t("lecture.foresight.expandTitle")}</strong>
        </div>
        <div className="lec-dim">{t("lecture.foresight.expandHint")}</div>
        <div className="lec-fs-ask">
          <Btn
            variant="primary"
            icon={Sparkles}
            disabled={sessionId == null || expanding || !notes.trim()}
            onClick={() => void expand()}
          >
            {expanding ? t("lecture.foresight.expanding") : t("lecture.foresight.expand")}
          </Btn>
        </div>
        {expanded && (
          <>
            <textarea
              className="lec-fs-out"
              value={expanded}
              onChange={(e) => setExpanded(e.target.value)}
              rows={10}
            />
            <div className="lec-fs-ask">
              <Btn icon={FilePlus2} onClick={() => onInsertNotes(expanded)}>
                {t("lecture.foresight.insert")}
              </Btn>
              <Btn icon={Copy} onClick={() => copyToClipboard(expanded)}>
                {t("ctx.copy")}
              </Btn>
            </div>
          </>
        )}
      </div>
      {error && <div className="lec-error lec-fs-wide">{error}</div>}
    </div>
  );
}
