import React from "react";
import {
  MousePointer2, Hand, StickyNote, Type, Shapes, Spline, Frame,
  ListTodo, PenLine, Smile, LayoutGrid, ChevronUp,
} from "lucide-react";
import type { CanvasTool, ShapeKind, ConnectorStyle, LineDash } from "./types";

export interface LineProps {
  style: ConnectorStyle;
  dash: LineDash;
  arrowStart: boolean;
  arrowEnd: boolean;
  animated: boolean;
}

const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: "rect", label: "Rectangle" },
  { kind: "rounded", label: "Rounded Card" },
  { kind: "circle", label: "Circle" },
  { kind: "diamond", label: "Decision" },
  { kind: "star", label: "Star" },
  { kind: "cloud", label: "Cloud" },
];

const EMOJIS = ["👍", "⭐", "❤️", "🔥", "🎉", "😀", "🚀", "💡", "✅", "❌", "👀", "🤔"];
const PILLS = ["START HERE", "CRITICAL", "Live Chat", "TODO", "DONE"];

/* Small preview for shape icons */
function ShapeIcon({ kind }: { kind: ShapeKind }) {
  const c = "currentColor";
  const s = { fill: "none", stroke: c, strokeWidth: 1.6 } as const;
  switch (kind) {
    case "rect": return <svg width="15" height="15" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" {...s} /></svg>;
    case "rounded": return <svg width="15" height="15" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="3" {...s} /></svg>;
    case "circle": return <svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" {...s} /></svg>;
    case "diamond": return <svg width="15" height="15" viewBox="0 0 16 16"><polygon points="8,1.5 14.5,8 8,14.5 1.5,8" {...s} /></svg>;
    case "star": return <svg width="15" height="15" viewBox="0 0 16 16"><polygon points="8,1.5 10,6 14.5,6 11,9 12,13.5 8,10.8 4,13.5 5,9 1.5,6 6,6" strokeLinejoin="round" {...s} /></svg>;
    case "cloud": return <svg width="15" height="15" viewBox="0 0 16 16"><path d="M4 12a3 3 0 1 1 .5-5.9A3.5 3.5 0 0 1 11.5 7 2.5 2.5 0 0 1 11 12Z" {...s} /></svg>;
  }
}

export interface DockProps {
  activeTool: CanvasTool;
  onTool: (t: CanvasTool) => void;
  shape: ShapeKind;
  onShape: (s: ShapeKind) => void;
  lineProps: LineProps;
  onLineProps: (p: Partial<LineProps>) => void;
  sticker: string;
  onSticker: (e: string) => void;
  onAutoLayout: () => void;
}

