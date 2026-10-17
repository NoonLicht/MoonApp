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
  Share2,
  X,
} from "lucide-react";
import { Btn } from "@/components/ui";
import { ICONS } from "@/pages/word/ribbon/icons";
import type { Cx, Params } from "@/pages/word/ribbon/types";

export type BackstagePage =
  "new" | "open" | "info" | "save" | "saveAs" | "print" | "export" | "share" | "options";

const TEMPLATES: [string, string][] = [
  ["blank", "Blank"],
  ["letter", "Letter"],
  ["resume", "Resume"],
  ["report", "Report"],
  ["sample", "Sample"],
];

const FORMATS: [string, string, string][] = [
  ["docx", "Word Document (*.docx)", "Default Word format"],
  ["pdf", "PDF (*.pdf)", "Fixed layout, ready to share"],
  ["odt", "OpenDocument Text (*.odt)", "LibreOffice and OpenOffice"],
  ["rtf", "Rich Text Format (*.rtf)", "Opens in nearly any editor"],
  ["html", "Web Page (*.html)", ""],
  ["md", "Markdown (*.md)", ""],
  ["txt", "Plain Text (*.txt)", ""],
];

interface Props {
  cx: Cx;
  page: BackstagePage;
  setPage: (p: BackstagePage) => void;
  onClose: () => void;
  create: (template: string) => void;
  openFile: () => void;
  prefs: { draw: boolean; developer: boolean };
  setPrefs: (p: { draw: boolean; developer: boolean }) => void;
  print: () => void;
}

