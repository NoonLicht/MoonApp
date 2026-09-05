import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import type { HolstNodeData } from "./types";

function FrameNode({ data, selected }: NodeProps<HolstNodeData>) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        border: selected
          ? "2px solid var(--teal)"
          : "2px dashed rgba(255, 255, 255, 0.15)",
        borderRadius: 12,
        background: "rgba(255, 255, 255, 0.03)",
        position: "relative",
        transition: "border-color 0.15s",
        overflow: "hidden",
      }}
    >
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {data.text && (
        <div
          style={{
            position: "absolute",
            top: -10,
            left: 12,
            padding: "0 6px",
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            background: "var(--surface-glass)",
            borderRadius: 4,
            letterSpacing: "0.03em",
            textTransform: "uppercase",
          }}
        >
          {data.text}
        </div>
      )}
      {selected && (
        <div
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "var(--teal)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
            zIndex: 100,
          }}
          title="Frame container"
        >
          ⚡
        </div>
      )}
    </div>
  );
}

export default memo(FrameNode);