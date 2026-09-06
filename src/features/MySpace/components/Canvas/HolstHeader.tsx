import React from "react";
import { Save, Download, Sparkles } from "lucide-react";

export default function HolstHeader({
  boardName,
  onNameChange,
  onSave,
  onTemplates,
  onExport,
  zoom,
  saving,
}: {
  boardName: string;
  onNameChange: (n: string) => void;
  onSave: () => void;
  onTemplates: () => void;
  onExport: () => void;
  zoom: number;
  saving: boolean;
}) {
  return (
    <div className="holst-header">
      <input
        value={boardName}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Board name..."
      />
      <span className="holst-zoom-label">{Math.round(zoom * 100)}%</span>
      <button className="btn" onClick={onTemplates}>
        <Sparkles size={13} /> Templates
      </button>
      <button className="btn" onClick={onExport}>
        <Download size={13} /> Export
      </button>
      <button
        className="btn"
        onClick={onSave}
        style={{ background: saving ? "rgba(0,210,210,0.15)" : "transparent" }}
      >
        <Save size={13} /> {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}