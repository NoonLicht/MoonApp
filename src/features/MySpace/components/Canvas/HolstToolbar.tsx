import React from "react";
import { MousePointer2, Hand, StickyNote, Square, Pen, Eraser } from "lucide-react";

const TOOLS = [
  { id: "select", icon: <MousePointer2 size={16} />, shortcut: "V" },
  { id: "hand", icon: <Hand size={16} />, shortcut: "H" },
  { id: "noteCard", icon: <StickyNote size={16} />, shortcut: "N" },
  { id: "taskCard", icon: <Square size={16} />, shortcut: "T" },
  { id: "draw", icon: <Pen size={16} />, shortcut: "P" },
  { id: "eraser", icon: <Eraser size={16} />, shortcut: "E" },
];

export default function HolstToolbar({
  activeTool,
  onChange,
}: {
  activeTool: string;
  onChange: (t: string) => void;
}) {
  return (
    <div className="holst-toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={activeTool === t.id ? "active" : ""}
          onClick={() => onChange(t.id)}
          title={`${t.shortcut}`}
        >
          {t.icon}
        </button>
      ))}
    </div>
  );
}