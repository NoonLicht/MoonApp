import React from "react";
import {
  StickyNote, Square, Circle, Triangle, Diamond, Star, Type,
  MousePointer2, Hand, Minus, ArrowRight, Crop,
  Save, Download, Undo2, Redo2, Plus, ZoomIn, ZoomOut,
} from "lucide-react";
import type { HolstNodeType, ShapeGeometry } from "./types";

interface HolstToolbarProps {
  activeTool: string | null;
  setActiveTool: (t: string | null) => void;
  onAddNode: (type: HolstNodeType, shapeType?: ShapeGeometry) => void;
  onSave: () => void;
  onExport: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  zoomLevel: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const toolBtn = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 6,
  border: active ? "1px solid var(--teal)" : "1px solid transparent",
  background: active ? "rgba(45, 212, 191, 0.15)" : "transparent",
  color: active ? "var(--teal)" : "var(--text-secondary)",
  cursor: "pointer",
  transition: "all 0.12s",
});

const sep: React.CSSProperties = {
  width: 1,
  height: 20,
  background: "var(--glass-border)",
  margin: "0 2px",
  flexShrink: 0,
};

export default function HolstToolbar({
  activeTool, setActiveTool, onAddNode, onSave, onExport,
  onZoomIn, onZoomOut, onZoomReset, zoomLevel,
  canUndo, canRedo, onUndo, onRedo,
}: HolstToolbarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 8px",
        background: "var(--surface-glass)",
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        backdropFilter: "blur(12px)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
        flexShrink: 0,
        flexWrap: "wrap",
        userSelect: "none",
      }}
    >
      {/* Selection / Pan */}
      <button
        onClick={() => setActiveTool(activeTool === "select" ? null : "select")}
        style={toolBtn(activeTool === "select")}
        title="Select (V)"
      >
        <MousePointer2 size={15} />
      </button>
      <button
        onClick={() => setActiveTool(activeTool === "pan" ? null : "pan")}
        style={toolBtn(activeTool === "pan")}
        title="Pan (H)"
      >
        <Hand size={15} />
      </button>

      <div style={sep} />

      {/* Shapes */}
      <button
        onClick={() => onAddNode("sticky")}
        style={toolBtn(false)}
        title="Sticky Note"
      >
        <StickyNote size={15} />
      </button>
      <button
        onClick={() => onAddNode("shape", "rectangle")}
        style={toolBtn(false)}
        title="Rectangle"
      >
        <Square size={15} />
      </button>
      <button
        onClick={() => onAddNode("shape", "circle")}
        style={toolBtn(false)}
        title="Circle"
      >
        <Circle size={15} />
      </button>
      <button
        onClick={() => onAddNode("shape", "triangle")}
        style={toolBtn(false)}
        title="Triangle"
      >
        <Triangle size={15} />
      </button>
      <button
        onClick={() => onAddNode("shape", "diamond")}
        style={toolBtn(false)}
        title="Diamond"
      >
        <Diamond size={15} />
      </button>
      <button
        onClick={() => onAddNode("shape", "star")}
        style={toolBtn(false)}
        title="Star"
      >
        <Star size={15} />
      </button>

      <div style={sep} />

      {/* Text / Connectors */}
      <button
        onClick={() => onAddNode("text")}
        style={toolBtn(false)}
        title="Text Box"
      >
        <Type size={15} />
      </button>
      <button
        onClick={() => setActiveTool(activeTool === "connector" ? null : "connector")}
        style={toolBtn(activeTool === "connector")}
        title="Connector"
      >
        <ArrowRight size={15} />
      </button>

      <div style={sep} />

      {/* Undo / Redo */}
      <button onClick={onUndo} style={{ ...toolBtn(false), opacity: canUndo ? 1 : 0.3 }} title="Undo (Ctrl+Z)">
        <Undo2 size={14} />
      </button>
      <button onClick={onRedo} style={{ ...toolBtn(false), opacity: canRedo ? 1 : 0.3 }} title="Redo (Ctrl+Shift+Z)">
        <Redo2 size={14} />
      </button>

      <div style={sep} />

      {/* Zoom */}
      <button onClick={onZoomOut} style={toolBtn(false)} title="Zoom out">
        <ZoomOut size={14} />
      </button>
      <button
        onClick={onZoomReset}
        style={{
          ...toolBtn(false),
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          width: "auto",
          padding: "0 6px",
          fontWeight: 600,
        }}
        title="Reset zoom"
      >
        {Math.round(zoomLevel * 100)}%
      </button>
      <button onClick={onZoomIn} style={toolBtn(false)} title="Zoom in">
        <ZoomIn size={14} />
      </button>

      <div style={{ flex: 1 }} />

      {/* Save / Export */}
      <button onClick={onSave} style={toolBtn(false)} title="Save (Ctrl+S)">
        <Save size={14} />
      </button>
      <button onClick={onExport} style={toolBtn(false)} title="Export PNG">
        <Download size={14} />
      </button>
    </div>
  );
}