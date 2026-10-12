import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, X } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type State = Awaited<ReturnType<typeof api.timeMachineState>>;
type Range = Awaited<ReturnType<typeof api.timeMachineRange>>;

const DAY = 86_400_000;
const toDate = (key: string): number => new Date(`${key}T00:00:00`).getTime();
const toKey = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * «Машина времени»: ползунок по дате показывает заметки, доски, задачи, траты и
 * запись дневника на выбранный день. Только просмотр; заметку можно
 * восстановить копией рядом с оригиналом.
 */
export default function TimeMachineToggle() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<Range | null>(null);
  const [day, setDay] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [msg, setMsg] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api
      .timeMachineRange()
      .then((r) => {
        if (!live) return;
        setRange(r);
        setDay(Math.round((toDate(r.to) - toDate(r.from)) / DAY));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);

  const dateKey = useMemo(() => (range ? toKey(toDate(range.from) + day * DAY) : ""), [range, day]);
  const total = range ? Math.round((toDate(range.to) - toDate(range.from)) / DAY) : 0;

  useEffect(() => {
    if (!open || !dateKey) return;
    const my = ++seq.current;
    const tm = setTimeout(() => {
      api
        .timeMachineState(dateKey)
        .then((s) => {
          if (my === seq.current) setState(s);
        })
        .catch(() => undefined);
    }, 200);
    return () => clearTimeout(tm);
  }, [open, dateKey]);

  const notes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = state?.notes ?? [];
    return q ? all.filter((n) => n.title.toLowerCase().includes(q)) : all;
  }, [state, filter]);

  const show = async (p: string) => {
    if (!state?.snapshot) return;
    setMsg("");
    try {
      const r = await api.timeMachineFile(state.snapshot.oid, p);
      setPreview({ path: p, text: r.text });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const restore = async () => {
    if (!state?.snapshot || !preview) return;
    try {
      const r = await api.timeMachineRestore(state.snapshot.oid, preview.path, dateKey);
      setMsg(t("timeMachine.restored", { path: r.path }));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const snapshotNow = async () => {
    try {
      const r = await api.timeMachineSnapshot();
      setMsg(r.committed ? t("timeMachine.snapshotDone") : t("timeMachine.snapshotSame"));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <>
      <button
        className="task-mgr-toggle no-drag"
        onClick={() => setOpen((v) => !v)}
        title={t("timeMachine.title")}
        aria-label={t("timeMachine.title")}
      >
        <History size={15} />
      </button>
      {open &&
        /* Тулбар с backdrop-filter становится контейнером для position:fixed —
           без портала панель «схлопывалась» в полоску внутри самого тулбара. */
        createPortal(
          <div className="tm-panel no-drag" role="dialog" aria-label={t("timeMachine.title")}>
            <div className="tm-head">
              <b>{t("timeMachine.title")}</b>
              <span className="muted-sm">{t("timeMachine.readOnly")}</span>
              <button
                className="ghost-x"
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
              >
                <X size={14} />
              </button>
            </div>
            <div className="tm-slider">
              <input
                type="range"
                min={0}
                max={Math.max(total, 0)}
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                disabled={!range || total === 0}
                aria-label={t("timeMachine.slider")}
              />
              <div className="tm-date">
                <b>{dateKey}</b>
                <span className="muted-sm">
                  {total - day === 0
                    ? t("timeMachine.today")
                    : t("timeMachine.daysAgo", { n: total - day })}
                </span>
                <button className="btn" onClick={() => void snapshotNow()}>
                  {t("timeMachine.snapshot")}
                </button>
              </div>
            </div>
            {msg && <div className="muted-sm tm-msg">{msg}</div>}
            {!state ? (
              <div className="tm-body muted-sm">…</div>
            ) : (
              <div className="tm-body">
                <section>
                  <h4>
                    {t("timeMachine.notes")} · {state.notesTotal}
                  </h4>
                  {!state.snapshot && <p className="muted-sm">{t("timeMachine.noSnapshot")}</p>}
                  {state.snapshot && (
                    <p className="muted-sm">
                      {t("timeMachine.snapshotAt", {
                        at: new Date(state.snapshot.at).toLocaleString(),
                      })}
                    </p>
                  )}
                  {state.snapshot && (
                    <input
                      className="input"
                      placeholder={t("timeMachine.filter")}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  )}
                  <div className="tm-list">
                    {notes.slice(0, 80).map((n) => (
                      <button key={n.path} className="ghost-item" onClick={() => void show(n.path)}>
                        <span className="ghost-item-title">{n.title}</span>
                        <span className="muted-sm">{n.path}</span>
                      </button>
                    ))}
                  </div>
                  {state.boards.length > 0 && (
                    <p className="muted-sm">
                      {t("timeMachine.boards")}: {state.boards.map((b) => b.title).join(", ")}
                    </p>
                  )}
                </section>
                <section>
                  <h4>{t("timeMachine.tasks")}</h4>
                  <p>
                    {t("timeMachine.tasksOpen", { n: state.tasks.open })} ·{" "}
                    {t("timeMachine.tasksDone", { n: state.tasks.done })}
                  </p>
                  <div className="tm-list">
                    {state.tasks.items
                      .filter((x) => x.status === "open")
                      .slice(0, 12)
                      .map((x) => (
                        <div key={x.id} className="muted-sm">
                          • {x.title}
                        </div>
                      ))}
                  </div>
                  <p className="muted-sm">{t("timeMachine.tasksNote")}</p>
                </section>
                <section>
                  <h4>{t("timeMachine.budget")}</h4>
                  <p>
                    {t("timeMachine.balance")}: <b>{money(state.budget.balance)}</b> ·{" "}
                    {t("timeMachine.income")}: {money(state.budget.income)} ·{" "}
                    {t("timeMachine.expense")}: {money(state.budget.expense)}
                  </p>
                  <div className="tm-list">
                    {state.budget.monthByCategory.slice(0, 8).map((c) => (
                      <div key={c.category} className="muted-sm">
                        {c.category}: {money(c.amount)}
                      </div>
                    ))}
                  </div>
                </section>
                {state.diary && (
                  <section>
                    <h4>{t("timeMachine.diary")}</h4>
                    <pre className="tm-pre">{state.diary.content}</pre>
                  </section>
                )}
              </div>
            )}
            {preview && (
              <div className="tm-preview">
                <div className="tm-head">
                  <b>{preview.path}</b>
                  <button className="btn" onClick={() => void restore()}>
                    {t("timeMachine.restore")}
                  </button>
                  <button
                    className="ghost-x"
                    onClick={() => setPreview(null)}
                    aria-label={t("common.close")}
                  >
                    <X size={14} />
                  </button>
                </div>
                <pre className="tm-pre">{preview.text.slice(0, 20000)}</pre>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
