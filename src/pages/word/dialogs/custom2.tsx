import { useEffect, useMemo, useRef, useState } from "react";
import { Btn } from "@/components/ui";
import { Shell } from "@/pages/word/dialogs/form";
import type { DlgProps } from "@/pages/word/dialogs/custom1";
import { fileToBase64 } from "@/pages/word/lib";
import type { Params } from "@/pages/word/ribbon/types";

/* ---------------- Источники и цитаты ---------------- */

interface Source {
  tag: string;
  kind: string;
  author: string;
  title: string;
  year: string;
}

export function SourcesDialog({ cx, props, onClose }: DlgProps) {
  const cite = props.mode === "cite";
  const [list, setList] = useState<Source[]>([]);
  const [sel, setSel] = useState("");
  const [pages, setPages] = useState("");
  const load = (): void => {
    void cx
      .call("references.sources", {})
      .then((r) => setList(Array.isArray(r) ? (r as Source[]) : []));
  };
  useEffect(load, [cx]);
  return (
    <Shell
      title={cx.tw(cite ? "Insert Citation" : "Manage Sources")}
      onClose={onClose}
      size="wide"
      foot={
        <>
          <Btn onClick={() => cx.dialog("createSource")}>{cx.tw("Add New Source…")}</Btn>
          {!cite ? (
            <Btn
              disabled={!sel}
              onClick={() => {
                cx.run("references.sources", { remove: sel });
                setSel("");
                setTimeout(load, 300);
              }}
            >
              {cx.tw("Delete")}
            </Btn>
          ) : null}
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>{cx.tw("Close")}</Btn>
          {cite ? (
            <Btn
              variant="primary"
              disabled={!sel}
              onClick={() => {
                cx.run("references.citation", { tag: sel, pages: pages || undefined });
                onClose();
              }}
            >
              {cx.tw("Insert")}
            </Btn>
          ) : null}
        </>
      }
    >
      <div className="wd-list">
        {list.length === 0 ? (
          <div className="wd-muted" style={{ padding: 10 }}>
            {cx.tw("No sources yet.")}
          </div>
        ) : null}
        {list.map((s) => (
          <button
            key={s.tag}
            type="button"
            className={sel === s.tag ? "on" : ""}
            onClick={() => setSel(s.tag)}
          >
            <b>{s.author || s.tag}</b>
            <span style={{ flex: 1 }}>{s.title}</span>
            <span className="wd-muted">{s.year}</span>
          </button>
        ))}
      </div>
      {cite ? (
        <div className="wd-form">
          <span className="lbl">{cx.tw("Pages:")}</span>
          <input type="text" value={pages} onChange={(e) => setPages(e.target.value)} />
        </div>
      ) : null}
    </Shell>
  );
}

/* ---------------- Диаграммы ---------------- */

const CHART_TYPES: [string, string][] = [
  ["column", "Column"],
  ["columnStacked", "Stacked Column"],
  ["bar", "Bar"],
  ["barStacked", "Stacked Bar"],
  ["line", "Line"],
  ["area", "Area"],
  ["pie", "Pie"],
  ["doughnut", "Doughnut"],
  ["scatter", "Scatter"],
];

function ChartThumb({ type }: { type: string }) {
  const c = "currentColor";
  const bars = (stack: boolean, horiz: boolean): JSX.Element => {
    const v = [14, 22, 10, 26];
    return (
      <g>
        {v.map((h, i) =>
          horiz ? (
            <rect
              key={i}
              x="6"
              y={6 + i * 10}
              width={h + (stack ? 6 : 0)}
              height="7"
              fill={c}
              opacity={0.75 - i * 0.1}
            />
          ) : (
            <rect
              key={i}
              x={6 + i * 10}
              y={36 - h}
              width="7"
              height={h}
              fill={c}
              opacity={0.75 - i * 0.1}
            />
          ),
        )}
      </g>
    );
  };
  return (
    <svg viewBox="0 0 48 44" width="64" height="58" aria-hidden>
      <path d="M4 4V38H46" fill="none" stroke={c} opacity=".4" />
      {type === "column" || type === "columnStacked" ? bars(type === "columnStacked", false) : null}
      {type === "bar" || type === "barStacked" ? bars(type === "barStacked", true) : null}
      {type === "line" ? (
        <polyline points="6,30 16,18 26,26 40,10" fill="none" stroke={c} strokeWidth="2" />
      ) : null}
      {type === "area" ? (
        <polygon points="6,36 6,28 16,16 26,24 40,10 40,36" fill={c} opacity=".5" />
      ) : null}
      {type === "pie" ? (
        <g transform="translate(24 22)">
          <circle r="16" fill={c} opacity=".3" />
          <path d="M0 0L16 0A16 16 0 0 1 0 16Z" fill={c} />
          <path d="M0 0L0 16A16 16 0 0 1 -16 0Z" fill={c} opacity=".6" />
        </g>
      ) : null}
      {type === "doughnut" ? (
        <circle
          cx="24"
          cy="22"
          r="12"
          fill="none"
          stroke={c}
          strokeWidth="8"
          strokeDasharray="30 46"
        />
      ) : null}
      {type === "scatter" ? (
        <g fill={c}>
          {[
            [10, 30],
            [16, 22],
            [22, 28],
            [28, 14],
            [36, 18],
            [40, 8],
          ].map(([x, y]) => (
            <circle key={`${x}${y}`} cx={x} cy={y} r="2.4" />
          ))}
        </g>
      ) : null}
    </svg>
  );
}