function Row({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
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
  keywords?: string;
  comments?: string;
  category?: string;
}

function InfoPage({ cx }: { cx: Cx }) {
  const [p, setP] = useState<Props2>({});
  const [inspect, setInspect] = useState<{ found?: Record<string, number> } | null>(null);
  const [versions, setVersions] = useState<{ label: string; date: string }[]>([]);
  const [pwd, setPwd] = useState("");
  const load = (): void => {
    void cx.call("file.properties", {}).then((r) => setP((r as Props2) ?? {}));
    void cx
      .call("file.versions", {})
      .then((r) => setVersions(Array.isArray(r) ? (r as { label: string; date: string }[]) : []));
  };
  useEffect(load, [cx]);
  const save = (k: keyof Props2, v: string): void => {
    setP((o) => ({ ...o, [k]: v }));
  };
  const fields: [keyof Props2, string][] = [
    ["title", "Title"],
    ["subject", "Subject"],
    ["author", "Author"],
    ["keywords", "Keywords"],
    ["category", "Category"],
    ["comments", "Comments"],
  ];
  return (
    <>
      <h2>{cx.tw("Info")}</h2>
      <Row
        title={cx.tw("Protect Document")}
        sub={cx.tw("Control what types of changes people can make")}
      >
        <Btn onClick={() => cx.dialog("restrict")}>{cx.tw("Restrict Editing")}</Btn>
        <input
          type="text"
          value={pwd}
          placeholder={cx.tw("Password")}
          onChange={(e) => setPwd(e.target.value)}
          style={{ width: 150 }}
        />
        <Btn
          disabled={!pwd}
          onClick={() => (cx.run("file.encrypt", { password: pwd }), setPwd(""))}
        >
          {cx.tw("Encrypt with Password")}
        </Btn>
      </Row>
      <Row
        title={cx.tw("Inspect Document")}
        sub={cx.tw("Check the document for hidden properties or personal information")}
      >
        <Btn
          onClick={() =>
            void cx
              .call("file.inspect", {})
              .then((r) => setInspect(r as { found?: Record<string, number> }))
          }
        >
          {cx.tw("Inspect Document")}
        </Btn>
        <Btn onClick={() => cx.ui.togglePane("accessibility", true)}>
          {cx.tw("Check Accessibility")}
        </Btn>
        {inspect?.found ? (
          <Btn
            onClick={() => {
              cx.run("file.inspect", { remove: Object.keys(inspect.found ?? {}) });
              setInspect(null);
            }}
          >
            {cx.tw("Remove All")}
          </Btn>
        ) : null}
      </Row>
      {inspect?.found ? (
        <div className="wd-muted">
          {Object.entries(inspect.found)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}
        </div>
      ) : null}
      <Row
        title={cx.tw("Version History")}
        sub={versions.length ? `${versions.length}` : cx.tw("No saved versions")}
      >
        <Btn
          onClick={() => {
            cx.run("file.versions", { save: new Date().toLocaleString() });
            setTimeout(load, 300);
          }}
        >
          {cx.tw("Save version")}
        </Btn>
        {versions.map((v, i) => (
          <Btn key={i} onClick={() => cx.run("file.versions", { restore: i })}>
            {v.label}
          </Btn>
        ))}
      </Row>
      <h2 style={{ fontSize: 16, marginTop: 8 }}>{cx.tw("Properties")}</h2>
      <div className="wd-bs-props">
        {fields.map(([k, label]) => (
          <div key={k} style={{ display: "contents" }}>
            <span className="lbl">{cx.tw(label)}</span>
            <input
              type="text"
              value={p[k] ?? ""}
              onChange={(e) => save(k, e.target.value)}
              onBlur={() => cx.run("file.properties", { [k]: p[k] ?? "" })}
            />
          </div>
        ))}
      </div>
    </>
  );
}

interface Opts {
  author?: string;
  initials?: string;
  checkSpelling?: boolean;
  markGrammar?: boolean;
  ignoreUppercase?: boolean;
  ignoreNumbers?: boolean;
  ignoreInternet?: boolean;
  overtype?: boolean;
  insertKeyOvertype?: boolean;
  marks?: { tabs?: boolean; spaces?: boolean; paragraphs?: boolean; hidden?: boolean };
  units?: string;
  typingReplacesSelection?: boolean;
}

function OptionsPage({
  cx,
  prefs,
  setPrefs,
}: {
  cx: Cx;
  prefs: { draw: boolean; developer: boolean };
  setPrefs: (p: { draw: boolean; developer: boolean }) => void;
}) {
  const [o, setO] = useState<Opts>({});
  const [ac, setAc] = useState<Record<string, boolean>>({});
  const load = (): void => {
    void cx.call("file.options", { author: undefined }).then((r) => setO((r as Opts) ?? {}));
    void cx.call("tools.autocorrect", {}).then((r) => setAc((r as Record<string, boolean>) ?? {}));
  };
  useEffect(load, [cx]);
  const set = (p: Params): void => {
    setO((x) => ({ ...x, ...p }));
    cx.run("file.options", p);
  };
  const chk = (label: string, key: keyof Opts): JSX.Element => (
    <label className="wd-chk" key={key}>
      <input
        type="checkbox"
        checked={!!o[key]}
        onChange={(e) => set({ [key]: e.target.checked })}
      />
      <span>{cx.tw(label)}</span>
    </label>
  );
  const acKeys: [string, string][] = [
    ["replaceText", "Replace text as you type"],
    ["smartQuotes", "Straight quotes with smart quotes"],
    ["capSentences", "Capitalize first letter of sentences"],
    ["twoInitialCaps", "Correct TWo INitial CApitals"],
    ["dashes", "Hyphens (--) with dash (—)"],
    ["fractions", "Fractions (1/2) with fraction character (½)"],
  ];
  return (
    <>
      <h2>{cx.tw("Options")}</h2>
      <h3 style={{ margin: 0 }}>{cx.tw("General")}</h3>
      <div className="wd-bs-props">
        <span className="lbl">{cx.tw("User name")}</span>
        <input
          type="text"
          value={o.author ?? ""}
          onChange={(e) => setO({ ...o, author: e.target.value })}
          onBlur={() => cx.run("file.options", { author: o.author })}
        />
        <span className="lbl">{cx.tw("Initials")}</span>
        <input
          type="text"
          value={o.initials ?? ""}
          onChange={(e) => setO({ ...o, initials: e.target.value })}
          onBlur={() => cx.run("file.options", { initials: o.initials })}
        />
        <span className="lbl">{cx.tw("Measurement units")}</span>
        <select value={o.units ?? "auto"} onChange={(e) => set({ units: e.target.value })}>
          {[
            ["auto", "Automatic"],
            ["centimeters", "Centimeters"],
            ["millimeters", "Millimeters"],
            ["inches", "Inches"],
            ["points", "Points"],
            ["picas", "Picas"],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {cx.tw(l)}
            </option>
          ))}
        </select>
      </div>
      <h3 style={{ margin: "8px 0 0" }}>{cx.tw("Proofing")}</h3>
      {chk("Check Spelling as You Type", "checkSpelling")}
      {chk("Mark grammar errors as you type", "markGrammar")}
      {chk("Ignore words in UPPERCASE", "ignoreUppercase")}
      {chk("Ignore words that contain numbers", "ignoreNumbers")}
      {chk("Ignore Internet and file addresses", "ignoreInternet")}
      <h3 style={{ margin: "8px 0 0" }}>{cx.tw("AutoCorrect Options")}</h3>
      {acKeys.map(([k, l]) => (
        <label className="wd-chk" key={k}>
          <input
            type="checkbox"
            checked={!!ac[k]}
            onChange={(e) => {
              setAc((x) => ({ ...x, [k]: e.target.checked }));
              cx.run("tools.autocorrect", { [k]: e.target.checked });
            }}
          />
          <span>{cx.tw(l)}</span>
        </label>
      ))}
      <h3 style={{ margin: "8px 0 0" }}>{cx.tw("Advanced")}</h3>
      {chk("Typing replaces selected text", "typingReplacesSelection")}
      {chk("Use the Insert key to control overtype mode", "insertKeyOvertype")}
      <h3 style={{ margin: "8px 0 0" }}>{cx.tw("Customize Ribbon")}</h3>
      <label className="wd-chk">
        <input
          type="checkbox"
          checked={prefs.draw}
          onChange={(e) => setPrefs({ ...prefs, draw: e.target.checked })}
        />
        <span>{cx.tw("Draw")}</span>
      </label>
      <label className="wd-chk">
        <input
          type="checkbox"
          checked={prefs.developer}
          onChange={(e) => setPrefs({ ...prefs, developer: e.target.checked })}
        />
        <span>{cx.tw("Developer")}</span>
      </label>
    </>
  );
}

