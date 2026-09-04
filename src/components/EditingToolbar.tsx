import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Undo2, Redo2, Paintbrush, Eraser,
  Heading1, Heading2, Heading3,
  Bold, Italic, Strikethrough, Underline,
  Highlighter, ClipboardPaste, Paperclip, Table2, CheckSquare,
  Quote, MessageSquare, Code2, Link, Minus, FunctionSquare,
  List, ListOrdered, ListChecks, IndentIncrease, IndentDecrease,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Type, Pen, ChevronDown,
  Copy, Scissors, Clipboard, ClipboardList,
  WrapText, ArrowUpFromLine, ArrowDownToLine,
  Hash, TextQuote, Braces, Sigma, Variable, FileText,
} from "lucide-react";

/* ─── Types ─── */
export interface EditingToolbarProps {
  onFormat: (type: string, value?: string, selectionRange?: {start:number;end:number;text:string}) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onAttach?: () => void;
  isDisabled?: boolean;
}

/* ─── Theme / swatches ─── */
const THEME_COLORS = [
  "#f0a63d", "#8b7bf0", "#3fc7ab", "#ea6b6b",
  "#a9a8bb", "#f1f0f6",
];
const STANDARD_COLORS = [
  "#000000", "#ffffff", "#e03131", "#2f9e44",
  "#1971c2", "#f08c00", "#9c36b5", "#fd7e14",
];
const HIGHLIGHTER_COLORS = [
  "#fbe46588", "#99e9b688", "#7fc3ed88", "#faa2c188", "#ffd8a888",
];
const TRANSLUCENT_COLORS = [
  "rgba(240,166,61,0.25)", "rgba(139,123,240,0.25)", "rgba(63,199,171,0.25)", "rgba(234,107,107,0.25)",
  "rgba(241,240,246,0.15)", "rgba(169,168,187,0.25)",
];
/* ─── Reusable sub-components ─── */

const sepStyle: React.CSSProperties = {
  width: 1, height: 20, background: "var(--glass-border)", flexShrink: 0, margin: "0 2px",
};
function Sep() { return <div style={sepStyle} />; }

interface TBtnProps {
  icon: React.ElementType;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  size?: number;
  style?: React.CSSProperties;
}

function TBtn({ icon: Icon, active, disabled, title, onClick, size = 15, style }: TBtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: active ? "var(--amber-soft)" : "transparent",
        border: active ? "1px solid rgba(240,166,61,0.35)" : "1px solid transparent",
        borderRadius: 6,
        width: 30,
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: active ? "var(--amber)" : "var(--text-tertiary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        flexShrink: 0,
        padding: 0,
        transition: "background 0.1s, color 0.1s, border-color 0.1s",
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled && !active) {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--track)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-tertiary)";
        }
      }}
    >
      <Icon size={size} strokeWidth={2} />
    </button>
  );
}

