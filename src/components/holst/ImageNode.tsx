import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import type { HolstNodeData } from "./types";

function ImageNode({ data, selected }: NodeProps<HolstNodeData>) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        border: selected ? "2px solid var(--teal)" : "1px solid var(--glass-border)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--track)",
        position: "relative",
      }}
    >
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {data.src ? (
        <img
          src={data.src}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
          }}
        />
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--text-tertiary)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
        >
          <span style={{ fontSize: 24, marginRight: 8 }}>🖼️</span>
          Drop image here
        </div>
      )}
    </div>
  );
}

export default memo(ImageNode);