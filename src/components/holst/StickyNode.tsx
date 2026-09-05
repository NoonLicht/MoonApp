import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import type { HolstNodeData } from "./types";

const STICKY_COLORS: Record<string, string> = {
  yellow: "#fef08a",
  green: "#bbf7d0",
  blue: "#bfdbfe",
  pink: "#fbcfe8",
  orange: "#fed7aa",
  purple: "#ddd6fe",
  coral: "#fecaca",
  teal: "#99f6e4",
  white: "#ffffff",
  dark: "#1e1e2e",
};

function StickyNode({ data, selected }: NodeProps<HolstNodeData>) {
  const bg = data.color && STICKY_COLORS[data.color] ? STICKY_COLORS[data.color] : data.color || STICKY_COLORS.yellow;
  const textColor = data.color === "dark" ? "#fff" : "#1a1a2e";
  return (
    <div
      style={{
        background: bg,
        border: selected ? "2px solid var(--teal)" : "1px solid rgba(0,0,0,0.08)",
        borderRadius: 4,
        boxShadow: selected
          ? "0 0 0 2px var(--teal), 0 4px 12px rgba(0,0,0,0.15)"
          : "0 2px 8px rgba(0,0,0,0.08)",
        width: "100%",
        height: "100%",
        padding: "12px 14px",
        color: textColor,
        fontSize: data.fontSize || 14,
        fontFamily: data.fontFamily || "var(--font-mono)",
        fontWeight: data.fontWeight || "400",
        textAlign: data.textAlign || "left",
        overflow: "hidden",
        cursor: data.locked ? "default" : "pointer",
        opacity: data.fillOpacity ?? 1,
        transition: "box-shadow 0.15s",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: data.fontSize || 14,
          lineHeight: 1.5,
        }}
      >
        {data.text || "Empty sticky note"}
      </div>
    </div>
  );
}

export default memo(StickyNode);