function DropdownItemBtn({ icon: Icon, label, active, onClick }: {
  icon: React.ElementType; label: string; active?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "5px 10px",
        background: active ? "var(--amber-soft)" : "transparent",
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        color: active ? "var(--amber)" : "var(--text-secondary)",
        fontSize: 12,
        fontFamily: "var(--font-body)",
        textAlign: "left",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--track)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = active ? "var(--amber-soft)" : "transparent"; (e.currentTarget as HTMLButtonElement).style.color = active ? "var(--amber)" : "var(--text-secondary)"; }}
    >
      <Icon size={14} strokeWidth={2} />
      <span>{label}</span>
    </button>
  );
}
/* ─── Color Picker Dropdown ─── */
function ColorPickerDropdown({
  open, onToggle, onClose, currentColor, onChange, mode,
}: {
  open: boolean; onToggle: () => void; onClose: () => void;
  currentColor: string; onChange: (c: string) => void; mode: "text" | "bg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  const presetSwatches = mode === "text" ? THEME_COLORS : TRANSLUCENT_COLORS;
  const extraSwatches = mode === "text" ? STANDARD_COLORS : HIGHLIGHTER_COLORS;
  const label = mode === "text" ? "Font Colors" : "Background Color";

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={onToggle}
        title={label}
        style={{
          background: open ? "var(--track)" : "transparent",
          border: open ? "1px solid var(--glass-border)" : "1px solid transparent",
          borderRadius: 6,
          width: 30,
          height: 28,
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
          padding: 0,
          position: "relative",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = "var(--track)"; }}
        onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        {mode === "text" ? <Type size={14} strokeWidth={2} color="var(--text-tertiary)" /> : <Pen size={14} strokeWidth={2} color="var(--text-tertiary)" />}
        <div style={{ width: 16, height: 3, borderRadius: 2, background: currentColor, marginTop: 1 }} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: "100%", marginTop: 4, right: 0,
            zIndex: 1000, background: "var(--surface-solid)",
            border: "1px solid var(--glass-border)", borderRadius: 10,
            boxShadow: "var(--shadow)", padding: 10, minWidth: 180,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            {label}
          </div>
          <div style={{ marginBottom: 4, fontSize: 10, color: "var(--text-tertiary)" }}>
            {mode === "text" ? "Theme Colors" : "Translucent"}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            {presetSwatches.map((c) => (
              <button key={c} onClick={() => { onChange(c); onClose(); }}
                style={{ width: 22, height: 22, borderRadius: "50%", background: c,
                  border: currentColor === c ? "2px solid var(--amber)" : "1px solid var(--glass-border)",
                  cursor: "pointer", padding: 0 }}
              />
            ))}
          </div>
          <div style={{ marginBottom: 4, fontSize: 10, color: "var(--text-tertiary)" }}>
            {mode === "text" ? "Standard Colors" : "Highlighters"}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            {extraSwatches.map((c) => (
              <button key={c} onClick={() => { onChange(c); onClose(); }}
                style={{ width: 22, height: 22, borderRadius: "50%", background: c,
                  border: currentColor === c ? "2px solid var(--amber)" : "1px solid var(--glass-border)",
                  cursor: "pointer", padding: 0 }}
              />
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, borderTop: "1px solid var(--glass-border)", paddingTop: 8 }}>
            <input type="color" value={currentColor || "#f0a63d"}
              onChange={(e) => { onChange(e.target.value); onClose(); }}
              style={{ width: 28, height: 28, border: "none", borderRadius: 6, cursor: "pointer", padding: 0, background: "none" }}
              title="Color Picker" />
            <button onClick={() => { onChange(""); onClose(); }}
              style={{ background: "transparent", border: "1px solid var(--glass-border)", borderRadius: 6,
                padding: "4px 8px", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 11,
                fontFamily: "var(--font-body)", display: "flex", alignItems: "center", gap: 4 }}
              title="Reset">
              <Minus size={12} /> Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
/* ─── Dropdown wrapper ─── */
function DropdownMenu({ trigger, children, open, onToggle, onClose, alignRight }: {
  trigger: React.ReactNode; children: React.ReactNode;
  open: boolean; onToggle: () => void; onClose: () => void; alignRight?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      {trigger}
      {open && (
        <div style={{
          position: "absolute", top: "100%", marginTop: 4,
          [alignRight ? "right" : "left"]: 0, zIndex: 1000,
          background: "var(--surface-solid)", border: "1px solid var(--glass-border)",
          borderRadius: 10, boxShadow: "var(--shadow)", padding: 4, minWidth: 160,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownBtn({ icon: Icon, open, onClick, title }: {
  icon: React.ElementType; open: boolean; onClick: () => void; title?: string;
}) {
  return (
    <button onClick={onClick} title={title}
      style={{
        background: open ? "var(--track)" : "transparent",
        border: open ? "1px solid var(--glass-border)" : "1px solid transparent",
        borderRadius: 6, display: "inline-flex", alignItems: "center", gap: 1,
        height: 28, cursor: "pointer", flexShrink: 0, padding: "0 4px",
        transition: "background 0.1s",
      }}
    >
      <Icon size={14} strokeWidth={2} color="var(--text-tertiary)" />
      <ChevronDown size={10} strokeWidth={2.5} color="var(--text-tertiary)" />
    </button>
  );
}
/* ─── Main EditingToolbar ─── */
export default function EditingToolbar({ onFormat, onUndo, onRedo, onAttach, isDisabled }: EditingToolbarProps) {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [activeFormats] = useState<Set<string>>(new Set());
  const [textColor, setTextColor] = useState("#f0a63d");
  const [bgColor, setBgColor] = useState("rgba(240,166,61,0.25)");
  const savedSel = useRef<{start:number;end:number;text:string}>({start:0,end:0,text:""});
  const captureSel = useCallback(() => {
    const ta = document.querySelector(".ms-edit-textarea") as HTMLTextAreaElement;
    if (ta) { savedSel.current = { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.substring(ta.selectionStart, ta.selectionEnd) }; }
  }, []);

  const closeDropdown = useCallback(() => setOpenDropdown(null), []);
  const fmt = useCallback((type: string, value?: string) => {
    if (type==="textColor"||type==="bgColor"||type==="highlight") onFormat(type, value, savedSel.current);
    else onFormat(type, value);
    closeDropdown();
  }, [onFormat, closeDropdown]);

  const toggleDropdown = (id: string) => { captureSel(); setOpenDropdown(prev => prev === id ? null : id); };

  const containerStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 3, padding: "5px 8px",
    background: "var(--glass)", border: "1px solid var(--glass-border)",
    borderRadius: 10, backdropFilter: "blur(8px)",
    flexShrink: 0, overflow: "visible",
    width: "100%", minHeight: 38, boxSizing: "border-box" as const,
    flexWrap: "nowrap" as const,
  };

  return (
    <div style={containerStyle}>
      {/* ── Undo / Redo / Format Painter / Clear ── */}
      <TBtn icon={Undo2} title="Undo" onClick={() => onUndo?.()} disabled={isDisabled} size={14} />
      <TBtn icon={Redo2} title="Redo" onClick={() => onRedo?.()} disabled={isDisabled} size={14} />
      <TBtn icon={Paintbrush} title="Format Painter" onClick={() => fmt("formatPainter")} disabled={isDisabled} size={14} />
      <TBtn icon={Eraser} title="Clear Formatting" onClick={() => fmt("clearFormatting")} disabled={isDisabled} size={14} />
      <Sep />

      {/* ── Headings ── */}
      <TBtn icon={Heading2} title="Heading 2" active={activeFormats.has("h2")} onClick={() => fmt("h2")} disabled={isDisabled} />
      <TBtn icon={Heading3} title="Heading 3" active={activeFormats.has("h3")} onClick={() => fmt("h3")} disabled={isDisabled} />
      <DropdownMenu
        open={openDropdown === "heading"} onToggle={() => toggleDropdown("heading")} onClose={closeDropdown}
        trigger={<DropdownBtn icon={Heading1} open={openDropdown === "heading"} onClick={() => toggleDropdown("heading")} title="More headings" />}
      >
        {(["h1","h4","h5","h6"] as const).map((h) => (
          <DropdownItemBtn key={h}
            icon={({ h1: Heading1, h4: Hash, h5: Hash, h6: Hash })[h] || Hash}
            label={({ h1: "Heading 1", h4: "Heading 4", h5: "Heading 5", h6: "Heading 6" })[h] || h}
            active={activeFormats.has(h)}
            onClick={() => fmt(h)}
          />
        ))}
      </DropdownMenu>
      <Sep />

      {/* ── Bold / Italic / Strikethrough / Underline ── */}
      <TBtn icon={Bold} title="Bold (**text**)" active={activeFormats.has("bold")} onClick={() => fmt("bold")} disabled={isDisabled} />
      <TBtn icon={Italic} title="Italic (*text*)" active={activeFormats.has("italic")} onClick={() => fmt("italic")} disabled={isDisabled} />
      <TBtn icon={Strikethrough} title="Strikethrough (~~text~~)" active={activeFormats.has("strike")} onClick={() => fmt("strike")} disabled={isDisabled} />
      <TBtn icon={Underline} title="Underline (<u>text</u>)" active={activeFormats.has("underline")} onClick={() => fmt("underline")} disabled={isDisabled} />
      <Sep />

      {/* ── Highlight + Paste Special ── */}
      <ColorPickerDropdown
        open={openDropdown === "highlight"} onToggle={() => toggleDropdown("highlight")} onClose={closeDropdown}
        currentColor={bgColor}
        onChange={(c) => { setBgColor(c || "rgba(240,166,61,0.25)"); fmt("highlight", c); }}
        mode="bg"
      />
      <DropdownMenu
        open={openDropdown === "paste"} onToggle={() => toggleDropdown("paste")} onClose={closeDropdown}
        trigger={<DropdownBtn icon={ClipboardPaste} open={openDropdown === "paste"} onClick={() => toggleDropdown("paste")} title="Paste Special" />}
      >
        <DropdownItemBtn icon={Copy} label="Copy" value="copy" onClick={() => fmt("copy")} />
        <DropdownItemBtn icon={Scissors} label="Cut" value="cut" onClick={() => fmt("cut")} />
        <DropdownItemBtn icon={Clipboard} label="Paste" value="paste" onClick={() => fmt("paste")} />
        <DropdownItemBtn icon={ClipboardList} label="Paste as Plain Text" value="pastePlain" onClick={() => fmt("pastePlain")} />
        <DropdownItemBtn icon={WrapText} label="Duplicate" value="duplicate" onClick={() => fmt("duplicate")} />
      </DropdownMenu>
      <Sep />
{/* ── Insert: Attach / Table / Checkbox / Comment ── */}
      <TBtn icon={Paperclip} title="Attach File" onClick={() => onAttach?.()} disabled={isDisabled} size={14} />
      <TBtn icon={Table2} title="Insert Table" onClick={() => fmt("table")} disabled={isDisabled} />
      <TBtn icon={CheckSquare} title="Task List (- [ ])" active={activeFormats.has("task")} onClick={() => fmt("task")} disabled={isDisabled} />
      <DropdownMenu
        open={openDropdown === "comment"} onToggle={() => toggleDropdown("comment")} onClose={closeDropdown}
        trigger={<DropdownBtn icon={Quote} open={openDropdown === "comment"} onClick={() => toggleDropdown("comment")} title="Blockquote / Comment" />}
      >
        <DropdownItemBtn icon={Quote} label="Blockquote (> )" value="blockquote" onClick={() => fmt("blockquote")} />
        <DropdownItemBtn icon={MessageSquare} label="Note Callout (> [!NOTE])" value="callout" onClick={() => fmt("callout")} />
      </DropdownMenu>
      <Sep />

      {/* ── Advanced / Code Formatting ── */}
      <DropdownMenu
        open={openDropdown === "advanced"} onToggle={() => toggleDropdown("advanced")} onClose={closeDropdown}
        trigger={<DropdownBtn icon={Code2} open={openDropdown === "advanced"} onClick={() => toggleDropdown("advanced")} title="Code / Advanced" />}
      >
        <DropdownItemBtn icon={ArrowUpFromLine} label="Superscript (^text^)" value="superscript" onClick={() => fmt("superscript")} />
        <DropdownItemBtn icon={ArrowDownToLine} label="Subscript (~text~)" value="subscript" onClick={() => fmt("subscript")} />
        <DropdownItemBtn icon={Code2} label="Inline Code (`text`)" value="inlineCode" onClick={() => fmt("inlineCode")} />
        <DropdownItemBtn icon={Braces} label="Code Block (```)" value="codeBlock" onClick={() => fmt("codeBlock")} />
        <DropdownItemBtn icon={Link} label="WikiLink ([[...]])" value="wikiLink" onClick={() => fmt("wikiLink")} />
        <DropdownItemBtn icon={FileText} label="Insert Hyperlink" value="link" onClick={() => fmt("link")} />
        <DropdownItemBtn icon={Minus} label="Separator Line (---)" value="hr" onClick={() => fmt("hr")} />
        <DropdownItemBtn icon={Sigma} label="Math Formula ($...$)" value="math" onClick={() => fmt("math")} />
        <DropdownItemBtn icon={Variable} label="Math Block ($$...$$)" value="mathBlock" onClick={() => fmt("mathBlock")} />
      </DropdownMenu>
      <Sep />

      {/* ── Lists ── */}
      <DropdownMenu
        open={openDropdown === "lists"} onToggle={() => toggleDropdown("lists")} onClose={closeDropdown}
        trigger={<DropdownBtn icon={List} open={openDropdown === "lists"} onClick={() => toggleDropdown("lists")} title="List Formatting" />}
      >
        <DropdownItemBtn icon={ListChecks} label="Todo List" value="task" onClick={() => fmt("task")} />
        <DropdownItemBtn icon={IndentDecrease} label="Decrease Indent" value="outdent" onClick={() => fmt("outdent")} />
        <DropdownItemBtn icon={List} label="Bulleted List" value="ul" onClick={() => fmt("ul")} />
        <DropdownItemBtn icon={ListOrdered} label="Numbered List" value="ol" onClick={() => fmt("ol")} />
        <DropdownItemBtn icon={IndentIncrease} label="Increase Indent" value="indent" onClick={() => fmt("indent")} />
        <DropdownItemBtn icon={ArrowUpFromLine} label="Toggle List Style" value="toggleList" onClick={() => fmt("toggleList")} />
      </DropdownMenu>

      {/* ── Text Alignment ── */}
      <DropdownMenu
        open={openDropdown === "align"} onToggle={() => toggleDropdown("align")} onClose={closeDropdown}
        trigger={<DropdownBtn icon={AlignLeft} open={openDropdown === "align"} onClick={() => toggleDropdown("align")} title="Text Alignment" />}
      >
        <DropdownItemBtn icon={AlignJustify} label="Justify" value="justify" onClick={() => fmt("justify")} />
        <DropdownItemBtn icon={AlignLeft} label="Align Left" value="alignLeft" onClick={() => fmt("alignLeft")} />
        <DropdownItemBtn icon={AlignCenter} label="Align Center" value="alignCenter" onClick={() => fmt("alignCenter")} />
        <DropdownItemBtn icon={AlignRight} label="Align Right" value="alignRight" onClick={() => fmt("alignRight")} />
      </DropdownMenu>
      <Sep />

      {/* ── Text Color ── */}
      <ColorPickerDropdown
        open={openDropdown === "textColor"} onToggle={() => toggleDropdown("textColor")} onClose={closeDropdown}
        currentColor={textColor}
        onChange={(c) => { setTextColor(c || "#f0a63d"); fmt("textColor", c); }}
        mode="text"
      />

      {/* ── Background Color ── */}
      <ColorPickerDropdown
        open={openDropdown === "bgColor"} onToggle={() => toggleDropdown("bgColor")} onClose={closeDropdown}
        currentColor={bgColor}
        onChange={(c) => { setBgColor(c || "rgba(240,166,61,0.25)"); fmt("bgColor", c); }}
        mode="bg"
      />
    </div>
  );
}