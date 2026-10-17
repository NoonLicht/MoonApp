import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { getOverlayRoot } from "@/components/overlayHost";
import { Btn } from "@/components/ui";
import { Shell } from "@/pages/word/dialogs/form";
import type { Cx, Params } from "@/pages/word/ribbon/types";

export interface DlgProps {
  cx: Cx;
  props: Params;
  onClose: () => void;
}

/* ---------------- Символ ---------------- */

const RANGES: [string, number, number][] = [
  ["Basic Latin", 0x20, 0x7e],
  ["Latin-1 Supplement", 0xa0, 0xff],
  ["Latin Extended-A", 0x100, 0x17f],
  ["Greek and Coptic", 0x370, 0x3ff],
  ["Cyrillic", 0x400, 0x4ff],
  ["General Punctuation", 0x2000, 0x206f],
  ["Currency Symbols", 0x20a0, 0x20cf],
  ["Letterlike Symbols", 0x2100, 0x214f],
  ["Number Forms", 0x2150, 0x218f],
  ["Arrows", 0x2190, 0x21ff],
  ["Mathematical Operators", 0x2200, 0x22ff],
  ["Miscellaneous Technical", 0x2300, 0x23ff],
  ["Box Drawing", 0x2500, 0x257f],
  ["Geometric Shapes", 0x25a0, 0x25ff],
  ["Miscellaneous Symbols", 0x2600, 0x26ff],
  ["Dingbats", 0x2700, 0x27bf],
];

const RECENT_KEY = "moonapp.word.recentSymbols";
const recent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as string[];
  } catch {
    return [];
  }
};