export default function HolstToolbar(p: DockProps) {
  const [openPop, setOpenPop] = React.useState<null | "shape" | "line" | "sticker">(null);

  const tools: { id: CanvasTool; icon: React.ReactNode; key: string; title: string; pop?: "shape" | "line" | "sticker" }[] = [
    { id: "select", icon: <MousePointer2 size={16} />, key: "V", title: "Select (V)" },
    { id: "hand", icon: <Hand size={16} />, key: "H", title: "Hand / Pan (H)" },
    { id: "sticky", icon: <StickyNote size={16} />, key: "N", title: "Sticky note (N)" },
    { id: "text", icon: <Type size={16} />, key: "T", title: "Text (T)" },
    { id: "shape", icon: <Shapes size={16} />, key: "S", title: "Shapes (S)", pop: "shape" },
    { id: "connector", icon: <Spline size={16} />, key: "A", title: "Smart connectors (A)", pop: "line" },
    { id: "frame", icon: <Frame size={16} />, key: "F", title: "Smart frame (F)" },
    { id: "task", icon: <ListTodo size={16} />, key: "K", title: "Task card (K)" },
    { id: "pen", icon: <PenLine size={16} />, key: "P", title: "Pen / highlighter (P)" },
    { id: "sticker", icon: <Smile size={16} />, key: "E", title: "Emoji & stickers (E)", pop: "sticker" },
  ];

  return (
    <div className="holst-float holst-dock" onMouseDown={(e) => e.stopPropagation()}>
      {tools.map((t) => (
        <button
          key={t.id}
          className={`holst-tbtn ${p.activeTool === t.id ? "is-active" : ""}`}
          title={t.title}
          onClick={() => {
            p.onTool(t.id);
            setOpenPop(t.pop && p.activeTool !== t.id ? t.pop : null);
          }}
        >
          {t.icon}
          <span className="holst-kbd">{t.key}</span>
        </button>
      ))}
      <div className="holst-dock-sep" />
      <button className="holst-tbtn" title="Auto-arrange layout (L)" onClick={() => { p.onAutoLayout(); setOpenPop(null); }}>
        <LayoutGrid size={16} />
        <span className="holst-kbd">L</span>
      </button>

      {openPop === "shape" && (
        <div className="holst-pop" style={{ left: 52, bottom: 0 }}>
          {SHAPES.map((s) => (
            <button key={s.kind} className="holst-pop-item" onClick={() => { p.onShape(s.kind); p.onTool("shape"); setOpenPop(null); }}>
              <ShapeIcon kind={s.kind} /> {s.label}
            </button>
          ))}
        </div>
      )}

      {openPop === "line" && (
        <div className="holst-pop" style={{ left: 52, top: "30%" }}>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", padding: "2px 6px", textTransform: "uppercase", letterSpacing: ".06em" }}>Line type</div>
          {(["straight", "bezier", "step"] as ConnectorStyle[]).map((s) => (
            <button key={s} className="holst-pop-item"
              style={p.lineProps.style === s ? { background: "var(--violet-soft)", color: "var(--violet)" } : undefined}
              onClick={() => p.onLineProps({ style: s })}>
              {s === "straight" ? "Straight" : s === "bezier" ? "Curved" : "90° Elbow"}
            </button>
          ))}
          <div className="holst-sep" />
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", padding: "2px 6px", textTransform: "uppercase", letterSpacing: ".06em" }}>Dash</div>
          {(["solid", "dashed", "dotted"] as LineDash[]).map((s) => (
            <button key={s} className="holst-pop-item" style={p.lineProps.dash === s ? { background: "var(--violet-soft)", color: "var(--violet)" } : undefined}
              onClick={() => p.onLineProps({ dash: s })}>
              <svg width="26" height="6">{s === "solid" ? <line x1="0" y1="3" x2="26" y2="3" stroke="currentColor" strokeWidth="2" /> : s === "dashed" ? <line x1="0" y1="3" x2="26" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="6 4" /> : <line x1="0" y1="3" x2="26" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="1 4" />}</svg>
              {s}
            </button>
          ))}
          <div className="holst-sep" />
          <button className="holst-pop-item" onClick={() => p.onLineProps({ arrowStart: !p.lineProps.arrowStart })}>
            {p.lineProps.arrowStart ? "☑" : "☐"} Arrow start
          </button>
          <button className="holst-pop-item" onClick={() => p.onLineProps({ arrowEnd: !p.lineProps.arrowEnd })}>
            {p.lineProps.arrowEnd ? "☑" : "☐"} Arrow end
          </button>
          <button className="holst-pop-item" onClick={() => p.onLineProps({ animated: !p.lineProps.animated })}>
            {p.lineProps.animated ? "☑" : "☐"} Animated flow
          </button>
        </div>
      )}

      {openPop === "sticker" && (
        <div className="holst-pop" style={{ left: 52, bottom: 0, width: 190 }}>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", padding: "2px 6px", textTransform: "uppercase", letterSpacing: ".06em" }}>Reactions</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "2px 6px" }}>
            {EMOJIS.map((e) => (
              <button key={e} className="holst-tbtn" style={{ width: 30, height: 30, fontSize: 18 }}
                onClick={() => { p.onSticker(e); p.onTool("sticker"); setOpenPop(null); }}>{e}</button>
            ))}
          </div>
          <div className="holst-sep" />
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", padding: "2px 6px", textTransform: "uppercase", letterSpacing: ".06em" }}>Status pills</div>
          {PILLS.map((pill) => (
            <button key={pill} className="holst-pop-item" onClick={() => { p.onSticker(`pill:${pill}`); p.onTool("sticker"); setOpenPop(null); }}>
              <span style={{
                fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: ".06em",
                padding: "2px 8px", borderRadius: 999,
                background: pill === "CRITICAL" ? "var(--coral-soft)" : "var(--teal-soft)",
                color: pill === "CRITICAL" ? "var(--coral)" : "var(--teal)",
              }}>{pill}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
