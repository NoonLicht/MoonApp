import { useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Btn } from "@/components/ui";
import type { SheetCx, SheetPane } from "@/pages/sheet/types";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";

const TITLES: Record<SheetPane, string> = {
  pivotFields: "PivotTable Fields",
  formatChart: "Format Chart Area",
  comments: "Comments",
  selection: "Selection Pane",
  watch: "Watch Window",
  names: "Names",
  find: "Find and Replace",
};

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="wd-pane sh-pane">
      <div className="wd-pane-head">
        <span style={{ flex: 1 }}>{title}</span>
        <button type="button" className="wd-x-btn" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="wd-pane-body">{children}</div>
    </aside>
  );
}

interface FindHit {
  cell: string;
  sheet: string;
  value: string;
}

/** Найти и заменить: поиск по листу или книге, список найденного, замена. */
function FindPane({ cx, docs }: { cx: SheetCx; docs: SheetDocs }) {
  const [what, setWhat] = useState("");
  const [repl, setRepl] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [within, setWithin] = useState<"sheet" | "workbook">("sheet");
  const [lookIn, setLookIn] = useState<"formulas" | "values">("formulas");
  const [byCols, setByCols] = useState(false);
  const [hits, setHits] = useState<FindHit[] | null>(null);
  const [note, setNote] = useState("");
  const base = { what, matchCase, wholeCell: whole, lookIn, byColumns: byCols, within };
  const findAll = async (): Promise<void> => {
    const r = (await docs.run("edit.find", { ...base, all: true }, true)) as { results?: FindHit[]; count?: number } | undefined;
    setHits(r?.results ?? []);
    setNote(cx.tw("{n} cells found", { n: r?.count ?? 0 }));
  };
  const next = async (): Promise<void> => {
    const r = await docs.run("edit.find", base, true);
    if (r === undefined) setNote(cx.tw("Not found"));
    else {
      const cell = (r as { cell?: string }).cell;
      if (cell) await docs.run("selection.set", { range: cell }, true);
      setNote("");
    }
  };
  const replace = async (all: boolean): Promise<void> => {
    const r = (await docs.run("edit.replace", { ...base, with: repl, all }, true)) as { replaced?: number } | undefined;
    setNote(cx.tw("{n} replaced", { n: r?.replaced ?? 0 }));
  };
  return (
    <div className="sh-find">
      <label>
        <span>{cx.tw("Find what:")}</span>
        <input value={what} autoFocus onChange={(e) => setWhat(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void next()} />
      </label>
      <label>
        <span>{cx.tw("Replace with:")}</span>
        <input value={repl} onChange={(e) => setRepl(e.target.value)} />
      </label>
      <label className="wd-chk">
        <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
        <span>{cx.tw("Match case")}</span>
      </label>
      <label className="wd-chk">
        <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
        <span>{cx.tw("Match entire cell contents")}</span>
      </label>
      <label>
        <span>{cx.tw("Within:")}</span>
        <select value={within} onChange={(e) => setWithin(e.target.value as "sheet" | "workbook")}>
          <option value="sheet">{cx.tw("Sheet")}</option>
          <option value="workbook">{cx.tw("Workbook")}</option>
        </select>
      </label>
      <label>
        <span>{cx.tw("Look in:")}</span>
        <select value={lookIn} onChange={(e) => setLookIn(e.target.value as "formulas" | "values")}>
          <option value="formulas">{cx.tw("Formulas")}</option>
          <option value="values">{cx.tw("Values")}</option>
        </select>
      </label>
      <label className="wd-chk">
        <input type="checkbox" checked={byCols} onChange={(e) => setByCols(e.target.checked)} />
        <span>{cx.tw("Search by columns")}</span>
      </label>
      <div className="sh-find-btns">
        <Btn onClick={() => void next()}>{cx.tw("Find Next")}</Btn>
        <Btn onClick={() => void findAll()}>{cx.tw("Find All")}</Btn>
        <Btn onClick={() => void replace(false)}>{cx.tw("Replace")}</Btn>
        <Btn onClick={() => void replace(true)}>{cx.tw("Replace All")}</Btn>
      </div>
      {note ? <div className="wd-muted">{note}</div> : null}
      {hits ? (
        <div className="sh-find-list">
          {hits.map((h) => (
            <button
              key={`${h.sheet}!${h.cell}`}
              type="button"
              className="wd-nav-item"
              onClick={() => {
                void docs.run("edit.goTo", { reference: `'${h.sheet}'!${h.cell}` }, true);
              }}
            >
              <b>{h.cell}</b> <span className="wd-muted">{h.sheet}</span>
              <br />
              <span>{String(h.value).slice(0, 80)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Примечания и комментарии листа. */
function CommentsPane({ cx }: { cx: SheetCx }) {
  const list = cx.s.objects.comments;
  const [reply, setReply] = useState<Record<string, string>>({});
  return (
    <div className="sh-comments">
      <div className="sh-find-btns">
        <Btn onClick={() => cx.run("review.newComment", { text: "" })}>{cx.tw("New Comment")}</Btn>
        <Btn onClick={() => cx.run("review.newNote", { text: "" })}>{cx.tw("New Note")}</Btn>
      </div>
      {list.length === 0 ? <div className="wd-muted">{cx.tw("No comments on this sheet.")}</div> : null}
      {list.map((c) => (
        <div key={c.cell} className={`sh-comment${c.resolved ? " done" : ""}`}>
          <button type="button" className="wd-nav-item" onClick={() => cx.run("selection.set", { range: c.cell })}>
            <b>{c.cell}</b> · {c.author} {c.threaded ? "" : `(${cx.tw("Note")})`}
            <br />
            {c.text}
          </button>
          {c.replies.map(([a, t], i) => (
            <div key={i} className="sh-reply">
              <b>{a}</b>: {t}
            </div>
          ))}
          {c.threaded ? (
            <div className="sh-reply-box">
              <input
                value={reply[c.cell] ?? ""}
                placeholder={cx.tw("Reply")}
                onChange={(e) => setReply({ ...reply, [c.cell]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && reply[c.cell]) {
                    cx.run("review.replyComment", { cell: c.cell, text: reply[c.cell] });
                    setReply({ ...reply, [c.cell]: "" });
                  }
                }}
              />
              <Btn onClick={() => cx.run("review.resolveComment", { cell: c.cell, resolved: !c.resolved })}>
                {cx.tw(c.resolved ? "Reopen" : "Resolve")}
              </Btn>
            </div>
          ) : null}
          <Btn onClick={() => cx.run("review.deleteComment", { cell: c.cell })}>{cx.tw("Delete")}</Btn>
        </div>
      ))}
    </div>
  );
}

/** Область выделения: объекты листа в порядке наложения. */
function SelectionPane({ cx }: { cx: SheetCx }) {
  const o = cx.s.objects;
  const rows: { kind: string; id: number; label: string }[] = [
    ...o.charts.map((c) => ({ kind: "chart", id: c.id, label: c.title || `${cx.tw("Chart")} ${c.id}` })),
    ...o.images.map((c) => ({ kind: "image", id: c.id, label: c.alt || `${cx.tw("Picture")} ${c.id}` })),
    ...o.shapes.map((c) => ({ kind: "shape", id: c.id, label: c.text || `${c.kind} ${c.id}` })),
    ...o.slicers.map((c) => ({ kind: "slicer", id: c.id, label: c.caption || `${cx.tw("Slicer")} ${c.id}` })),
  ];
  return (
    <div>
      {rows.length === 0 ? <div className="wd-muted">{cx.tw("No objects on this sheet.")}</div> : null}
      {rows.map((r) => (
        <div key={`${r.kind}${r.id}`} className="wd-nav-item" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ flex: 1 }}>{r.label}</span>
          <Btn onClick={() => cx.run("arrange.bringForward", { kind: r.kind, id: r.id })}>↑</Btn>
          <Btn onClick={() => cx.run("arrange.sendBackward", { kind: r.kind, id: r.id })}>↓</Btn>
          <Btn onClick={() => cx.run("object.delete", { kind: r.kind, id: r.id })}>
            <X size={12} />
          </Btn>
        </div>
      ))}
    </div>
  );
}

export function PaneHost({
  name,
  cx,
  docs,
  onClose,
}: {
  name: SheetPane;
  cx: SheetCx;
  docs: SheetDocs;
  onClose: () => void;
}) {
  return (
    <Shell title={cx.tw(TITLES[name])} onClose={onClose}>
      {name === "find" ? <FindPane cx={cx} docs={docs} /> : null}
      {name === "comments" ? <CommentsPane cx={cx} /> : null}
      {name === "selection" ? <SelectionPane cx={cx} /> : null}
      {name === "pivotFields" ? <div className="wd-muted">{cx.tw("Select a cell in a PivotTable.")}</div> : null}
      {name === "formatChart" ? <div className="wd-muted">{cx.tw("Select a chart.")}</div> : null}
      {name === "watch" || name === "names" ? <div className="wd-muted">…</div> : null}
    </Shell>
  );
}
