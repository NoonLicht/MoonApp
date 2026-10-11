import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookText, ChevronLeft, ChevronRight, FileText, Flame, Sparkles } from "lucide-react";
import { Btn, Glass, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { DiaryListItem, DiarySavedSummary } from "@/api/apiDiary";
import MarkdownRenderer from "@/pages/myspace/parts/MarkdownRenderer";

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const LANG_NAME: Record<string, string> = {
  ru: "Russian",
  en: "English",
  es: "Spanish",
  fr: "French",
  zh: "Chinese",
  ar: "Arabic",
};

/** Ячейки месяца (с понедельника); null — пустые клетки до первого числа. */
function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(ymd(new Date(year, month, d)));
  return cells;
}

/**
 * Дневник: запись на каждый день (Markdown-файл), календарь с отметками,
 * шаблон записи и итог недели по дневнику, задачам, заметкам и лекциям.
 */
type ShownWeek = {
  markdown: string;
  ai: boolean;
  model?: string;
  aiError?: string;
  /** Итог лежит на сервере и откроется при выборе любого дня этой недели. */
  saved: boolean;
};

export default function DiaryPage() {
  const { t, lang } = useI18n();
  const today = ymd(new Date());
  const [date, setDate] = useState(today);
  const [cursor, setCursor] = useState(() => new Date().getFullYear() * 12 + new Date().getMonth());
  const [items, setItems] = useState<DiaryListItem[]>([]);
  const [streak, setStreak] = useState(0);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [template, setTemplate] = useState<string | null>(null);
  const [editingTpl, setEditingTpl] = useState(false);
  const [week, setWeek] = useState<ShownWeek | null>(null);
  const [weekEdit, setWeekEdit] = useState(false);
  /** Итог, прикреплённый к этому дню: если есть — день открывается им, а не полем ввода. */
  const [daySum, setDaySum] = useState<DiarySavedSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [weekDraft, setWeekDraft] = useState("");
  const [weekBusy, setWeekBusy] = useState(false);
  const [error, setError] = useState("");
  const [inserted, setInserted] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<number | null>(null);
  const current = useRef({ date, text });
  current.current = { date, text };

  const year = Math.floor(cursor / 12);
  const month = cursor % 12;
  const marks = useMemo(() => new Map(items.map((i) => [i.date, i])), [items]);
  const defaultTemplate = t("diary.defaultTemplate");

  const refresh = useCallback(() => {
    api
      .diaryEntries()
      .then((r) => {
        setItems(r.items);
        setStreak(r.streak);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    api.diaryTemplate().then((r) => setTemplate(r.template)).catch(() => undefined);
  }, []);

  const flushSave = useCallback(async () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const { date: d, text: txt } = current.current;
    setSaved("saving");
    try {
      await api.diarySave(d, txt);
      setSaved("saved");
      refresh();
    } catch (e) {
      setError((e as Error).message);
      setSaved("idle");
    }
  }, [refresh]);

  // Смена дня: сначала дописываем несохранённое, затем грузим новый день.
  const openDay = useCallback(
    async (d: string) => {
      if (timer.current) await flushSave();
      setDate(d);
      setLoaded(false);
      setWeek(null);
      setWeekEdit(false);
      setInserted(false);
      setEditing(false);
      setDaySum(null);
      api
        .diaryDaySummary(d)
        .then((r) => {
          if (r.exists && current.current.date === d) setDaySum(r);
        })
        .catch(() => undefined);
      // Итог недели этого дня, если он уже сохранён, показываем сразу.
      api
        .diarySummary(d)
        .then((r) => {
          if (r.exists && current.current.date === d) setWeek({ ...r, saved: true });
        })
        .catch(() => undefined);
      try {
        const e = await api.diaryGet(d);
        setText(e.content);
        setSaved("idle");
      } catch (err) {
        setError((err as Error).message);
      }
      setLoaded(true);
    },
    [flushSave],
  );

  useEffect(() => {
    void openDay(today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Закрытие страницы/выгрузка: несохранённый текст не теряем.
  useEffect(
    () => () => {
      if (timer.current) void flushSave();
    },
    [flushSave],
  );

  const onChange = (v: string) => {
    setText(v);
    setSaved("idle");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushSave(), 800);
  };

  const applyTemplate = () => {
    const tpl = template ?? defaultTemplate;
    onChange(text.trim() ? `${text.replace(/\s+$/, "")}\n\n${tpl}` : tpl);
  };

  const summarize = async () => {
    setWeekBusy(true);
    setError("");
    try {
      await flushSave();
      setInserted(false);
      setWeekEdit(false);
      const r = await api.diaryWeekSummary(date, LANG_NAME[lang] || "English", {
          title: t("diary.week.title"),
          entries: t("diary.week.entries"),
          tasksDone: t("diary.week.tasksDone"),
          tasksCreated: t("diary.week.tasksCreated"),
          notes: t("diary.week.notes"),
          lectures: t("diary.week.lectures"),
          nothing: t("diary.week.nothing"),
        });
      // Ответ ИИ сервер уже сохранил; запасная сводка без ИИ не сохраняется.
      setWeek({ ...r, saved: r.ai });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWeekBusy(false);
    }
  };

  const startWeekEdit = () => {
    if (!week) return;
    setWeekDraft(week.markdown);
    setWeekEdit(true);
  };
  const saveWeekEdit = async () => {
    try {
      const r = await api.diarySaveSummary(date, weekDraft);
      setWeek(r.exists ? { ...r, saved: true } : null);
      setWeekEdit(false);
      setInserted(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Прикрепляет итог к этому дню: запись-шаблон остаётся как есть, день открывается итогом. */
  const insertSummary = async () => {
    if (!week) return;
    try {
      await flushSave();
      const r = await api.diarySaveDaySummary(date, week.markdown, {
        ai: week.ai,
        model: week.model,
      });
      setDaySum(r.exists ? r : null);
      setEditing(false);
      setInserted(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((n) =>
    new Date(2024, 0, n === 0 ? 7 : n).toLocaleDateString(lang, { weekday: "short" }),
  );
  const monthTitle = new Date(year, month, 1).toLocaleDateString(lang, {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="page diary-page">
      <SectionHead
        eyebrow={t("diary.eyebrow")}
        title={t("diary.title")}
        action={
          streak > 0 ? (
            <span className="diary-streak" title={t("diary.streakHint")}>
              <Flame size={15} /> {t("diary.streak", { n: streak })}
            </span>
          ) : undefined
        }
      />
      {error && <div className="muted-sm" style={{ color: "var(--coral)" }}>{error}</div>}

      <div className="diary-layout">
        <Glass className="diary-side">
          <div className="diary-cal-head">
            <button type="button" className="icon-btn" onClick={() => setCursor((c) => c - 1)}>
              <ChevronLeft size={15} />
            </button>
            <b style={{ flex: 1, textAlign: "center", textTransform: "capitalize" }}>{monthTitle}</b>
            <button type="button" className="icon-btn" onClick={() => setCursor((c) => c + 1)}>
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="diary-cal">
            {weekdays.map((w, i) => (
              <span key={i} className="muted-sm diary-wd">
                {w}
              </span>
            ))}
            {monthCells(year, month).map((d, i) =>
              d ? (
                <button
                  key={d}
                  type="button"
                  className={`diary-day${d === date ? " is-active" : ""}${d === today ? " is-today" : ""}${marks.has(d) ? " has-entry" : ""}`}
                  title={marks.get(d)?.preview}
                  onClick={() => void openDay(d)}
                >
                  {Number(d.slice(8))}
                </button>
              ) : (
                <span key={`e${i}`} />
              ),
            )}
          </div>
          <Btn
            onClick={() => {
              setCursor(new Date().getFullYear() * 12 + new Date().getMonth());
              void openDay(today);
            }}
          >
            {t("diary.today")}
          </Btn>

          <div className="diary-recent">
            {items.slice(0, 8).map((i) => (
              <button key={i.date} type="button" className="diary-recent-row" onClick={() => void openDay(i.date)}>
                <b>{i.date}</b>
                <span className="muted-sm">{i.preview || `${i.words}`}</span>
              </button>
            ))}
          </div>
        </Glass>

        <div className="diary-main">
          {daySum && !editing ? (
            <Glass className="diary-editor diary-final">
              <div className="diary-editor-head">
                <BookText size={15} />
                <b style={{ flex: 1 }}>{date}</b>
                <Btn
                  onClick={() => {
                    setWeek(null);
                    setInserted(false);
                    setEditing(true);
                  }}
                >
                  {t("diary.week.edit")}
                </Btn>
              </div>
              <MarkdownRenderer content={daySum.markdown} />
            </Glass>
          ) : (
          <>
          <Glass className="diary-editor">
            <div className="diary-editor-head">
              <BookText size={15} />
              <b style={{ flex: 1 }}>{date}</b>
              <span className="muted-sm">
                {saved === "saving" ? t("diary.saving") : saved === "saved" ? t("diary.saved") : ""}
              </span>
              <Btn icon={FileText} onClick={applyTemplate}>
                {t("diary.applyTemplate")}
              </Btn>
              <Btn onClick={() => setEditingTpl((v) => !v)}>{t("diary.editTemplate")}</Btn>
              {daySum && <Btn onClick={() => setEditing(false)}>{t("diary.week.done")}</Btn>}
            </div>
            {editingTpl ? (
              <>
                <textarea
                  className="diary-text"
                  value={template ?? defaultTemplate}
                  onChange={(e) => setTemplate(e.target.value)}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn
                    variant="primary"
                    onClick={() =>
                      void api
                        .diarySaveTemplate(template ?? defaultTemplate)
                        .then((r) => {
                          setTemplate(r.template);
                          setEditingTpl(false);
                        })
                    }
                  >
                    {t("budget.save")}
                  </Btn>
                  <Btn
                    onClick={() =>
                      void api.diarySaveTemplate("").then(() => {
                        setTemplate(null);
                        setEditingTpl(false);
                      })
                    }
                  >
                    {t("diary.resetTemplate")}
                  </Btn>
                </div>
              </>
            ) : (
              <textarea
                ref={textRef}
                className="diary-text"
                disabled={!loaded}
                placeholder={t("diary.placeholder")}
                value={text}
                onChange={(e) => onChange(e.target.value)}
              />
            )}
          </Glass>

          <SectionHead
            eyebrow={t("diary.week.eyebrow")}
            title={t("diary.week.heading")}
            action={
              <Btn icon={Sparkles} variant="primary" disabled={weekBusy} onClick={() => void summarize()}>
                {weekBusy ? t("diary.week.busy") : t("diary.week.run")}
              </Btn>
            }
          />
          {week && (
            <Glass className="diary-week">
              {weekEdit ? (
                <textarea
                  className="diary-text"
                  value={weekDraft}
                  onChange={(e) => setWeekDraft(e.target.value)}
                />
              ) : (
                <MarkdownRenderer content={week.markdown} />
              )}
              <div className="muted-sm">
                {week.ai
                  ? t("diary.week.byAi", { model: week.model || "" })
                  : week.aiError === "no_data"
                    ? t("diary.week.noData")
                    : t("diary.week.noAi")}
                {week.saved ? ` ${t("diary.week.savedNote")}` : ""}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {weekEdit ? (
                  <>
                    <Btn variant="primary" onClick={() => void saveWeekEdit()}>
                      {t("budget.save")}
                    </Btn>
                    <Btn onClick={() => setWeekEdit(false)}>{t("diary.week.cancel")}</Btn>
                  </>
                ) : (
                  <>
                    <Btn onClick={startWeekEdit}>{t("diary.week.edit")}</Btn>
                <Btn onClick={() => void insertSummary()} disabled={inserted}>
                  {inserted ? t("diary.week.inserted") : t("diary.week.insert")}
                </Btn>
                  </>
                )}
              </div>
            </Glass>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}