/** Меню «Файл»: создание, открытие, сведения, сохранение, печать, экспорт, параметры. */
export default function Backstage({
  cx,
  page,
  setPage,
  onClose,
  create,
  openFile,
  prefs,
  setPrefs,
  print,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  const nav: [BackstagePage, string, JSX.Element][] = [
    ["info", "Info", <Info key="i" size={16} />],
    ["new", "New", <FilePlus2 key="n" size={16} />],
    ["open", "Open", <FolderOpen key="o" size={16} />],
    ["save", "Save", <Save key="s" size={16} />],
    ["saveAs", "Save As", <SaveAll key="sa" size={16} />],
    ["print", "Print", <Printer key="p" size={16} />],
    ["share", "Share", <Share2 key="sh" size={16} />],
    ["export", "Export", <FileOutput key="e" size={16} />],
    ["options", "Options", <Settings key="op" size={16} />],
  ];
  const Ic = ICONS.newDoc;
  void Ic;
  return (
    <div className="wd-backstage" ref={root} role="dialog" aria-label={cx.tw("File")}>
      <nav className="wd-bs-nav">
        <button type="button" className="back" onClick={onClose}>
          <ArrowLeft size={16} />
          {cx.tw("Back")}
        </button>
        {nav.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={page === id ? "on" : ""}
            onClick={() => setPage(id)}
          >
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
              {TEMPLATES.map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  className="wd-bs-tile"
                  onClick={() => (create(k), onClose())}
                >
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
            <Row title={cx.tw("Browse")} sub={cx.tw("docx, doc, odt, rtf, html, md, txt")}>
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
                  variant={f === "docx" ? "primary" : "ghost"}
                  onClick={() => {
                    if (page === "save" && f === "docx") {
                      cx.ui.exportAs("docx");
                      onClose();
                    } else {
                      cx.dialog("saveAs", { format: f });
                      onClose();
                    }
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
            <Row title={cx.tw("Print")} sub={cx.tw("{n} pages", { n: cx.s.pages.length })}>
              <Btn
                variant="primary"
                icon={Printer}
                onClick={() => {
                  print();
                  onClose();
                }}
              >
                {cx.tw("Print")}
              </Btn>
            </Row>
            <Row
              title={cx.tw("Print Markup")}
              sub={cx.tw("Show tracked changes and comments in PDFs and prints")}
            >
              <Btn onClick={() => cx.run("file.printMarkup")}>{cx.tw("Print Markup")}</Btn>
            </Row>
          </>
        ) : null}
        {page === "share" || page === "export" ? (
          <>
            <h2>{cx.tw(page === "share" ? "Share" : "Export")}</h2>
            <Row title={cx.tw("Export PDF")} sub={cx.tw("Fixed layout, ready to share")}>
              <Btn variant="primary" onClick={() => (cx.dialog("exportPdf"), onClose())}>
                {cx.tw("Export PDF")}
              </Btn>
            </Row>
            {FORMATS.filter(([f]) => f !== "pdf").map(([f, l]) => (
              <Row key={f} title={cx.tw(l)}>
                <Btn onClick={() => (cx.dialog("saveAs", { format: f }), onClose())}>
                  {cx.tw("Save a Copy…")}
                </Btn>
              </Row>
            ))}
          </>
        ) : null}
        {page === "options" ? <OptionsPage cx={cx} prefs={prefs} setPrefs={setPrefs} /> : null}
      </div>
    </div>
  );
}
