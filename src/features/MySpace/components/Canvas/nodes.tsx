import React, { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeResizer, BaseEdge, EdgeLabelRenderer, getBezierPath, getStraightPath, getSmoothStepPath } from "@xyflow/react";
import type { NodeProps, EdgeProps } from "@xyflow/react";
import { FileText, Zap } from "lucide-react";
import { api } from "../../../../api/client";
import type { ShapeKind, ConnectorData, MatrixData, TaskData, TaskStatus } from "./types";

/* Shared helpers ---------------------------------------------------------- */

export function NodeHandles({ color = "#3fc7ab" }: { color?: string }) {
  const specs: { id: string; pos: Position }[] = [
    { id: "t", pos: Position.Top },
    { id: "r", pos: Position.Right },
    { id: "b", pos: Position.Bottom },
    { id: "l", pos: Position.Left },
  ];
  const base: React.CSSProperties = {
    background: "#161927",
    border: `2px solid ${color}`,
    width: 10,
    height: 10,
  };
  return (
    <>
      {specs.map(({ id, pos }) => (
        <React.Fragment key={id}>
          <Handle id={id} type="target" position={pos} style={base} isConnectable />
          <Handle id={id} type="source" position={pos} style={base} isConnectable />
        </React.Fragment>
      ))}
    </>
  );
}

const stopKeys = (e: React.KeyboardEvent) => {
  e.stopPropagation();
};

/* Sticky note ------------------------------------------------------------- */

function StickyNoteNode({ id, data, selected }: NodeProps) {
  const d = data as { text: string; color: string; setData: (id: string, patch: any) => void };
  return (
    <div
      className="holst-node"
      style={{
        width: "100%", height: "100%",
        borderRadius: 4, border: selected ? "2px solid #3b82f6" : "none",
        boxShadow: "0 4px 14px rgba(0,0,0,0.28)",
        background: d.color,
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}
    >
      <NodeResizer minWidth={140} minHeight={120} isVisible={selected} color="#3b82f6" />
      <textarea
        value={d.text}
        placeholder="Type..."
        onKeyDown={stopKeys}
        onChange={(e) => d.setData?.(id, { text: e.target.value })}
        style={{
          flex: 1, border: "none", outline: "none", resize: "none",
          background: "transparent", padding: "10px 12px",
          fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 500,
          color: "#1c1d2b", lineHeight: 1.35, cursor: "text",
        }}
      />
      <NodeHandles />
    </div>
  );
}

/* Free text ---------------------------------------------------------------- */

function TextNode({ id, data, selected }: NodeProps) {
  const d = data as { text: string; fontSize: number; weight: number; align: string; color?: string; setData: (id: string, patch: any) => void };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.innerText !== d.text) ref.current.innerText = d.text;
  }, []);
  return (
    <div className="holst-node" style={{ width: "100%", height: "100%", border: selected ? "1px solid rgba(59,130,246,.5)" : "1px solid transparent", borderRadius: 6 }}>
      <NodeResizer minWidth={80} minHeight={30} isVisible={selected} color="#3b82f6" />
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onKeyDown={stopKeys}
        onInput={(e) => d.setData?.(id, { text: (e.target as HTMLDivElement).innerText })}
        style={{ fontSize: d.fontSize, fontWeight: d.weight, textAlign: d.align as any, color: d.color || "var(--text-primary)", width: "100%", height: "100%", padding: 4, cursor: "text", whiteSpace: "pre-wrap", overflow: "hidden" }}
      />
      <NodeHandles color="#8b7bf0" />
    </div>
  );
}

/* Shapes -------------------------------------------------------------------- */

