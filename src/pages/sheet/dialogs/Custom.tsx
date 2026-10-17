import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Btn } from "@/components/ui";
import { Shell } from "@/pages/word/dialogs/form";
import type { SheetCx } from "@/pages/sheet/types";

type Row = Record<string, unknown>;
interface Props {
  cx: SheetCx;
  onClose: () => void;
}

const cell = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** Данные команды ядра: загрузка при открытии и повторная загрузка после действий. */
function useCommand<T>(cx: SheetCx, command: string, params: Record<string, unknown> = {}): [T | undefined, string, () => void] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  const key = JSON.stringify(params);
  useEffect(() => {
    let alive = true;
    cx.call(command, JSON.parse(key) as Record<string, unknown>).then(
      (r) => {
        if (alive) {
          setData(r as T);
          setErr("");
        }
      },
      (e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, command, key]);
  return [data, err, () => setN((x) => x + 1)];
}

/** Таблица из массива объектов (колонки — по ключам первой строки). */
function Grid({ rows, cols, pick, sel, empty, cx }: { rows: Row[]; cols?: string[]; pick?: (i: number) => void; sel?: number; empty: string; cx: SheetCx }) {
  if (!rows.length) return <div className="sh-dlg-empty">{cx.tw(empty)}</div>;
  const keys = cols ?? Object.keys(rows[0]);
  return (
    <div className="sh-dlg-grid">
      <table>
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k}>{cx.tw(k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i === sel ? "on" : ""} onClick={() => pick?.(i)}>
              {keys.map((k) => (
                <td key={k}>{cell(r[k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Frame({ cx, title, onClose, children, actions, size }: { cx: SheetCx; title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; size?: "normal" | "wide" | "xwide" }) {
  return (
    <Shell
      title={cx.tw(title)}
      onClose={onClose}
      size={size ?? "wide"}
      foot={
        <>
          {actions}
          <span style={{ flex: 1 }} />
          <Btn variant="primary" onClick={onClose}>
            {cx.tw("Close")}
          </Btn>
        </>
      }
    >
      <div className="sh-dlg-col">{children}</div>
    </Shell>
  );
}

const asRows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);

/** Не удаётся ли ядру выполнить: показываем сообщение, диалог остаётся. */
function useDo(cx: SheetCx, reload: () => void) {
  return useCallback(
    (command: string, params: Record<string, unknown> = {}, done?: () => void) => {
      void cx.call(command, params).then(() => {
        reload();
        done?.();
      });
    },
    [cx, reload],
  );
}

export function NameManager({ cx, onClose }: Props) {
  const [data, , reload] = useCommand<Row[]>(cx, "formulas.nameManager");
  const rows = asRows(data);
  const [sel, setSel] = useState(-1);
  const act = useDo(cx, reload);
  const cur = rows[sel];
  return (
    <Frame
      cx={cx}
      title="Name Manager"
      onClose={onClose}
      actions={
        <>
          <Btn onClick={() => (onClose(), cx.dialog("defineName"))}>{cx.tw("New…")}</Btn>
          <Btn disabled={!cur} onClick={() => cur && (onClose(), cx.dialog("defineName", { name: cur.name, scope: cur.scope, refersTo: cur.refersTo, comment: cur.comment ?? "", oldName: cur.name, oldScope: cur.scope }))}>
            {cx.tw("Edit…")}
          </Btn>
          <Btn disabled={!cur} onClick={() => cur && act("formulas.deleteName", { name: cur.name, scope: cur.scope })}>
            {cx.tw("Delete")}
          </Btn>
        </>
      }
    >
      <Grid cx={cx} rows={rows} cols={["name", "value", "refersTo", "scope"]} sel={sel} pick={setSel} empty="No names defined yet" />
    </Frame>
  );
}

export function ManageRules({ cx, onClose }: Props) {
  const [data, , reload] = useCommand<{ rules?: Row[] }>(cx, "home.manageRules");
  const rows = data?.rules ?? [];
  const [sel, setSel] = useState(-1);
  const act = useDo(cx, reload);
  return (
    <Frame
      cx={cx}
      title="Conditional Formatting Rules Manager"
      onClose={onClose}
      actions={
        <>
          <Btn onClick={() => (onClose(), cx.dialog("newRule"))}>{cx.tw("New Rule…")}</Btn>
          <Btn disabled={sel < 0} onClick={() => act("home.manageRules", { delete: sel }, () => setSel(-1))}>
            {cx.tw("Delete Rule")}
          </Btn>
          <Btn disabled={sel <= 0} onClick={() => act("home.manageRules", { moveUp: sel }, () => setSel(sel - 1))}>
            {cx.tw("Move Up")}
          </Btn>
          <Btn disabled={sel < 0 || sel >= rows.length - 1} onClick={() => act("home.manageRules", { moveDown: sel }, () => setSel(sel + 1))}>
            {cx.tw("Move Down")}
          </Btn>
        </>
      }
    >
      <Grid cx={cx} rows={rows} sel={sel} pick={setSel} empty="No rules in this worksheet" />
    </Frame>
  );
}

export function ScenarioManager({ cx, onClose }: Props) {
  const [data, , reload] = useCommand<{ scenarios?: Row[] }>(cx, "data.scenarioManager");
  const rows = data?.scenarios ?? [];
  const [sel, setSel] = useState(-1);
  const [f, setF] = useState({ name: "", changing: "", comment: "" });
  const act = useDo(cx, reload);
  const cur = rows[sel];
  return (
    <Frame
      cx={cx}
      title="Scenario Manager"
      onClose={onClose}
      actions={
        <>
          <Btn disabled={!cur} onClick={() => cur && act("data.scenarioShow", { name: cur.name })}>
            {cx.tw("Show")}
          </Btn>
          <Btn disabled={!cur} onClick={() => cur && act("data.scenarioDelete", { name: cur.name })}>
            {cx.tw("Delete")}
          </Btn>
          <Btn onClick={() => act("data.scenarioSummary", {})}>{cx.tw("Summary…")}</Btn>
        </>
      }
    >
      <Grid cx={cx} rows={rows} cols={["name", "changing", "values", "comment"]} sel={sel} pick={setSel} empty="No scenarios defined" />
      <div className="sh-dlg-form">
        <label>
          <span>{cx.tw("Scenario name:")}</span>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label>
          <span>{cx.tw("Changing cells:")}</span>
          <input value={f.changing} onChange={(e) => setF({ ...f, changing: e.target.value })} />
        </label>
        <label>
          <span>{cx.tw("Comment:")}</span>
          <input value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </label>
        <Btn disabled={!f.name || !f.changing} onClick={() => act("data.scenarioAdd", { name: f.name, changing: f.changing, comment: f.comment, replace: true }, () => setF({ name: "", changing: "", comment: "" }))}>
          {cx.tw("Add")}
        </Btn>
      </div>
    </Frame>
  );
}

export function Scripts({ cx, onClose }: Props) {
  const [data, , reload] = useCommand<Row[] | Record<string, unknown>>(cx, "automate.allScripts");
  const rows = useMemo(() => (Array.isArray(data) ? data : asRows((data as { scripts?: unknown } | undefined)?.scripts)), [data]);
  const [sel, setSel] = useState(-1);
  const act = useDo(cx, reload);
  const name = rows[sel] ? cell(rows[sel].name) : "";
  return (
    <Frame
      cx={cx}
      title="Scripts"
      onClose={onClose}
      actions={
        <>
          <Btn disabled={!name} onClick={() => act("automate.runScript", { name }, onClose)}>
            {cx.tw("Run")}
          </Btn>
          <Btn disabled={!name} onClick={() => act("automate.deleteScript", { name })}>
            {cx.tw("Delete")}
          </Btn>
        </>
      }
    >
      <Grid cx={cx} rows={rows} cols={rows[0] && "name" in rows[0] ? ["name", "commands"] : undefined} sel={sel} pick={setSel} empty="No scripts yet" />
    </Frame>
  );
}

export function NameScript({ cx, onClose, stop }: Props & { stop?: boolean }) {
  const [name, setName] = useState("");
  const [cmds, setCmds] = useState("");
  const go = (): void => {
    if (stop) cx.run("automate.recordActions", { stop: true, name });
    else {
      let commands: unknown[];
      try {
        commands = cmds.trim() ? (JSON.parse(cmds) as unknown[]) : [];
      } catch {
        cx.ui.status(cx.tw("Commands must be a JSON array of {command, params}."));
        return;
      }
      cx.run("automate.newScript", { name, commands });
    }
    onClose();
  };
  return (
    <Shell
      title={cx.tw(stop ? "Stop Recording" : "New Script")}
      onClose={onClose}
      foot={
        <>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn variant="primary" disabled={!name.trim()} onClick={go}>
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div className="sh-dlg-form">
        <label>
          <span>{cx.tw("Script name:")}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {stop ? null : (
          <label>
            <span>{cx.tw("Commands (JSON):")}</span>
            <textarea rows={6} value={cmds} onChange={(e) => setCmds(e.target.value)} placeholder='[{"command":"home.bold"}]' />
          </label>
        )}
      </div>
    </Shell>
  );
}

export function CustomViews({ cx, onClose }: Props) {
  const [data, , reload] = useCommand<Row[] | { views?: Row[] }>(cx, "view.customViews");
  const rows = Array.isArray(data) ? data : (data?.views ?? []);
  const [sel, setSel] = useState(-1);
  const [name, setName] = useState("");
  const act = useDo(cx, reload);
  const cur = rows[sel] ? cell(rows[sel].name ?? Object.values(rows[sel])[0]) : "";
  return (
    <Frame
      cx={cx}
      title="Custom Views"
      onClose={onClose}
      actions={
        <>
          <Btn disabled={!cur} onClick={() => act("view.customViews", { show: cur }, onClose)}>
            {cx.tw("Show")}
          </Btn>
          <Btn disabled={!cur} onClick={() => act("view.customViews", { delete: cur })}>
            {cx.tw("Delete")}
          </Btn>
        </>
      }
    >
      <Grid cx={cx} rows={rows} sel={sel} pick={setSel} empty="No custom views" />
      <div className="sh-dlg-form">
        <label>
          <span>{cx.tw("View name:")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Btn disabled={!name} onClick={() => act("view.customViews", { save: name }, () => setName(""))}>
          {cx.tw("Add")}
        </Btn>
      </div>
    </Frame>
  );
}

export function Journal({ cx, onClose }: Props) {
  const [data] = useCommand<unknown>(cx, "history.list");
  const rows = Array.isArray(data) ? (data as unknown[]).map((x) => (typeof x === "object" ? (x as Row) : { action: x })) : [];
  const u = data && !Array.isArray(data) ? (data as { undo?: unknown[]; redo?: unknown[] }) : undefined;
  const list = u ? [...(u.undo ?? []).map((a) => ({ stack: "undo", action: cell(a) })), ...(u.redo ?? []).map((a) => ({ stack: "redo", action: cell(a) }))] : rows;
  return (
    <Frame cx={cx} title="Command Journal" onClose={onClose}>
      <Grid cx={cx} rows={list as Row[]} empty="Nothing has been done yet" />
    </Frame>
  );
}

export function CommandSearch({ cx, onClose }: Props) {
  const [q, setQ] = useState("");
  const [data] = useCommand<Row[]>(cx, "app.commands", { search: q });
  const rows = asRows(data).slice(0, 80);
  return (
    <Frame cx={cx} title="Command Search" onClose={onClose}>
      <input className="full" autoFocus value={q} placeholder={cx.tw("Search commands…")} onChange={(e) => setQ(e.target.value)} />
      <div className="sh-dlg-grid">
        <table>
          <tbody>
            {rows.map((r) => (
              <tr
                key={cell(r.id)}
                onClick={() => {
                  onClose();
                  cx.run(cell(r.id), {});
                }}
              >
                <td>{cell(r.label)}</td>
                <td>{Array.isArray(r.menu) ? (r.menu as string[]).join(" › ") : ""}</td>
                <td>{cell(r.shortcut ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

export function Shortcuts({ cx, onClose }: Props) {
  const [data] = useCommand<Row[]>(cx, "app.commands");
  const rows = asRows(data).filter((r) => r.shortcut);
  return (
    <Frame cx={cx} title="Keyboard Shortcuts" onClose={onClose}>
      <Grid cx={cx} rows={rows.map((r) => ({ Command: r.label, Shortcut: r.shortcut }))} empty="No shortcuts" />
    </Frame>
  );
}

export function Statistics({ cx, onClose }: Props) {
  const [d] = useCommand<{ sheet?: Row; workbook?: Row }>(cx, "review.workbookStatistics");
  const kv = (o?: Row): Row[] => Object.entries(o ?? {}).map(([k, v]) => ({ Statistic: k, Value: v }));
  return (
    <Frame cx={cx} title="Workbook Statistics" onClose={onClose}>
      <h4>{cx.tw("Workbook")}</h4>
      <Grid cx={cx} rows={kv(d?.workbook)} empty="No data" />
      <h4>{cx.tw("Sheet")}</h4>
      <Grid cx={cx} rows={kv(d?.sheet)} empty="No data" />
    </Frame>
  );
}

export function Accessibility({ cx, onClose }: Props) {
  const [d] = useCommand<Row[]>(cx, "review.checkAccessibility");
  return (
    <Frame cx={cx} title="Accessibility Checker" onClose={onClose}>
      <Grid cx={cx} rows={asRows(d)} empty="No accessibility issues found" />
    </Frame>
  );
}

export function ErrorChecking({ cx, onClose }: Props) {
  const [d] = useCommand<{ errors?: Row[]; circular?: unknown[] }>(cx, "formulas.errorChecking");
  return (
    <Frame cx={cx} title="Error Checking" onClose={onClose}>
      <Grid cx={cx} rows={d?.errors ?? []} empty="No errors found" />
      {d?.circular?.length ? <div>{cx.tw("Circular references")}: {cell(d.circular)}</div> : null}
    </Frame>
  );
}

export function EvaluateFormula({ cx, onClose }: Props) {
  const [f, setF] = useState(cx.s.bar.text.startsWith("=") ? cx.s.bar.text : "");
  const [d, setD] = useState<{ steps?: Row[]; result?: unknown }>();
  useEffect(() => {
    if (!f.startsWith("=")) {
      setD(undefined);
      return;
    }
    let alive = true;
    cx.call("formulas.evaluateFormula", { formula: f }).then(
      (r) => alive && setD(r as { steps?: Row[] }),
      () => alive && setD(undefined),
    );
    return () => {
      alive = false;
    };
  }, [f, cx]);
  return (
    <Frame cx={cx} title="Evaluate Formula" onClose={onClose}>
      <input className="full" value={f} onChange={(e) => setF(e.target.value)} placeholder="=SUM(A1:A3)" />
      <Grid cx={cx} rows={d?.steps ?? []} empty="Enter a formula starting with =" />
      {d && d.result !== undefined ? <div>{cx.tw("Result")}: <b>{cell(d.result)}</b></div> : null}
    </Frame>
  );
}

export function Spelling({ cx, onClose }: Props) {
  const [d, err, reload] = useCommand<Row[]>(cx, "review.spelling");
  const rows = asRows(d);
  const [sel, setSel] = useState(0);
  const cur = rows[sel];
  const sug = Array.isArray(cur?.suggestions) ? (cur.suggestions as string[]) : [];
  const act = useDo(cx, reload);
  return (
    <Frame
      cx={cx}
      title="Spelling"
      onClose={onClose}
      actions={
        sug[0] ? (
          <>
            <Btn onClick={() => act("review.changeSpelling", { cell: cur.cell, word: cur.word, to: sug[0] })}>{cx.tw("Change")}</Btn>
            <Btn onClick={() => act("review.changeSpelling", { cell: cur.cell, word: cur.word, to: sug[0], all: true })}>{cx.tw("Change All")}</Btn>
          </>
        ) : undefined
      }
    >
      {err ? <div className="sh-dlg-empty">{err}</div> : <Grid cx={cx} rows={rows.map((r) => ({ cell: r.cell, word: r.word, suggestions: cell(r.suggestions) }))} sel={sel} pick={setSel} empty="No spelling errors found" />}
    </Frame>
  );
}

export function Thesaurus({ cx, onClose }: Props) {
  const [w, setW] = useState("");
  const [d, setD] = useState<unknown>();
  useEffect(() => {
    if (!w.trim()) {
      setD(undefined);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      cx.call("review.thesaurus", { word: w.trim() }).then(
        (r) => alive && setD(r),
        () => alive && setD(undefined),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [w, cx]);
  const words = Array.isArray(d) ? (d as unknown[]).map((x) => ({ Word: cell(x) })) : [];
  return (
    <Frame cx={cx} title="Thesaurus" onClose={onClose}>
      <input className="full" autoFocus value={w} placeholder={cx.tw("Look up:")} onChange={(e) => setW(e.target.value)} />
      <Grid cx={cx} rows={words} empty="No results" />
    </Frame>
  );
}

export function Queries({ cx, onClose }: Props) {
  const [d] = useCommand<Row[]>(cx, "data.queriesConnections");
  return (
    <Frame cx={cx} title="Queries & Connections" onClose={onClose}>
      <Grid cx={cx} rows={asRows(d)} empty="No queries or connections" />
    </Frame>
  );
}

export function Windows({ cx, onClose, hidden }: Props & { hidden?: boolean }) {
  const [d, , reload] = useCommand<Row[]>(cx, "view.switchWindows");
  const rows = asRows(d).filter((r) => (hidden ? r.hidden : !r.hidden));
  const [sel, setSel] = useState(-1);
  const act = useDo(cx, reload);
  const cur = rows[sel];
  return (
    <Frame
      cx={cx}
      title={hidden ? "Unhide" : "Switch Windows"}
      onClose={onClose}
      actions={
        hidden ? (
          <Btn disabled={!cur} onClick={() => cur && act("view.unhideWindow", { index: cur.index }, onClose)}>
            {cx.tw("Unhide")}
          </Btn>
        ) : undefined
      }
    >
      <Grid cx={cx} rows={rows.map((r) => ({ title: r.title, active: r.active }))} sel={sel} pick={setSel} empty={hidden ? "No hidden windows" : "No open windows"} />
    </Frame>
  );
}

export function About({ cx, onClose }: Props) {
  return (
    <Frame cx={cx} title="About GridCraft Engine" onClose={onClose} size="normal">
      <p>{cx.tw("MoonApp Sheets runs on the GridCraft spreadsheet engine.")}</p>
      <p>
        <a href="https://github.com/storytold/gridcraft" target="_blank" rel="noreferrer noopener">
          github.com/storytold/gridcraft
        </a>
      </p>
    </Frame>
  );
}
