import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  FileOutput,
  FilePlus2,
  FolderOpen,
  Info,
  Printer,
  Save,
  SaveAll,
  Settings,
  X,
} from "lucide-react";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import type { SheetCx } from "@/pages/sheet/types";

export type BackstagePage = "new" | "open" | "info" | "save" | "saveAs" | "print" | "export" | "options";

const SAMPLES: [string, string][] = [
  ["blank", "Blank workbook"],
  ["budget", "Budget"],
  ["sales", "Sales"],
  ["grades", "Grades"],
];

const FORMATS: [string, string, string][] = [
  ["xlsx", "Excel Workbook (*.xlsx)", "Default format"],
  ["pdf", "PDF (*.pdf)", "Fixed layout, ready to share"],
  ["csv", "CSV (*.csv)", "Active sheet as comma-separated text"],
  ["tsv", "Tab-separated text (*.tsv)", ""],
  ["json", "JSON (*.json)", ""],
  ["html", "Web Page (*.html)", ""],
];

function Row({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="wd-bs-row">
      <div>
        <b>{title}</b>
        {sub ? <span className="sub">{sub}</span> : null}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

interface Props2 {
  title?: string;
  subject?: string;
  author?: string;
  company?: string;
  keywords?: string;
  description?: string;
}

function InfoPage({ cx }: { cx: SheetCx }) {
  const [p, setP] = useState<Props2>({});
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const load = (): void => void cx.call("file.properties", {}).then((r) => setP((r as Props2) ?? {}));
  useEffect(load, [cx]);
  const fields: [keyof Props2, string][] = [
    ["title", "Title"],
    ["subject", "Subject"],
    ["author", "Author"],
    ["company", "Company"],
    ["keywords", "Keywords"],
    ["description", "Comments"],
  ];
  return (
    <>
      <h2>{cx.tw("Info")}</h2>
      <Row title={cx.tw("Protect Workbook")} sub={cx.tw("Control what types of changes people can make")}>
        <Btn onClick={() => cx.dialog("protectWorkbook")}>{cx.tw("Protect Workbook")}</Btn>
        <Btn onClick={() => cx.dialog("protectSheet")}>{cx.tw("Protect Current Sheet")}</Btn>
      </Row>
      <Row title={cx.tw("Inspect Workbook")} sub={cx.tw("Check the workbook for issues and statistics")}>
        <Btn onClick={() => void cx.call("review.workbookStatistics", {}).then((r) => setStats(r as Record<string, unknown>))}>
          {cx.tw("Workbook Statistics")}
        </Btn>
        <Btn onClick={() => cx.dialog("accessibility")}>{cx.tw("Check Accessibility")}</Btn>
      </Row>
      {stats ? (
        <pre className="wd-muted" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
          {JSON.stringify(stats, null, 1)}
        </pre>
      ) : null}
      <h3 style={{ marginTop: 18 }}>{cx.tw("Properties")}</h3>
      <div className="wd-form">
        {fields.map(([k, l]) => (
          <label key={k} style={{ display: "contents" }}>
            <span className="lbl">{cx.tw(l)}</span>
            <input
              value={p[k] ?? ""}
              onChange={(e) => setP((o) => ({ ...o, [k]: e.target.value }))}
              onBlur={() => cx.run("file.properties", { [k]: p[k] ?? "" })}
            />
          </label>
        ))}
      </div>
    </>
  );
}

function OptionsPage({ cx }: { cx: SheetCx }) {
  /** Настройки приложения лежат в сеансе ядра; после записи обновляем состояние. */
  const setPref = (p: Record<string, unknown>): void => {
    void cx.query("view.prefs", p).then(() => cx.run("file.options", {}));
  };
  const s = cx.s;
  return (
    <>
      <h2>{cx.tw("Options")}</h2>
      <Row title={cx.tw("Calculation")} sub={cx.tw("Workbook calculation mode")}>
        <select
          value={s.calc.mode}
          onChange={(e) => cx.run("formulas.calculationOptions", { mode: e.target.value.toLowerCase() })}
        >
          <option value="Automatic">{cx.tw("Automatic")}</option>
          <option value="AutomaticExceptTables">{cx.tw("Automatic Except for Data Tables")}</option>
          <option value="Manual">{cx.tw("Manual")}</option>
        </select>
        <label className="wd-chk">
          <input
            type="checkbox"
            checked={s.calc.iterative}
            onChange={(e) => cx.run("formulas.calculationOptions", { iterative: e.target.checked })}
          />
          <span>{cx.tw("Enable iterative calculation")}</span>
        </label>
      </Row>
      <Row title={cx.tw("Formula Bar")}>
        <label className="wd-chk">
          <input
            type="checkbox"
            checked={s.view.formulaBar}
            onChange={(e) => cx.run("view.formulaBar", { on: e.target.checked })}
          />
          <span>{cx.tw("Show formula bar")}</span>
        </label>
      </Row>
      <Row title={cx.tw("User name")}>
        <input
          defaultValue={s.prefs.userName}
          onBlur={(e) => setPref({ userName: e.target.value })}
        />
      </Row>
      <Row title={cx.tw("Autocomplete")}>
        <label className="wd-chk">
          <input
            type="checkbox"
            checked={s.prefs.autocomplete}
            onChange={(e) => setPref({ autocomplete: e.target.checked })}
          />
          <span>{cx.tw("Enable AutoComplete for cell values")}</span>
        </label>
      </Row>
    </>
  );
}

export default function Backstage({
  cx,
  page,
  setPage,
  onClose,
  create,
  openFile,
}: {
  cx: SheetCx;
  page: BackstagePage;
  setPage: (p: BackstagePage) => void;
  onClose: () => void;
  create: (sample: string) => void;
  openFile: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const [pdfSheets, setPdfSheets] = useState<"active" | "all">("active");
  const nav: [BackstagePage, string, React.ReactNode][] = [
    ["info", "Info", <Info key="i" size={16} />],
    ["new", "New", <FilePlus2 key="n" size={16} />],
    ["open", "Open", <FolderOpen key="o" size={16} />],
    ["save", "Save", <Save key="s" size={16} />],
    ["saveAs", "Save As", <SaveAll key="sa" size={16} />],
    ["print", "Print", <Printer key="p" size={16} />],
    ["export", "Export", <FileOutput key="e" size={16} />],
    ["options", "Options", <Settings key="op" size={16} />],
  ];
  const print = async (): Promise<void> => {
    const blob = await api.sheetExport(cx.docId, "pdf", cx.ui.docName, pdfSheets).catch(() => null);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.src = url;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        window.open(url, "_blank");
      }
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    };
    document.body.appendChild(frame);
  };
  return (
    <div className="wd-backstage" ref={root} role="dialog" aria-label={cx.tw("File")}>
      <nav className="wd-bs-nav">
        <button type="button" className="back" onClick={onClose}>
          <ArrowLeft size={16} />
          {cx.tw("Back")}
        </button>
        {nav.map(([id, label, icon]) => (
          <button key={id} type="button" className={page === id ? "on" : ""} onClick={() => setPage(id)}>
            {icon}
            {cx.tw(label)}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onClose}>
          <X size={16} />
          {cx.tw("Close")}
        </button>
      </nav>
      <div className="wd-bs-body">
        {page === "info" ? <InfoPage cx={cx} /> : null}
        {page === "new" ? (
          <>
            <h2>{cx.tw("New")}</h2>
            <div className="wd-bs-tiles">
              {SAMPLES.map(([k, l]) => (
                <button key={k} type="button" className="wd-bs-tile" onClick={() => (create(k), onClose())}>
                  <FilePlus2 size={32} />
                  <span>{cx.tw(l)}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {page === "open" ? (
          <>
            <h2>{cx.tw("Open")}</h2>
            <Row title={cx.tw("Browse")} sub={cx.tw("xlsx, xls, xlsb, ods, csv, tsv, json")}>
              <Btn variant="primary" icon={FolderOpen} onClick={() => (openFile(), onClose())}>
                {cx.tw("Browse")}
              </Btn>
            </Row>
          </>
        ) : null}
        {page === "save" || page === "saveAs" ? (
          <>
            <h2>{cx.tw(page === "save" ? "Save" : "Save As")}</h2>
            {FORMATS.map(([f, l, sub]) => (
              <Row key={f} title={cx.tw(l)} sub={sub ? cx.tw(sub) : undefined}>
                <Btn
                  variant={f === "xlsx" ? "primary" : "ghost"}
                  onClick={() => {
                    cx.ui.exportAs(f);
                    onClose();
                  }}
                >
                  {cx.tw("Save")}
                </Btn>
              </Row>
            ))}
          </>
        ) : null}
        {page === "print" ? (
          <>
            <h2>{cx.tw("Print")}</h2>
            <Row title={cx.tw("Print")} sub={cx.tw("Prints the page setup of each sheet")}>
              <select value={pdfSheets} onChange={(e) => setPdfSheets(e.target.value as "active" | "all")}>
                <option value="active">{cx.tw("Print Active Sheets")}</option>
                <option value="all">{cx.tw("Print Entire Workbook")}</option>
              </select>
              <Btn
                variant="primary"
                icon={Printer}
                onClick={() => {
                  void print();
                  onClose();
                }}
              >
                {cx.tw("Print")}
              </Btn>
              <Btn onClick={() => (cx.dialog("pageSetup"), onClose())}>{cx.tw("Page Setup")}</Btn>
            </Row>
          </>
        ) : null}
        {page === "export" ? (
          <>
            <h2>{cx.tw("Export")}</h2>
            <Row title={cx.tw("Export to PDF")} sub={cx.tw("Fixed layout, ready to share")}>
              <Btn variant="primary" onClick={() => (cx.ui.exportAs("pdf", undefined, "active"), onClose())}>
                {cx.tw("Active sheet")}
              </Btn>
              <Btn onClick={() => (cx.ui.exportAs("pdf", undefined, "all"), onClose())}>{cx.tw("Entire workbook")}</Btn>
            </Row>
            {FORMATS.filter(([f]) => f !== "pdf" && f !== "xlsx").map(([f, l]) => (
              <Row key={f} title={cx.tw(l)}>
                <Btn onClick={() => (cx.ui.exportAs(f), onClose())}>{cx.tw("Save a Copy…")}</Btn>
              </Row>
            ))}
          </>
        ) : null}
        {page === "options" ? <OptionsPage cx={cx} /> : null}
      </div>
    </div>
  );
}
