import React from "react";

export interface HolstToolbarProps {
  /** Current active tool */
  activeTool: string;
  /** Switch tool */
  setActiveTool: (tool: string) => void;
  /** Save canvas */
  onSave: () => void;
  /** Export as image */
  onExport: () => void;
  /** Zoom controls */
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitScreen: () => void;
  /** Current zoom level */
  zoomLevel: number;
  /** Auto-layout buttons */
  onAutoLayout: () => void;
  onPipelineLayout: () => void;
  /** Insert shape shortcuts */
  onInsertShape: (type: string) => void;
  /** Canvas name */
  canvasName: string;
  /** Dirty indicator */
  dirty: boolean;
}

const toolItems = [
  { id: "select", icon: "⬚", label: "Select (V)" },
  { id: "draw", icon: "✏️", label: "Draw (D)" },
  { id: "text", icon: "T", label: "Text (T)" },
  { id: "note", icon: "📝", label: "Note Card" },
  { id: "task", icon: "✅", label: "Task Card" },
  { id: "pipeline", icon: "⚙️", label: "Pipeline" },
  { id: "kanban", icon: "📋", label: "Kanban" },
  { id: "sticky", icon: "💛", label: "Sticky (N)" },
  { id: "connector", icon: "→", label: "Connector (A)" },
  { id: "freehand", icon: "🖊️", label: "Freehand (P)" },
];

export function HolstToolbar({
  activeTool,
  setActiveTool,
  onSave,
  onExport,
  onZoomIn,
  onZoomOut,
  onFitScreen,
  zoomLevel,
  onAutoLayout,
  onPipelineLayout,
  onInsertShape,
  canvasName,
  dirty,
}: HolstToolbarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        background: "var(--glass-strong)",
        border: "1px solid var(--glass-border)",
        borderRadius: 12,
        backdropFilter: "blur(20px)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-primary)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
        flexWrap: "wrap",
        maxWidth: "100%",
      }}
    >
      {/* Canvas name badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 10px",
          borderRadius: 6,
          background: "var(--track)",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-secondary)",
          border: "1px solid var(--glass-border)",
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={canvasName}
      >
        🎨 {canvasName || "No canvas"}
        {dirty && <span style={{ color: "var(--amber)", fontSize: 8 }}>●</span>}
      </div>

      <Separator />

      {/* Tool selectors */}
      {toolItems.map((t) => (
        <ToolButton
          key={t.id}
          active={activeTool === t.id}
          onClick={() => {
            setActiveTool(t.id);
            if (["note", "task", "pipeline", "kanban", "sticky"].includes(t.id)) {
              onInsertShape(t.id);
            }
          }}
          label={t.label}
        >
          {t.icon}
        </ToolButton>
      ))}

      <Separator />

      {/* Zoom controls */}
      <ToolButton onClick={onZoomOut} label="Zoom Out">−</ToolButton>
      <span
        style={{
          minWidth: 40,
          textAlign: "center",
          fontSize: 10,
          color: "var(--text-tertiary)",
          fontWeight: 600,
        }}
      >
        {Math.round(zoomLevel * 100)}%
      </span>
      <ToolButton onClick={onZoomIn} label="Zoom In">+</ToolButton>
      <ToolButton onClick={onFitScreen} label="Fit to Screen">⊞</ToolButton>

      <Separator />

      {/* Layout buttons */}
      <ToolButton onClick={onAutoLayout} label="Auto-arrange (ELK)">⟳</ToolButton>
      <ToolButton onClick={onPipelineLayout} label="Pipeline layout">⊢</ToolButton>

      <Separator />

      {/* Save / Export */}
      <ToolButton onClick={onSave} label="Save">💾</ToolButton>
      <ToolButton onClick={onExport} label="Export PNG">↓</ToolButton>
    </div>
  );
}

function Separator() {
  return (
    <div
      style={{
        width: 1,
        height: 22,
        background: "var(--glass-border)",
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );
}

function ToolButton({
  active,
  onClick,
  children,
  label,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        border: active ? "1px solid var(--teal)" : "1px solid transparent",
        borderRadius: 6,
        background: active ? "var(--teal-soft)" : "transparent",
        color: active ? "var(--teal)" : "var(--text-secondary)",
        fontSize: 14,
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        transition: "all 0.15s",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = "var(--track)"; e.currentTarget.style.color = "var(--text-primary)"; } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; } }}
    >
      {children}
    </button>
  );
}