export function ChartPickerDialog({ cx, props, onClose }: DlgProps) {
  const change = props.mode === "change";
  const cur = cx.s.ctx.object?.chart?.type;
  const [sel, setSel] = useState(change && cur ? cur : "column");
  return (
    <Shell
      title={cx.tw(change ? "Change Chart Type" : "Insert Chart")}
      onClose={onClose}
      size="wide"
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              if (change) cx.run("chart.type", { type: sel });
              else cx.run("insert.chart", { type: sel });
              onClose();
            }}
          >
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div
        className="wd-bs-tiles"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}
      >
        {CHART_TYPES.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className="wd-bs-tile"
            style={sel === v ? { borderColor: "var(--amber)" } : undefined}
            onClick={() => setSel(v)}
            onDoubleClick={() => setSel(v)}
          >
            <ChartThumb type={v} />
            <span>{cx.tw(l)}</span>
          </button>
        ))}
      </div>
    </Shell>
  );
}

export function ChartDataDialog({ cx, onClose }: DlgProps) {
  const ch = cx.s.ctx.object?.chart;
  const [cats, setCats] = useState<string[]>(ch?.categories ?? ["A", "B", "C"]);
  const [series, setSeries] = useState<{ name: string; values: string[] }[]>(
    (ch?.series ?? [{ name: "Series 1", values: [1, 2, 3] }]).map((s) => ({
      name: s.name,
      values: s.values.map((v) => (v == null ? "" : String(v))),
    })),
  );
  const setVal = (si: number, ci: number, v: string): void =>
    setSeries((all) =>
      all.map((s, i) =>
        i === si ? { ...s, values: s.values.map((x, j) => (j === ci ? v : x)) } : s,
      ),
    );
  return (
    <Shell
      title={cx.tw("Edit Data")}
      onClose={onClose}
      size="xwide"
      foot={
        <>
          <Btn
            onClick={() => {
              setCats((c) => [...c, `${cx.tw("Category")} ${c.length + 1}`]);
              setSeries((all) => all.map((s) => ({ ...s, values: [...s.values, ""] })));
            }}
          >
            {cx.tw("Add row")}
          </Btn>
          <Btn
            onClick={() =>
              setSeries((all) => [
                ...all,
                { name: `${cx.tw("Series")} ${all.length + 1}`, values: cats.map(() => "") },
              ])
            }
          >
            {cx.tw("Add column")}
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              cx.run("chart.editData", {
                data: {
                  categories: cats,
                  series: series.map((s) => ({
                    name: s.name,
                    values: s.values.map((v) =>
                      v.trim() === "" || Number.isNaN(Number(v.replace(",", ".")))
                        ? null
                        : Number(v.replace(",", ".")),
                    ),
                  })),
                },
              });
              onClose();
            }}
          >
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div style={{ overflow: "auto" }}>
        <table className="wd-grid-edit">
          <thead>
            <tr>
              <th />
              {series.map((s, i) => (
                <th key={i}>
                  <input
                    value={s.name}
                    onChange={(e) =>
                      setSeries((all) =>
                        all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cats.map((c, ci) => (
              <tr key={ci}>
                <td>
                  <input
                    value={c}
                    onChange={(e) =>
                      setCats((all) => all.map((x, j) => (j === ci ? e.target.value : x)))
                    }
                  />
                </td>
                {series.map((s, si) => (
                  <td key={si}>
                    <input
                      value={s.values[ci] ?? ""}
                      inputMode="decimal"
                      onChange={(e) => setVal(si, ci, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

/* ---------------- SmartArt ---------------- */

const SMART: [string, string][] = [
  ["basicList", "Basic List"],
  ["process", "Process"],
  ["cycle", "Cycle"],
  ["hierarchy", "Hierarchy"],
  ["pyramid", "Pyramid"],
  ["radial", "Radial"],
  ["matrix", "Matrix"],
  ["venn", "Venn"],
];

function SmartThumb({ kind }: { kind: string }) {
  const c = "currentColor";
  const box = (x: number, y: number, w = 9, h = 7, o = 0.7): JSX.Element => (
    <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx="1.5" fill={c} opacity={o} />
  );
  return (
    <svg viewBox="0 0 48 40" width="64" height="54" aria-hidden>
      {kind === "basicList" ? [0, 1, 2].map((i) => box(6, 5 + i * 11, 36)) : null}
      {kind === "process" ? [0, 1, 2].map((i) => box(4 + i * 15, 16, 11)) : null}
      {kind === "cycle" ? [box(19, 4), box(31, 21), box(7, 21)] : null}
      {kind === "hierarchy" ? [box(19, 4), box(6, 24), box(32, 24)] : null}
      {kind === "pyramid" ? <polygon points="24,5 42,35 6,35" fill={c} opacity=".6" /> : null}
      {kind === "radial"
        ? [box(19, 16), box(19, 3, 9, 6), box(19, 31, 9, 6), box(4, 16, 9, 7), box(35, 16, 9, 7)]
        : null}
      {kind === "matrix"
        ? [box(8, 6, 15, 12), box(25, 6, 15, 12), box(8, 21, 15, 12), box(25, 21, 15, 12)]
        : null}
      {kind === "venn" ? (
        <g fill={c} opacity=".4">
          <circle cx="19" cy="18" r="11" />
          <circle cx="29" cy="18" r="11" />
        </g>
      ) : null}
    </svg>
  );
}

export function SmartArtPickerDialog({ cx, onClose }: DlgProps) {
  const [sel, setSel] = useState("basicList");
  return (
    <Shell
      title={cx.tw("Choose a SmartArt Graphic")}
      onClose={onClose}
      size="wide"
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              cx.run("insert.smartArt", { layout: sel });
              onClose();
            }}
          >
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div
        className="wd-bs-tiles"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}
      >
        {SMART.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className="wd-bs-tile"
            style={sel === v ? { borderColor: "var(--amber)" } : undefined}
            onClick={() => setSel(v)}
          >
            <SmartThumb kind={v} />
            <span>{cx.tw(l)}</span>
          </button>
        ))}
      </div>
    </Shell>
  );
}

/* ---------------- Значки ---------------- */

interface IconInfo {
  id: string;
  name: string;
  category: string;
  keywords: string[];
}

export function IconsDialog({ cx, onClose }: DlgProps) {
  const [all, setAll] = useState<IconInfo[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [color, setColor] = useState("000000");
  const [size, setSize] = useState(48);
  useEffect(() => {
    void cx
      .call("insert.icon", {})
      .then((r) => setAll(((r as { icons?: IconInfo[] } | undefined)?.icons ?? []) as IconInfo[]));
  }, [cx]);
  const cats = useMemo(() => [...new Set(all.map((i) => i.category))], [all]);
  const shown = all.filter(
    (i) =>
      (!cat || i.category === cat) &&
      (!q || `${i.name} ${i.keywords.join(" ")}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <Shell
      title={cx.tw("Icons")}
      onClose={onClose}
      size="wide"
      foot={<Btn onClick={onClose}>{cx.tw("Close")}</Btn>}
    >
      <div className="wd-inline" style={{ flexWrap: "wrap" }}>
        <input
          type="text"
          value={q}
          placeholder={cx.tw("Search")}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{cx.tw("All")}</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="color"
          value={`#${color}`}
          onChange={(e) => setColor(e.target.value.slice(1).toUpperCase())}
        />
        <input
          type="number"
          value={size}
          min={8}
          max={400}
          onChange={(e) => setSize(Number(e.target.value) || 48)}
          style={{ width: 70 }}
        />
        <span className="wd-muted">pt</span>
      </div>
      <div
        className="wd-list"
        style={{
          maxHeight: 320,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
        }}
      >
        {shown.slice(0, 400).map((i) => (
          <button
            key={i.id}
            type="button"
            style={{ borderRight: "1px solid var(--glass-border)" }}
            onClick={() => {
              cx.run("insert.icon", { id: i.id, color, size });
              onClose();
            }}
          >
            {i.name}
          </button>
        ))}
        {shown.length === 0 ? (
          <div className="wd-muted" style={{ padding: 10 }}>
            —
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

/* ---------------- Формулы ---------------- */

interface EqGallery {
  builtins: { id: string; label: string; linear: string }[];
  structures: {
    id: string;
    label: string;
    sections: { name: string; templates: { id: string; label: string; linear: string }[] }[];
  }[];
  symbols: { name: string; chars: string }[];
}

export function EquationGalleryDialog({ cx, onClose }: DlgProps) {
  const [g, setG] = useState<EqGallery | null>(null);
  const [tab, setTab] = useState(0);
  useEffect(() => {
    void cx.call("equation.gallery", {}).then((r) => setG(r as EqGallery));
  }, [cx]);
  const tabs = [cx.tw("Equation"), cx.tw("Structures"), cx.tw("Symbols")];
  return (
    <Shell
      title={cx.tw("Equation")}
      onClose={onClose}
      size="xwide"
      tabs={tabs}
      tab={tab}
      setTab={setTab}
      foot={<Btn onClick={onClose}>{cx.tw("Close")}</Btn>}
    >
      {tab === 0 ? (
        <div className="wd-list" style={{ maxHeight: 420 }}>
          {(g?.builtins ?? []).map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                cx.run("insert.equation", { builtin: b.id });
                onClose();
              }}
            >
              <span style={{ flex: 1 }}>{b.label}</span>
              <code style={{ opacity: 0.7, fontSize: 12 }}>{b.linear.slice(0, 60)}</code>
            </button>
          ))}
        </div>
      ) : null}
      {tab === 1
        ? (g?.structures ?? []).map((st) => (
            <div key={st.id}>
              {st.sections.map((sec) => (
                <div key={sec.name} style={{ marginBottom: 8 }}>
                  <div className="wd-muted" style={{ marginBottom: 4 }}>
                    {sec.name}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {sec.templates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="wd-mini"
                        style={{ height: 32, minWidth: 40 }}
                        title={t.label}
                        onClick={() => {
                          cx.run("equation.insertStructure", { id: t.id });
                          onClose();
                        }}
                      >
                        {t.linear}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))
        : null}
      {tab === 2
        ? (g?.symbols ?? []).map((s) => (
            <div key={s.name} style={{ marginBottom: 8 }}>
              <div className="wd-muted" style={{ marginBottom: 4 }}>
                {s.name}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                {Array.from(s.chars).map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    className="wd-mini"
                    style={{ width: 30, height: 30, fontSize: 15 }}
                    onClick={() => cx.run("equation.insertSymbol", { char: c })}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          ))
        : null}
    </Shell>
  );
}

/* ---------------- Правописание ---------------- */

export function ThesaurusDialog({ cx, onClose }: DlgProps) {
  const [r, setR] = useState<{ word: string; synonyms: string[] } | null>(null);
  useEffect(() => {
    void cx
      .call("review.thesaurus", {})
      .then((x) => setR(x as { word: string; synonyms: string[] }));
  }, [cx]);
  return (
    <Shell
      title={cx.tw("Thesaurus")}
      onClose={onClose}
      foot={<Btn onClick={onClose}>{cx.tw("Close")}</Btn>}
    >
      <div>
        <b>{r?.word || cx.tw("(no word at the caret)")}</b>
      </div>
      <div className="wd-list">
        {(r?.synonyms ?? []).length === 0 ? (
          <div className="wd-muted" style={{ padding: 10 }}>
            {cx.tw("No synonyms found.")}
          </div>
        ) : null}
        {(r?.synonyms ?? []).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              cx.run("review.applySuggestion", { text: s });
              onClose();
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </Shell>
  );
}

export function WordCountDialog({ cx, onClose }: DlgProps) {
  const [r, setR] = useState<Record<string, number> | null>(null);
  const [tb, setTb] = useState(true);
  useEffect(() => {
    void cx
      .call("review.wordCount", { includeTextBoxes: tb })
      .then((x) => setR(x as Record<string, number>));
  }, [cx, tb]);
  const rows: [string, string][] = [
    ["Pages", "pages"],
    ["Words", "words"],
    ["Characters (no spaces)", "characters"],
    ["Characters (with spaces)", "charactersWithSpaces"],
    ["Paragraphs", "paragraphs"],
    ["Lines", "lines"],
  ];
  return (
    <Shell
      title={cx.tw("Word Count")}
      onClose={onClose}
      foot={
        <Btn variant="primary" onClick={onClose}>
          {cx.tw("Close")}
        </Btn>
      }
    >
      <div className="wd-bs-props" style={{ gridTemplateColumns: "1fr auto" }}>
        {rows.map(([l, k]) => (
          <div key={k} style={{ display: "contents" }}>
            <span>{cx.tw(l)}</span>
            <b>{r ? r[k] : "…"}</b>
          </div>
        ))}
      </div>
      <label className="wd-chk">
        <input type="checkbox" checked={tb} onChange={(e) => setTb(e.target.checked)} />
        <span>{cx.tw("Include textboxes, footnotes and endnotes")}</span>
      </label>
    </Shell>
  );
}

/* ---------------- Масштаб ---------------- */

export function ZoomDialog({ cx, onClose }: DlgProps) {
  const cur = Math.round(cx.ui.zoom * 100);
  const [mode, setMode] = useState(cx.s.view.fit || String(cur));
  const [pct, setPct] = useState(cur);
  const presets: [string, string][] = [
    ["200", "200%"],
    ["100", "100%"],
    ["75", "75%"],
    ["pageWidth", "Page width"],
    ["onePage", "Whole page"],
    ["multiplePages", "Many pages"],
    ["custom", "Percent:"],
  ];
  return (
    <Shell
      title={cx.tw("Zoom")}
      onClose={onClose}
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              if (["pageWidth", "onePage", "multiplePages"].includes(mode))
                cx.run("view.zoom", { value: mode });
              else if (mode === "custom") cx.ui.setZoom(Math.max(0.1, Math.min(5, pct / 100)));
              else cx.ui.setZoom(Number(mode) / 100);
              onClose();
            }}
          >
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div className="wd-radios" style={{ flexDirection: "column" }}>
        {presets.map(([v, l]) => (
          <label key={v}>
            <input type="radio" name="zoom" checked={mode === v} onChange={() => setMode(v)} />
            <span>{v === "custom" || /%$/.test(l) ? cx.tw(l) : cx.tw(l)}</span>
            {v === "custom" ? (
              <input
                type="number"
                value={pct}
                min={10}
                max={500}
                onChange={(e) => (setPct(Number(e.target.value) || 100), setMode("custom"))}
                style={{ width: 80 }}
              />
            ) : null}
          </label>
        ))}
      </div>
    </Shell>
  );
}

/* ---------------- Команды (поиск по всем командам) ---------------- */

interface Match {
  id: string;
  label: string;
  location: string;
  shortcut: string;
}

export function useCommandSearch(cx: DlgProps["cx"], q: string): Match[] {
  const [m, setM] = useState<Match[]>([]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      if (!q.trim()) {
        setM([]);
        return;
      }
      void cx.call("tools.search", { query: q }).then((r) => {
        if (alive) setM(((r as { matches?: Match[] } | undefined)?.matches ?? []).slice(0, 60));
      });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [cx, q]);
  return m;
}

export const locationLabel = (cx: DlgProps["cx"], loc: string): string =>
  loc
    .split(" › ")
    .map((p) => cx.tw(p))
    .join(" › ");

export function CommandsDialog({ cx, onClose }: DlgProps) {
  const [q, setQ] = useState("");
  const m = useCommandSearch(cx, q);
  return (
    <Shell
      title={cx.tw("Commands")}
      onClose={onClose}
      size="wide"
      foot={<Btn onClick={onClose}>{cx.tw("Close")}</Btn>}
    >
      <input
        type="text"
        value={q}
        placeholder={cx.tw("Search commands")}
        data-autofocus=""
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="wd-list" style={{ maxHeight: 360 }}>
        {m.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              cx.run(c.id);
              onClose();
            }}
          >
            <span style={{ flex: 1 }}>{cx.tw(c.label)}</span>
            <span className="wd-muted">{locationLabel(cx, c.location)}</span>
            {c.shortcut ? <code>{c.shortcut}</code> : null}
          </button>
        ))}
      </div>
    </Shell>
  );
}

export function AboutDialog({ cx, onClose }: DlgProps) {
  return (
    <Shell
      title={cx.tw("About")}
      onClose={onClose}
      foot={
        <Btn variant="primary" onClick={onClose}>
          {cx.tw("OK")}
        </Btn>
      }
    >
      <div>
        <b>MoonApp · {cx.tw("Documents")}</b>
      </div>
      <div className="wd-muted">
        Document engine: WordCraft (MIT OR Apache-2.0). Interface labels are a clean-room
        translation catalog from the same project.
      </div>
    </Shell>
  );
}

/* ---------------- Макросы, шаблоны, быстрые части ---------------- */

export function MacrosDialog({ cx, onClose }: DlgProps) {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [sel, setSel] = useState("");
  const load = (): void => {
    void cx
      .call("tools.macros", {})
      .then((r) => setNames(Object.keys((r as Record<string, unknown>) ?? {})));
  };
  useEffect(load, [cx]);
  return (
    <Shell
      title={cx.tw("Macros")}
      onClose={onClose}
      foot={<Btn onClick={onClose}>{cx.tw("Close")}</Btn>}
    >
      <div className="wd-form" style={{ gridTemplateColumns: "1fr auto" }}>
        <input
          type="text"
          value={name}
          placeholder={cx.tw("Macro name:")}
          onChange={(e) => setName(e.target.value)}
        />
        <Btn
          onClick={() => {
            cx.run("tools.recordMacro", { name: name || "Macro1" });
            onClose();
          }}
        >
          {cx.tw("Record Macro…")}
        </Btn>
      </div>
      <div className="wd-list">
        {names.length === 0 ? (
          <div className="wd-muted" style={{ padding: 10 }}>
            —
          </div>
        ) : null}
        {names.map((n) => (
          <button key={n} type="button" className={sel === n ? "on" : ""} onClick={() => setSel(n)}>
            {n}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn
          disabled={!sel}
          onClick={() => {
            cx.run("tools.macros", { run: sel });
            onClose();
          }}
        >
          {cx.tw("Run")}
        </Btn>
        <Btn
          disabled={!sel}
          onClick={() => {
            cx.run("tools.macros", { delete: sel });
            setSel("");
            setTimeout(load, 300);
          }}
        >
          {cx.tw("Delete")}
        </Btn>
      </div>
    </Shell>
  );
}

export function QuickPartsDialog({ cx, props, onClose }: DlgProps) {
  const cmd = props.name === "autoText" ? "insert.autoText" : "insert.quickParts";
  const [parts, setParts] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [sel, setSel] = useState("");
  const load = (): void => {
    void cx
      .call("insert.quickParts", {})
      .then((r) => setParts((r as { parts?: string[] } | undefined)?.parts ?? []));
  };
  useEffect(load, [cx]);
  return (
    <Shell
      title={cx.tw(cmd === "insert.autoText" ? "AutoText" : "Quick Parts")}
      onClose={onClose}
      foot={<Btn onClick={onClose}>{cx.tw("Close")}</Btn>}
    >
      <div className="wd-form" style={{ gridTemplateColumns: "1fr auto" }}>
        <input
          type="text"
          value={name}
          placeholder={cx.tw("Name:")}
          onChange={(e) => setName(e.target.value)}
        />
        <Btn
          disabled={!name || cx.s.selection.collapsed}
          onClick={() => {
            cx.run(cmd, { save: name });
            setName("");
            setTimeout(load, 300);
          }}
        >
          {cx.tw("Save Selection to Quick Part Gallery…")}
        </Btn>
      </div>
      <div className="wd-list">
        {parts.length === 0 ? (
          <div className="wd-muted" style={{ padding: 10 }}>
            —
          </div>
        ) : null}
        {parts.map((p) => (
          <button
            key={p}
            type="button"
            className={sel === p ? "on" : ""}
            onClick={() => setSel(p)}
            onDoubleClick={() => (cx.run(cmd, { insert: p }), onClose())}
          >
            {p}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn
          disabled={!sel}
          onClick={() => {
            cx.run(cmd, { insert: sel });
            onClose();
          }}
        >
          {cx.tw("Insert")}
        </Btn>
        <Btn
          disabled={!sel}
          onClick={() => {
            cx.run("insert.quickParts", { delete: sel });
            setSel("");
            setTimeout(load, 300);
          }}
        >
          {cx.tw("Delete")}
        </Btn>
      </div>
    </Shell>
  );
}

/** Выбор файла → загрузка на сервер → команда с путём. */
export function FileCommandDialog({ cx, props, onClose }: DlgProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const spec = props as {
    title: string;
    accept: string;
    cmd: string;
    key?: string;
    extra?: Params;
  };
  const pick = async (f: File): Promise<void> => {
    setBusy(true);
    const path = await cx.ui.upload(f);
    if (path) cx.run(spec.cmd, { ...spec.extra, [spec.key ?? "path"]: path });
    setBusy(false);
    onClose();
  };
  useEffect(() => {
    ref.current?.click();
  }, []);
  return (
    <Shell
      title={cx.tw(spec.title)}
      onClose={onClose}
      foot={<Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>}
    >
      <input
        ref={ref}
        type="file"
        accept={spec.accept}
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
        }}
      />
      {busy ? <div className="wd-muted">…</div> : null}
    </Shell>
  );
}

export function TemplatesDialog({ cx, onClose }: DlgProps) {
  const [t, setT] = useState<{ template: string | null; linkStyles: boolean } | null>(null);
  const [link, setLink] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const load = (): void => {
    void cx.call("tools.templates", {}).then((r) => {
      const x = r as { template: string | null; linkStyles: boolean };
      setT(x);
      setLink(!!x?.linkStyles);
    });
  };
  useEffect(load, [cx]);
  return (
    <Shell
      title={cx.tw("Templates and Add-ins")}
      onClose={onClose}
      foot={<Btn onClick={onClose}>{cx.tw("Close")}</Btn>}
    >
      <div>
        {cx.tw("Document template:")} <b>{t?.template ?? cx.tw("Normal")}</b>
      </div>
      <label className="wd-chk">
        <input
          type="checkbox"
          checked={link}
          onChange={(e) => {
            setLink(e.target.checked);
            cx.run("tools.linkStyles", { value: e.target.checked });
          }}
        />
        <span>{cx.tw("Automatically update document styles")}</span>
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={() => ref.current?.click()}>{cx.tw("Attach…")}</Btn>
        <Btn
          onClick={() => {
            cx.run("tools.detachTemplate");
            setTimeout(load, 300);
          }}
        >
          {cx.tw("Detach Template")}
        </Btn>
      </div>
      <input
        ref={ref}
        type="file"
        accept=".dotx,.dot,.docx,.dotm"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const path = await cx.ui.upload(f);
          if (path) cx.run("tools.attachTemplate", { path, linkStyles: link, update: true });
          onClose();
        }}
      />
    </Shell>
  );
}

/* ---------------- Получатели рассылки ---------------- */

interface RecipientData {
  headers: string[];
  rows: Record<string, string>[];
}

export function RecipientsDialog({ cx, props, onClose }: DlgProps) {
  const isNew = props.name === "newRecipientList";
  const [fields, setFields] = useState<string[]>([
    "First Name",
    "Last Name",
    "Company",
    "Address",
    "City",
    "E-mail",
  ]);
  const [rows, setRows] = useState<string[][]>([["", "", "", "", "", ""]]);
  useEffect(() => {
    if (isNew) return;
    void cx.call("mailings.editRecipients", {}).then((r) => {
      const d = r as RecipientData | undefined;
      if (d?.headers?.length) {
        setFields(d.headers);
        setRows((d.rows ?? []).map((row) => d.headers.map((h) => String(row[h] ?? ""))));
      }
    });
  }, [cx, isNew]);
  return (
    <Shell
      title={cx.tw(isNew ? "Type a New List…" : "Edit Recipient List")}
      onClose={onClose}
      size="xwide"
      foot={
        <>
          <Btn onClick={() => setRows((r) => [...r, fields.map(() => "")])}>{cx.tw("Add row")}</Btn>
          <Btn
            onClick={() => {
              setFields((f) => [...f, `${cx.tw("Column")} ${f.length + 1}`]);
              setRows((r) => r.map((x) => [...x, ""]));
            }}
          >
            {cx.tw("Add column")}
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              const data = rows
                .filter((r) => r.some((c) => c.trim()))
                .map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i] ?? ""])));
              cx.run(isNew ? "mailings.recipients" : "mailings.editRecipients", {
                rows: data,
                fields,
              });
              onClose();
            }}
          >
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div style={{ overflow: "auto" }}>
        <table className="wd-grid-edit">
          <thead>
            <tr>
              {fields.map((f, i) => (
                <th key={i}>
                  <input
                    value={f}
                    onChange={(e) =>
                      setFields((all) => all.map((x, j) => (j === i ? e.target.value : x)))
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {fields.map((_, ci) => (
                  <td key={ci}>
                    <input
                      value={r[ci] ?? ""}
                      onChange={(e) =>
                        setRows((all) =>
                          all.map((x, j) =>
                            j === ri ? x.map((c, k) => (k === ci ? e.target.value : c)) : x,
                          ),
                        )
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

export function ExistingRecipientsDialog({ cx, onClose }: DlgProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.click();
  }, []);
  return (
    <Shell
      title={cx.tw("Use an Existing List…")}
      onClose={onClose}
      foot={<Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>}
    >
      <input
        ref={ref}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.ods"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (/\.(csv|tsv|txt)$/i.test(f.name))
            cx.run("mailings.recipients", { csv: await f.text() });
          else cx.run("mailings.recipients", { data: await fileToBase64(f), sheet: 1 });
          onClose();
        }}
      />
    </Shell>
  );
}

/* ---------------- Вставить специальнo ---------------- */

export function PasteSpecialDialog({ cx, onClose }: DlgProps) {
  const [as, setAs] = useState("formatted");
  const opts: [string, string][] = [
    ["formatted", "Formatted Text"],
    ["rtf", "Formatted Text (RTF)"],
    ["html", "HTML Format"],
    ["picture", "Picture"],
    ["text", "Unformatted Text"],
  ];
  return (
    <Shell
      title={cx.tw("Paste Special…")}
      onClose={onClose}
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn
            variant="primary"
            onClick={async () => {
              let text = "";
              let html = "";
              let picture = "";
              try {
                for (const it of await navigator.clipboard.read()) {
                  const img = it.types.find((t) => t.startsWith("image/"));
                  if (img) picture = await fileToBase64(await it.getType(img));
                  if (it.types.includes("text/html"))
                    html = await (await it.getType("text/html")).text();
                  if (it.types.includes("text/plain"))
                    text = await (await it.getType("text/plain")).text();
                }
              } catch {
                try {
                  text = await navigator.clipboard.readText();
                } catch {
                  /* нет доступа к буферу */
                }
              }
              cx.run("edit.pasteSpecial", { as, text, html, picture: picture || undefined });
              onClose();
            }}
          >
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div className="wd-radios" style={{ flexDirection: "column" }}>
        {opts.map(([v, l]) => (
          <label key={v}>
            <input type="radio" name="ps" checked={as === v} onChange={() => setAs(v)} />
            <span>{cx.tw(l)}</span>
          </label>
        ))}
      </div>
    </Shell>
  );
}

/* ---------------- Сохранить как ---------------- */

const SAVE_FORMATS: [string, string][] = [
  ["docx", "Word Document (*.docx)"],
  ["pdf", "PDF (*.pdf)"],
  ["odt", "OpenDocument Text (*.odt)"],
  ["rtf", "Rich Text Format (*.rtf)"],
  ["html", "Web Page (*.html)"],
  ["md", "Markdown (*.md)"],
  ["txt", "Plain Text (*.txt)"],
];

export function SaveAsDialog({ cx, props, onClose }: DlgProps) {
  const [name, setName] = useState(cx.ui.docName.replace(/\.[^.]+$/, ""));
  const [fmt, setFmt] = useState(String(props.format ?? "docx"));
  return (
    <Shell
      title={cx.tw(fmt === "pdf" ? "Export PDF" : "Save As")}
      onClose={onClose}
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn
            variant="primary"
            disabled={!name.trim()}
            onClick={() => {
              cx.ui.exportAs(fmt, name.trim());
              onClose();
            }}
          >
            {cx.tw("Save")}
          </Btn>
        </>
      }
    >
      <div className="wd-form">
        <span className="lbl">{cx.tw("File name:")}</span>
        <input
          type="text"
          value={name}
          data-autofocus=""
          onChange={(e) => setName(e.target.value)}
        />
        <span className="lbl">{cx.tw("Save as type:")}</span>
        <select value={fmt} onChange={(e) => setFmt(e.target.value)}>
          {SAVE_FORMATS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
    </Shell>
  );
}