function shapePath(kind: ShapeKind, w: number, h: number, fill: string, stroke: string): JSX.Element {
  const r = Math.min(w, h) / 2;
  const common = { fill, stroke, strokeWidth: 2 } as const;
  switch (kind) {
    case "rect": return <rect x={1} y={1} width={w - 2} height={h - 2} rx={2} {...common} />;
    case "rounded": return <rect x={1} y={1} width={w - 2} height={h - 2} rx={12} {...common} />;
    case "circle": return <ellipse cx={w / 2} cy={h / 2} rx={r - 1} ry={r - 1} {...common} />;
    case "diamond": return <polygon points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`} {...common} />;
    case "star": {
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 1, ri = R * 0.45;
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ang = (Math.PI / 5) * i - Math.PI / 2;
        const rad = i % 2 === 0 ? R : ri;
        pts.push(`${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`);
      }
      return <polygon points={pts.join(" ")} strokeLinejoin="round" {...common} />;
    }
    case "cloud": {
      return (
        <path
          d={`M ${w * 0.25} ${h * 0.75}
              a ${r * 0.35} ${r * 0.32} 0 0 1 0 ${-h * 0.28}
              a ${r * 0.42} ${r * 0.4} 0 0 1 ${w * 0.22} ${-h * 0.12}
              a ${r * 0.38} ${r * 0.36} 0 0 1 ${w * 0.26} 0
              a ${r * 0.34} ${r * 0.3} 0 0 1 ${w * 0.05} ${h * 0.36}
              a ${r * 0.3} ${r * 0.26} 0 0 1 ${-w * 0.5} 0.05 Z`}
          {...common}
        />
      );
    }
  }
}

function ShapeNode({ id, data, selected }: NodeProps) {
  const d = data as { shape: ShapeKind; label: string; fill: string; stroke: string; w: number; h: number; setData: (id: string, patch: any) => void };
  return (
    <div className="holst-node" style={{ width: "100%", height: "100%" }}>
      <NodeResizer minWidth={100} minHeight={80} isVisible={selected} color="#3b82f6" />
      <div className="holst-shape">
        <svg viewBox={`0 0 ${d.w} ${d.h}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          {shapePath(d.shape, d.w, d.h, d.fill, selected ? "#3b82f6" : d.stroke)}
        </svg>
        <div
          className="shape-label"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onKeyDown={stopKeys}
          onBlur={(e) => d.setData?.(id, { label: (e.target as HTMLDivElement).innerText })}
          style={{ cursor: "text" }}
        >
          {d.label}
        </div>
      </div>
      <NodeHandles color={d.stroke} />
    </div>
  );
}

/* Smart frame ---------------------------------------------------------------- */

function SmartFrameNode({ id, data, selected }: NodeProps) {
  const d = data as { label: string; color: string; setData: (id: string, patch: any) => void };
  return (
    <div className="holst-node" style={{ width: "100%", height: "100%" }}>
      <div
        className="holst-frame"
        style={{ borderColor: d.color, background: `${d.color}0d`, borderStyle: selected ? "solid" : "dashed" }}
      >
        <div
          className="holst-frame-label"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onKeyDown={stopKeys}
          onBlur={(e) => d.setData?.(id, { label: (e.target as HTMLDivElement).innerText })}
          style={{ background: d.color, cursor: "text" }}
        >
          {d.label}
        </div>
      </div>
    </div>
  );
}

/* Task card -------------------------------------------------------------------- */

const TASK_TONES: Record<TaskStatus, { bg: string; color: string }> = {
  todo: { bg: "rgba(113,112,138,.18)", color: "#a9a8bb" },
  inprogress: { bg: "rgba(240,166,61,.16)", color: "#f0a63d" },
  done: { bg: "rgba(63,199,138,.16)", color: "#3fc78a" },
};

function TaskCardNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as TaskData & { setData: (id: string, patch: any) => void };
  const done = d.subtasks.filter((s) => s.done).length;
  const pct = d.subtasks.length ? Math.round((done / d.subtasks.length) * 100) : d.status === "done" ? 100 : 0;
  const tone = TASK_TONES[d.status];
  return (
    <div className="holst-node holst-task" style={{ border: selected ? "2px solid #3b82f6" : "1px solid var(--glass-border)" }}>
      <NodeResizer minWidth={200} minHeight={110} isVisible={selected} color="#3b82f6" />
      <div className="task-top">
        <select
          value={d.status}
          onKeyDown={stopKeys}
          onChange={(e) => d.setData?.(id, { status: e.target.value as TaskStatus })}
          className="task-status"
          style={{ background: tone.bg, color: tone.color, border: "none", outline: "none", cursor: "pointer", fontWeight: 700 }}
        >
          <option value="todo">To Do</option>
          <option value="inprogress">In Progress</option>
          <option value="done">Done</option>
        </select>
        <input
          type="date"
          value={d.due || ""}
          onKeyDown={stopKeys}
          onChange={(e) => d.setData?.(id, { due: e.target.value })}
          style={{ marginLeft: "auto", background: "transparent", border: "none", outline: "none", color: "var(--amber)", fontSize: 10, fontFamily: "var(--font-mono)", width: 92, cursor: "pointer" }}
        />
      </div>
      <div
        className="task-title"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onKeyDown={stopKeys}
        onBlur={(e) => d.setData?.(id, { title: (e.target as HTMLDivElement).innerText })}
      >
        {d.title}
      </div>
      {d.subtasks.map((s, i) => (
        <label key={i} className="task-sub" style={{ textDecoration: s.done ? "line-through" : "none", opacity: s.done ? 0.6 : 1 }}>
          <input
            type="checkbox"
            checked={s.done}
            onChange={(e) => {
              const next = d.subtasks.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x));
              d.setData?.(id, { subtasks: next });
            }}
          />
          <span style={{ fontSize: 11 }}>{s.text}</span>
        </label>
      ))}
      <div className="task-progress-track"><div className="task-progress-fill" style={{ width: `${pct}%` }} /></div>
      <NodeHandles color="#3fc78a" />
    </div>
  );
}

