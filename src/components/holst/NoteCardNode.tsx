import React, { memo, useState, useEffect } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import type { HolstNodeData } from "./types";
import { api } from "../../api/client";
import MarkdownRenderer from "../MarkdownRenderer";

function NoteCardNode({ data, selected }: NodeProps<HolstNodeData>) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!data.notePath) { setLoading(false); return; }
    api.myspaceRead(data.notePath)
      .then((f) => { setContent(f.content); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [data.notePath]);

  const noteName = data.notePath?.replace(/\.md$/i, "").split("/").pop() || "Embedded Note";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "var(--surface-glass)",
        border: selected ? "2px solid var(--teal)" : "1px solid var(--glass-border)",
        borderRadius: 8,
        boxShadow: selected
          ? "0 0 0 2px var(--teal), 0 4px 12px rgba(0,0,0,0.15)"
          : "0 2px 8px rgba(0,0,0,0.08)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div
        style={{
          padding: "6px 10px",
          background: "var(--track)",
          borderBottom: "1px solid var(--glass-border)",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ opacity: 0.6 }}>📝</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {noteName}
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 10px", fontSize: 12, lineHeight: 1.5, color: "var(--text-primary)" }}>
        {loading ? (
          <div style={{ color: "var(--text-tertiary)" }}>Loading...</div>
        ) : error ? (
          <div style={{ color: "var(--coral)" }}>{error}</div>
        ) : content ? (
          <MarkdownRenderer content={content.slice(0, 300)} />
        ) : (
          <div style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>Empty note</div>
        )}
      </div>
      {data.notePath && (
        <div
          style={{
            padding: "3px 8px",
            borderTop: "1px solid var(--glass-border)",
            fontSize: 9,
            color: "var(--text-tertiary)",
            textAlign: "right",
            fontFamily: "var(--font-mono)",
          }}
        >
          {data.notePath}
        </div>
      )}
    </div>
  );
}

export default memo(NoteCardNode);