export function SymbolDialog({ cx, onClose }: DlgProps) {
  const [range, setRange] = useState(0);
  const [sel, setSel] = useState("");
  const [font, setFont] = useState("");
  const [rec, setRec] = useState<string[]>(recent);
  const chars = useMemo(() => {
    const [, a, b] = RANGES[range];
    return Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i));
  }, [range]);
  const insert = (c: string): void => {
    cx.run("insert.symbol", font ? { char: c, font } : { char: c });
    const next = [c, ...rec.filter((x) => x !== c)].slice(0, 16);
    setRec(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* без истории */
    }
  };
  return (
    <Shell
      title={cx.tw("Symbol")}
      onClose={onClose}
      size="wide"
      foot={
        <>
          <Btn variant="primary" disabled={!sel} onClick={() => insert(sel)}>
            {cx.tw("Insert")}
          </Btn>
          <Btn onClick={onClose}>{cx.tw("Close")}</Btn>
        </>
      }
    >
      <div className="wd-form" style={{ gridTemplateColumns: "auto 1fr auto 1fr" }}>
        <span className="lbl">{cx.tw("Font:")}</span>
        <select value={font} onChange={(e) => setFont(e.target.value)}>
          <option value="">{cx.tw("(normal text)")}</option>
          {cx.ui.fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <span className="lbl">{cx.tw("Subset:")}</span>
        <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
          {RANGES.map(([n], i) => (
            <option key={n} value={i}>
              {cx.tw(n)}
            </option>
          ))}
        </select>
      </div>
      <div className="wd-symtable" style={{ fontFamily: font ? `"${font}"` : undefined }}>
        {chars.map((c) => (
          <button
            key={c}
            type="button"
            className={sel === c ? "on" : ""}
            onClick={() => setSel(c)}
            onDoubleClick={() => insert(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {rec.length ? (
        <div>
          <div className="wd-muted" style={{ marginBottom: 4 }}>
            {cx.tw("Recently used symbols:")}
          </div>
          <div
            className="wd-symtable"
            style={{ gridTemplateColumns: "repeat(16, 1fr)", maxHeight: 70 }}
          >
            {rec.map((c) => (
              <button
                key={c}
                type="button"
                className={sel === c ? "on" : ""}
                onClick={() => setSel(c)}
                onDoubleClick={() => insert(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {sel ? (
        <div className="wd-muted">
          U+{sel.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}
        </div>
      ) : null}
    </Shell>
  );
}

/* ---------------- Найти и заменить (плавающая панель) ---------------- */

type FindTab = "find" | "replace" | "goto";

export function FindDialog({ cx, props, onClose }: DlgProps & { initial?: FindTab }) {
  const initial =
    (props.tab as FindTab) ||
    (props.name === "replace" ? "replace" : props.name === "goto" ? "goto" : "find");
  const [tab, setTab] = useState<FindTab>(initial);
  const [text, setText] = useState(cx.s.selection.text.split("\n")[0].slice(0, 80));
  const [rep, setRep] = useState("");
  const [o, setO] = useState({
    matchCase: false,
    wholeWord: false,
    wildcards: false,
    regex: false,
  });
  const [info, setInfo] = useState("");
  const [gotoKind, setGotoKind] = useState("page");
  const [gotoVal, setGotoVal] = useState("1");
  const opts = (): Params => ({
    text,
    matchCase: o.matchCase,
    wholeWord: o.wholeWord,
    wildcards: o.wildcards,
    regex: o.regex,
  });

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);

  const count = async (): Promise<void> => {
    const r = (await cx.call("edit.find", opts())) as { count?: number } | undefined;
    setInfo(r && typeof r.count === "number" ? cx.tw("Found {n}", { n: r.count }) : "");
  };
  const checks: [keyof typeof o, string][] = [
    ["matchCase", "Match case"],
    ["wholeWord", "Find whole words only"],
    ["wildcards", "Use wildcards"],
    ["regex", "Use regular expressions"],
  ];
  return createPortal(
    <div
      className="wd-minitb"
      style={{
        right: 28,
        top: 140,
        flexDirection: "column",
        alignItems: "stretch",
        gap: 8,
        padding: 10,
        width: 360,
        zIndex: 1260,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {(["find", "replace", "goto"] as FindTab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`wd-mini${tab === t ? " on" : ""}`}
            style={tab === t ? { borderColor: "var(--amber)" } : undefined}
            onClick={() => setTab(t)}
          >
            {cx.tw(t === "find" ? "Find" : t === "replace" ? "Replace" : "Go To")}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="wd-x-btn" onClick={onClose} aria-label={cx.tw("Close")}>
          <X size={14} />
        </button>
      </div>
      {tab !== "goto" ? (
        <>
          <input
            type="text"
            value={text}
            placeholder={cx.tw("Find what:")}
            data-autofocus=""
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                cx.run(e.shiftKey ? "edit.findPrevious" : "edit.findNext", opts());
            }}
          />
          {tab === "replace" ? (
            <input
              type="text"
              value={rep}
              placeholder={cx.tw("Replace with:")}
              onChange={(e) => setRep(e.target.value)}
            />
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px" }}>
            {checks.map(([k, label]) => (
              <label key={k} className="wd-chk" style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={o[k]}
                  onChange={(e) => setO({ ...o, [k]: e.target.checked })}
                />
                <span>{cx.tw(label)}</span>
              </label>
            ))}
          </div>
          <div className="wd-actions" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              type="button"
              className="wd-mini"
              disabled={!text}
              onClick={() => cx.run("edit.findPrevious", opts())}
            >
              {cx.tw("Find Previous")}
            </button>
            <button
              type="button"
              className="wd-mini"
              disabled={!text}
              onClick={() => cx.run("edit.findNext", opts())}
            >
              {cx.tw("Find Next")}
            </button>
            <button type="button" className="wd-mini" disabled={!text} onClick={() => void count()}>
              {cx.tw("Find All")}
            </button>
            {tab === "replace" ? (
              <>
                <button
                  type="button"
                  className="wd-mini"
                  disabled={!text}
                  onClick={() => cx.run("edit.replace", { ...opts(), with: rep })}
                >
                  {cx.tw("Replace")}
                </button>
                <button
                  type="button"
                  className="wd-mini"
                  disabled={!text}
                  onClick={() => {
                    cx.run("edit.replaceAll", { ...opts(), with: rep });
                    setInfo("");
                  }}
                >
                  {cx.tw("Replace All")}
                </button>
              </>
            ) : null}
          </div>
          {info ? <div className="wd-muted">{info}</div> : null}
        </>
      ) : (
        <>
          <select value={gotoKind} onChange={(e) => setGotoKind(e.target.value)}>
            <option value="page">{cx.tw("Page")}</option>
            <option value="paragraph">{cx.tw("Paragraph")}</option>
            <option value="bookmark">{cx.tw("Bookmark")}</option>
          </select>
          <input type="text" value={gotoVal} onChange={(e) => setGotoVal(e.target.value)} />
          <button
            type="button"
            className="wd-mini"
            onClick={() =>
              cx.run(
                "edit.goto",
                gotoKind === "bookmark"
                  ? { bookmark: gotoVal }
                  : { [gotoKind]: Number(gotoVal) || 1 },
              )
            }
          >
            {cx.tw("Go To")}
          </button>
        </>
      )}
    </div>,
    getOverlayRoot() ?? document.body,
  );
}

/* ---------------- Ссылка ---------------- */

interface Targets {
  bookmarks: string[];
  headings: { block: number; level: number; text: string }[];
  top: boolean;
}

export function LinkDialog({ cx, onClose }: DlgProps) {
  const [tab, setTab] = useState(0);
  const [url, setUrl] = useState("https://");
  const [label, setLabel] = useState(cx.s.selection.text.slice(0, 120));
  const [mail, setMail] = useState("");
  const [subject, setSubject] = useState("");
  const [targets, setTargets] = useState<Targets | null>(null);
  const [pick, setPick] = useState("top");
  useEffect(() => {
    void cx.call("link.targets", {}).then((r) => setTargets(r as Targets));
  }, [cx]);
  const ok = (): void => {
    const text = label || undefined;
    if (tab === 0) cx.run("insert.link", { url, text });
    else if (tab === 2)
      cx.run("insert.link", {
        url: `mailto:${mail}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`,
        text: text ?? mail,
      });
    else if (pick === "top") cx.run("insert.link", { top: true, text });
    else if (pick.startsWith("b:")) cx.run("insert.link", { bookmark: pick.slice(2), text });
    else cx.run("insert.link", { heading: Number(pick.slice(2)), text });
    onClose();
  };
  return (
    <Shell
      title={cx.tw("Link")}
      onClose={onClose}
      size="wide"
      tabs={[
        cx.tw("Existing File or Web Page"),
        cx.tw("Place in This Document"),
        cx.tw("E-mail Address"),
      ]}
      tab={tab}
      setTab={setTab}
      foot={
        <>
          <Btn onClick={() => (cx.run("insert.removeLink"), onClose())}>
            {cx.tw("Remove Hyperlink")}
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn variant="primary" onClick={ok}>
            {cx.tw("OK")}
          </Btn>
        </>
      }
    >
      <div className="wd-form">
        <span className="lbl">{cx.tw("Text to display:")}</span>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        {tab === 0 ? (
          <>
            <span className="lbl">{cx.tw("Address:")}</span>
            <input
              type="text"
              value={url}
              data-autofocus=""
              onChange={(e) => setUrl(e.target.value)}
            />
          </>
        ) : null}
        {tab === 2 ? (
          <>
            <span className="lbl">{cx.tw("E-mail address:")}</span>
            <input type="text" value={mail} onChange={(e) => setMail(e.target.value)} />
            <span className="lbl">{cx.tw("Subject:")}</span>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </>
        ) : null}
        {tab === 1 ? (
          <div className="full wd-list">
            <button
              type="button"
              className={pick === "top" ? "on" : ""}
              onClick={() => setPick("top")}
            >
              {cx.tw("Top of the Document")}
            </button>
            {(targets?.headings ?? []).map((h) => (
              <button
                key={h.block}
                type="button"
                className={pick === `h:${h.block}` ? "on" : ""}
                style={{ paddingLeft: 10 + (h.level - 1) * 14 }}
                onClick={() => setPick(`h:${h.block}`)}
              >
                {h.text}
              </button>
            ))}
            {(targets?.bookmarks ?? []).map((b) => (
              <button
                key={b}
                type="button"
                className={pick === `b:${b}` ? "on" : ""}
                onClick={() => setPick(`b:${b}`)}
              >
                {b}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

/* ---------------- Закладка ---------------- */

export function BookmarkDialog({ cx, onClose }: DlgProps) {
  const [name, setName] = useState("");
  const [list, setList] = useState<string[]>([]);
  const [sel, setSel] = useState("");
  const load = (): void => {
    void cx
      .call("link.targets", {})
      .then((r) => setList(((r as Targets | undefined)?.bookmarks ?? []).slice().sort()));
  };
  useEffect(load, [cx]);
  return (
    <Shell
      title={cx.tw("Bookmark")}
      onClose={onClose}
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Close")}</Btn>
        </>
      }
    >
      <div className="wd-form" style={{ gridTemplateColumns: "1fr auto" }}>
        <input
          type="text"
          value={name}
          placeholder={cx.tw("Bookmark name:")}
          data-autofocus=""
          onChange={(e) => setName(e.target.value.replace(/\s+/g, "_"))}
        />
        <Btn
          variant="primary"
          disabled={!name}
          onClick={() => {
            cx.run("insert.bookmark", { name });
            setName("");
            setTimeout(load, 300);
          }}
        >
          {cx.tw("Add")}
        </Btn>
      </div>
      <div className="wd-list">
        {list.length === 0 ? (
          <div className="wd-muted" style={{ padding: 10 }}>
            {cx.tw("No bookmarks yet.")}
          </div>
        ) : null}
        {list.map((b) => (
          <button
            key={b}
            type="button"
            className={sel === b ? "on" : ""}
            onClick={() => setSel(b)}
            onDoubleClick={() => cx.run("edit.goto", { bookmark: b })}
          >
            {b}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn disabled={!sel} onClick={() => cx.run("edit.goto", { bookmark: sel })}>
          {cx.tw("Go To")}
        </Btn>
        <Btn
          disabled={!sel}
          onClick={() => {
            cx.run("insert.deleteBookmark", { name: sel });
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

/* ---------------- Перекрёстная ссылка ---------------- */

const XREF_TYPES: [string, string][] = [
  ["heading", "Heading"],
  ["bookmark", "Bookmark"],
  ["figure", "Figure"],
  ["table", "Table"],
  ["equation", "Equation"],
];

export function CrossRefDialog({ cx, onClose }: DlgProps) {
  const [to, setTo] = useState("heading");
  const [show, setShow] = useState("text");
  const [list, setList] = useState<string[]>([]);
  const [sel, setSel] = useState("");
  useEffect(() => {
    let alive = true;
    void cx.call("insert.crossReference", { to }).then((r) => {
      if (alive)
        setList(
          Array.isArray(r)
            ? (r as unknown[]).map((x) =>
                typeof x === "string" ? x : String((x as { text?: string }).text ?? ""),
              )
            : [],
        );
    });
    setSel("");
    return () => {
      alive = false;
    };
  }, [cx, to]);
  return (
    <Shell
      title={cx.tw("Cross-reference")}
      onClose={onClose}
      size="wide"
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Close")}</Btn>
          <Btn
            variant="primary"
            disabled={!sel}
            onClick={() => {
              cx.run("insert.crossReference", { to, target: sel, show });
              onClose();
            }}
          >
            {cx.tw("Insert")}
          </Btn>
        </>
      }
    >
      <div className="wd-form">
        <span className="lbl">{cx.tw("Reference type:")}</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {XREF_TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {cx.tw(l)}
            </option>
          ))}
        </select>
        <span className="lbl">{cx.tw("Insert reference to:")}</span>
        <select value={show} onChange={(e) => setShow(e.target.value)}>
          <option value="text">{cx.tw("Heading text")}</option>
          <option value="page">{cx.tw("Page number")}</option>
          <option value="number">{cx.tw("Paragraph number")}</option>
          <option value="aboveBelow">{cx.tw("Above/below")}</option>
        </select>
      </div>
      <div className="wd-list">
        {list.length === 0 ? (
          <div className="wd-muted" style={{ padding: 10 }}>
            {cx.tw("Nothing to refer to.")}
          </div>
        ) : null}
        {list.map((t) => (
          <button key={t} type="button" className={sel === t ? "on" : ""} onClick={() => setSel(t)}>
            {t}
          </button>
        ))}
      </div>
    </Shell>
  );
}