/* Markdown card (lazy content) ---------------------------------------------------- */

function MarkdownCardNode({ id, data, selected }: NodeProps) {
  const d = data as { path: string; name: string; preview?: string; loaded?: boolean; setData: (id: string, patch: any) => void };
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (d.loaded || loading) return;
    setLoading(true);
    try {
      const f = await api.myspaceRead(d.path);
      const preview = (f?.content || "").replace(/[#*`>\-[\]]/g, "").slice(0, 420);
      d.setData?.(id, { preview, loaded: true });
    } catch { d.setData?.(id, { preview: "⚠ Failed to load", loaded: true }); }
    setLoading(false);
  };
  return (
    <div className="holst-node holst-md" style={{ border: selected ? "2px solid #3b82f6" : "1px solid var(--glass-border)" }} onClick={load} title={d.path}>
      <NodeResizer minWidth={170} minHeight={120} isVisible={selected} color="#3b82f6" />
      <div className="md-head"><FileText size={12} /> .md note</div>
      <div className="md-title">{d.name}</div>
      <div className="md-preview">{d.loaded ? d.preview : "Open card to load note content…"}</div>
      <div className="md-lazy"><Zap size={10} /> {loading ? "loading…" : d.loaded ? "loaded" : "lazy · click to fetch"}</div>
      <NodeHandles color="#8b7bf0" />
    </div>
  );
}

/* Matrix (quadrants) ------------------------------------------------------------- */

function MatrixNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as MatrixData & { setData: (id: string, patch: any) => void };
  const cols = Math.max(2, d.columns.length);
  return (
    <div className="holst-node holst-matrix" style={{ border: selected ? "2px solid #3b82f6" : "1px solid var(--glass-border)", gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      <NodeResizer minWidth={260} minHeight={190} isVisible={selected} color="#3b82f6" />
      <div
        className="mx-title"
        contentEditable suppressContentEditableWarning spellCheck={false} onKeyDown={stopKeys}
        onBlur={(e) => d.setData?.(id, { title: (e.target as HTMLDivElement).innerText })}
      >
        {d.title}
      </div>
      {d.columns.map((colName, ci) => {
        const items = d.items.filter((it) => it.col === ci);
        return (
          <div key={ci} className="mx-cell" style={{ background: "var(--glass)" }}>
            <div className="mx-cell-head" style={{ color: ["#f0a63d", "#8b7bf0", "#3fc7ab", "#ea6b6b"][ci % 4] }}>{colName}</div>
            {items.map((it, k) => (
              <div key={k} className="mx-chip" style={{ background: it.color }}>{it.text}</div>
            ))}
            <div
              contentEditable suppressContentEditableWarning spellCheck={false} onKeyDown={stopKeys}
              style={{ outline: "none", color: "var(--text-tertiary)", minHeight: 16, cursor: "text" }}
              onBlur={(e) => {
                const raw = (e.target as HTMLDivElement).innerText.trim();
                if (!raw) return;
                const others = d.items.filter((it) => it.col !== ci);
                const colors = ["#fef08a", "#fbcfe8", "#bfdbfe", "#bbf7d0", "#e9d5ff", "#fed7aa"];
                const next = [...others, ...raw.split("\n").filter(Boolean).map((t, i) => ({ col: ci, text: t, color: colors[(items.length + i) % colors.length] }))];
                d.setData?.(id, { items: next });
                (e.target as HTMLDivElement).innerText = "";
              }}
            />
          </div>
        );
      })}
      <NodeHandles color="#ea6b6b" />
    </div>
  );
}

/* Sticker ---------------------------------------------------------------------------- */

function StickerNode({ data }: NodeProps) {
  const d = data as { emoji: string };
  return (
    <div className="holst-node holst-sticker" style={{ fontSize: 36, lineHeight: 1, textAlign: "center" }}>
      {d.emoji}
      <NodeHandles color="#f0a63d" />
    </div>
  );
}

/* Pen stroke ---------------------------------------------------------------------------- */

function StrokeNode({ data, selected }: NodeProps) {
  const d = data as { points: [number, number][]; color: string; width: number; opacity: number; w: number; h: number };
  const pts = d.points.map((p) => `${p[0]},${p[1]}`).join(" ");
  return (
    <div className="holst-stroke-node">
      <svg viewBox={`0 0 ${d.w} ${d.h}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", overflow: "visible" }}>
        <polyline
          points={pts}
          fill="none"
          stroke={selected ? "#3b82f6" : d.color}
          strokeWidth={d.width}
          strokeOpacity={d.opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export const nodeTypes = {
  sticky: memo(StickyNoteNode),
  text: memo(TextNode),
  shape: memo(ShapeNode),
  frame: memo(SmartFrameNode),
  task: memo(TaskCardNode),
  md: memo(MarkdownCardNode),
  matrix: memo(MatrixNode),
  sticker: memo(StickerNode),
  stroke: memo(StrokeNode),
};

/* Connector edge -------------------------------------------------------------------------- */

function ConnectorEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd, style }: EdgeProps) {
  const cd = (data || {}) as Partial<ConnectorData>;
  const styleKind = cd.style || "bezier";
  const [path, labelX, labelY] =
    styleKind === "straight"
      ? getStraightPath({ sourceX, sourceY, targetX, targetY })
      : styleKind === "step"
        ? getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14 })
        : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

  const dashMap: Record<string, string | undefined> = { solid: undefined, dashed: "8 6", dotted: "2 5" };
  const dasharray = dashMap[cd.dash || "solid"];

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={cd.arrowStart ? markerEnd : undefined}
        markerEnd={cd.arrowEnd !== false ? markerEnd : undefined}
        style={{
          strokeWidth: 2,
          stroke: selected ? "#3b82f6" : (style as any)?.stroke || "#8b7bf0",
          strokeDasharray: dasharray,
          ...(cd.animated ? { animation: "holstDashFlow .8s linear infinite" } : {}),
        }}
      />
      <EdgeLabelRenderer>
        {cd.animated && (
          <div style={{
            position: "absolute",
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            width: 8, height: 8, borderRadius: "50%",
            background: "#f0a63d",
            boxShadow: "0 0 8px #f0a63d",
            pointerEvents: "none",
            fontSize: 0,
          }} />
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = { connector: memo(ConnectorEdge) };
