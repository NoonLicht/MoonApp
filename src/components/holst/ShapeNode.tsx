import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import type { HolstNodeData, ShapeGeometry } from "./types";

function renderShapePath(geo: ShapeGeometry, w: number, h: number): string {
  const cx = w / 2, cy = h / 2;
  switch (geo) {
    case "rectangle":
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
    case "circle":
      return `M ${cx} 0 A ${cx} ${cy} 0 1 1 ${cx - 0.001} 0 Z`;
    case "triangle":
      return `M ${cx} 0 L ${w} ${h} L 0 ${h} Z`;
    case "diamond":
      return `M ${cx} 0 L ${w} ${cy} L ${cx} ${h} L 0 ${cy} Z`;
    case "star": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const angle = (i * Math.PI) / 5 - Math.PI / 2;
        const r = i % 2 === 0 ? Math.min(w, h) * 0.45 : Math.min(w, h) * 0.2;
        pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
      }
      return `M ${pts.join(" L ")} Z`;
    }
    case "speechBubble": {
      const tl = Math.min(w, h) * 0.12;
      return `M ${tl} 0 L ${w - tl} 0 Q ${w} 0 ${w} ${tl} L ${w} ${h - tl * 2.5} Q ${w} ${h - tl * 2.5} ${w * 0.6} ${h - tl * 1.8} L ${w * 0.5} ${h} L ${w * 0.4} ${h - tl * 2} L ${tl} ${h - tl * 2.5} Q 0 ${h - tl * 2.5} 0 ${h - tl * 2.5} L 0 ${tl} Q 0 0 ${tl} 0 Z`;
    }
    case "hexagon":
      return `M ${cx} 0 L ${w} ${cy * 0.5} L ${w} ${h - cy * 0.5} L ${cx} ${h} L 0 ${h - cy * 0.5} L 0 ${cy * 0.5} Z`;
    default:
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  }
}

function ShapeNode({ data, selected }: NodeProps<HolstNodeData>) {
  const w = 160, h = 120;
  const fillColor = data.color || "var(--glass)";
  const strokeColor = data.strokeColor || "var(--glass-border)";
  const strokeW = data.strokeWidth ?? 2;
  const dashArray = data.borderStyle === "dashed" ? "6,4" : data.borderStyle === "dotted" ? "2,3" : "none";
  const geo = data.shapeType || "rectangle";
  const path = renderShapePath(geo, w, h);

  return (
    <div style={{ width: w, height: h, position: "relative" }}>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        <path
          d={path}
          fill={fillColor}
          fillOpacity={data.fillOpacity ?? 0.6}
          stroke={strokeColor}
          strokeWidth={strokeW}
          strokeDasharray={dashArray}
          strokeLinejoin="round"
        />
      </svg>
      {selected && (
        <div
          style={{
            position: "absolute",
            inset: -2,
            border: "2px solid var(--teal)",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        />
      )}
      {data.text && (
        <div
          style={{
            position: "absolute",
            inset: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: data.fontSize || 12,
            fontFamily: data.fontFamily || "var(--font-mono)",
            textAlign: data.textAlign || "center",
            fontWeight: data.fontWeight || "500",
            overflow: "hidden",
            textShadow: "0 1px 3px rgba(0,0,0,0.3)",
            pointerEvents: "none",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {data.text}
        </div>
      )}
    </div>
  );
}

export default memo(ShapeNode);