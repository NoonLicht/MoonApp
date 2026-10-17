import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Btn } from "@/components/ui";
import type { SheetCx } from "@/pages/sheet/types";

type Row = Record<string, unknown>;

/** Данные команды ядра, обновляемые вместе с книгой (по её ревизии). */
function useLive<T>(cx: SheetCx, command: string, params: Record<string, unknown>, enabled = true): T | undefined {
  const [data, setData] = useState<T>();
  const rev = cx.s.doc.revision;
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      return;
    }
    let alive = true;
    // cx пересоздаётся после каждой команды, поэтому зависим только от ревизии книги.
    cx.call(command, JSON.parse(key) as Record<string, unknown>).then(
      (r) => alive && setData(r as T),
      () => alive && setData(undefined),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, command, key, enabled]);
  return data;
}

interface PivotField {
  name: string;
  numeric: boolean;
  areas: string[];
  samples: string[];
}
interface PivotInfo {
  fields: PivotField[];
  rows: { field: string }[];
  columns: { field: string }[];
  values: { field: string; name: string; func: string }[];
  filters: { field: string }[];
}

const AREAS: [string, string][] = [
  ["filters", "Filters"],
  ["columns", "Columns"],
  ["rows", "Rows"],
  ["values", "Values"],
];

/** Поля сводной таблицы: флажки полей и четыре области. */
export function PivotFieldsPane({ cx }: { cx: SheetCx }) {
  const pv = cx.s.ctx.pivot;
  const info = useLive<PivotInfo>(cx, "pivot.fields", {}, !!pv);
  if (!pv) return <div className="wd-muted">{cx.tw("Select a cell in a PivotTable.")}</div>;
  if (!info) return <div className="wd-muted">…</div>;
  const inArea = (area: string): { field: string; label: string }[] => {
    if (area === "values") return info.values.map((v) => ({ field: v.field, label: v.name }));
    const list = (info as unknown as Record<string, { field: string }[]>)[area] ?? [];
    return list.map((x) => ({ field: x.field, label: x.field }));
  };
  const toggle = (f: PivotField): void => {
    if (f.areas.length) f.areas.forEach((a) => cx.run("pivot.removeField", { field: f.name, area: a }));
    else cx.run("pivot.addField", { field: f.name, area: f.numeric ? "values" : "rows" });
  };
  return (
    <div className="sh-pv">
      <div className="sh-pv-title">{cx.tw("Choose fields to add to report:")}</div>
      <div className="sh-pv-fields">
        {info.fields.map((f) => (
          <label key={f.name} title={f.samples.join(", ")}>
            <input type="checkbox" checked={f.areas.length > 0} onChange={() => toggle(f)} />
            <span>{f.name}</span>
          </label>
        ))}
      </div>
      <div className="sh-pv-title">{cx.tw("Drag fields between areas below:")}</div>
      <div className="sh-pv-areas">
        {AREAS.map(([a, label]) => (
          <div key={a} className="sh-pv-area">
            <div className="sh-pv-area-title">{cx.tw(label)}</div>
            {inArea(a).map((x, i) => (
              <div key={`${x.field}${i}`} className="sh-pv-item">
                <span style={{ flex: 1 }}>{x.label}</span>
                <select
                  value=""
                  title={cx.tw("Move to")}
                  onChange={(e) => e.target.value && cx.run("pivot.moveField", { field: x.field, from: a, to: e.target.value })}
                >
                  <option value="">⇄</option>
                  {AREAS.filter(([t]) => t !== a).map(([t, l]) => (
                    <option key={t} value={t}>
                      {cx.tw(l)}
                    </option>
                  ))}
                </select>
                <button type="button" className="wd-x-btn" onClick={() => cx.run("pivot.removeField", { field: x.field, area: a })}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="sh-pv-foot">
        <Btn onClick={() => cx.run("pivot.refresh", {})}>{cx.tw("Refresh")}</Btn>
        <Btn onClick={() => cx.dialog("pivotOptions")}>{cx.tw("Options")}</Btn>
      </div>
    </div>
  );
}

/** Формат диаграммы: заголовок, легенда, подписи, сетка, палитра, тип. */
export function FormatChartPane({ cx }: { cx: SheetCx }) {
  const o = cx.ui.selObj;
  const chart = o?.kind === "chart" ? cx.s.objects.charts.find((c) => c.id === o.id) : undefined;
  const [title, setTitle] = useState("");
  useEffect(() => setTitle(chart?.title ?? ""), [chart?.id, chart?.title]);
  if (!chart) return <div className="wd-muted">{cx.tw("Select a chart.")}</div>;
  const set = (p: Record<string, unknown>): void => cx.run("chart.set", { chart: chart.id, ...p });
  const el = (element: string, on: boolean, extra: Record<string, unknown> = {}): void => cx.run("chart.addElement", { chart: chart.id, element, on, ...extra });
  return (
    <div className="sh-dlg-form">
      <label>
        <span>{cx.tw("Chart Title")}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== (chart.title ?? "") && set({ title })} onKeyDown={(e) => e.key === "Enter" && set({ title })} />
      </label>
      <label>
        <span>{cx.tw("Chart type:")}</span>
        <select value={chart.kind} onChange={(e) => cx.run("chart.changeType", { chart: chart.id, type: e.target.value })}>
          {["column", "bar", "line", "pie", "doughnut", "area", "scatter", "bubble", "radar"].map((t) => (
            <option key={t} value={t}>
              {cx.tw(t[0].toUpperCase() + t.slice(1))}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{cx.tw("Legend")}</span>
        <select defaultValue="bottom" onChange={(e) => set({ legend: e.target.value })}>
          {["none", "bottom", "top", "left", "right"].map((p) => (
            <option key={p} value={p}>
              {cx.tw(p === "none" ? "None" : p[0].toUpperCase() + p.slice(1))}
            </option>
          ))}
        </select>
      </label>
      <label className="sh-chk">
        <input type="checkbox" onChange={(e) => el("dataLabels", e.target.checked)} />
        <span>{cx.tw("Data Labels")}</span>
      </label>
      <label className="sh-chk">
        <input type="checkbox" onChange={(e) => el("gridlines", e.target.checked)} />
        <span>{cx.tw("Gridlines")}</span>
      </label>
      <label className="sh-chk">
        <input type="checkbox" onChange={(e) => el("axisTitles", e.target.checked)} />
        <span>{cx.tw("Axis Titles")}</span>
      </label>
      <label>
        <span>{cx.tw("Change Colors")}</span>
        <select defaultValue="" onChange={(e) => e.target.value && cx.run("chart.changeColors", { chart: chart.id, palette: e.target.value })}>
          <option value="">—</option>
          {["colorful", "monochrome", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((p) => (
            <option key={p} value={p}>
              {cx.tw(p === "colorful" ? "Colorful" : p === "monochrome" ? "Monochrome" : `Accent ${p.slice(-1)}`)}
            </option>
          ))}
        </select>
      </label>
      <Btn onClick={() => cx.dialog("selectData")}>{cx.tw("Select Data…")}</Btn>
    </div>
  );
}

/** Окно контрольного значения: ячейки, за которыми следим, и их значения. */
export function WatchPane({ cx }: { cx: SheetCx }) {
  const rows = useLive<Row[]>(cx, "formulas.watchWindow", {}) ?? [];
  const sheet = cx.s.sheets[cx.s.active]?.name ?? "";
  return (
    <div className="sh-dlg-form">
      <Btn onClick={() => cx.run("formulas.watchWindow", { add: `'${sheet}'!${cx.s.sel.a1.split(":")[0]}` })}>{cx.tw("Add Watch…")}</Btn>
      {rows.length === 0 ? <div className="wd-muted">{cx.tw("No cells are being watched.")}</div> : null}
      <div className="sh-dlg-grid">
        <table>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.cell)}>
                <td>{String(r.cell)}</td>
                <td>{String(r.value ?? "")}</td>
                <td title={String(r.formula ?? "")}>{String(r.formula ?? "")}</td>
                <td>
                  <button type="button" className="wd-x-btn" onClick={() => cx.run("formulas.watchWindow", { remove: String(r.cell) })}>
                    <X size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Имена книги: переход к диапазону по щелчку. */
export function NamesPane({ cx }: { cx: SheetCx }) {
  const rows = useLive<Row[]>(cx, "formulas.nameManager", {}) ?? [];
  return (
    <div>
      <div className="sh-pv-foot">
        <Btn onClick={() => cx.dialog("defineName")}>{cx.tw("New…")}</Btn>
        <Btn onClick={() => cx.dialog("nameManager")}>{cx.tw("Name Manager")}</Btn>
      </div>
      {rows.length === 0 ? <div className="wd-muted">{cx.tw("No names defined yet")}</div> : null}
      {rows.map((r) => (
        <div key={`${String(r.name)}${String(r.scope)}`} className="wd-nav-item" onClick={() => cx.run("edit.goTo", { reference: String(r.name) })} style={{ cursor: "pointer" }}>
          <b>{String(r.name)}</b>
          <div className="wd-muted">{String(r.refersTo ?? "")}</div>
        </div>
      ))}
    </div>
  );
}
