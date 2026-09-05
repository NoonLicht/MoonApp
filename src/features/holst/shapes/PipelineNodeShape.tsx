import React from "react";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  TLBaseShape,
} from "@tldraw/tldraw";
import { pipelineNodeShapeProps } from "./types";

export type PipelineNodeShape = TLBaseShape<"pipelineNode", typeof pipelineNodeShapeProps>;

const NODE_STATUS_COLORS: Record<string, string> = {
  queued: "var(--text-tertiary)",
  running: "#3b82f6",
  passed: "var(--teal)",
  failed: "var(--coral)",
  skipped: "var(--text-tertiary)",
};

const NODE_STATUS_ICONS: Record<string, string> = {
  queued: "⏳",
  running: "🔄",
  passed: "✅",
  failed: "❌",
  skipped: "⏭️",
};

export class PipelineNodeShapeUtil extends BaseBoxShapeUtil<PipelineNodeShape> {
  static override type = "pipelineNode" as const;
  static override props = pipelineNodeShapeProps;

  getDefaultProps(): PipelineNodeShape["props"] {
    return {
      title: "Pipeline Step",
      status: "queued",
      stage: 0,
      logs: "",
      duration: 0,
      inputPorts: [],
      outputPorts: [],
    };
  }

  override canEdit = () => true;
  override canResize = () => true;

  component(shape: PipelineNodeShape) {
    const { title, status, stage, duration } = shape.props;
    const color = NODE_STATUS_COLORS[status] || "var(--text-tertiary)";
    const icon = NODE_STATUS_ICONS[status] || "⬜";

    const durationStr = duration > 0
      ? duration > 60000
        ? `${(duration / 60000).toFixed(1)}m`
        : `${(duration / 1000).toFixed(0)}s`
      : "";

    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          pointerEvents: "all",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "var(--glass)",
            border: `2px solid ${color}`,
            borderRadius: 8,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-primary)",
            boxShadow: "var(--shadow)",
            position: "relative",
          }}
        >
          {/* Stage badge */}
          <div
            style={{
              position: "absolute",
              top: -8,
              left: 12,
              padding: "1px 8px",
              borderRadius: 4,
              background: color,
              color: "#fff",
              fontSize: 9,
              fontWeight: 700,
            }}
          >
            #{stage}
          </div>

          {/* Header */}
          <div
            style={{
              padding: "14px 10px 6px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 14 }}>{icon}</span>
            <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {title}
            </span>
          </div>

          {/* Duration / logs line */}
          <div
            style={{
              padding: "2px 10px 6px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 9,
              color: "var(--text-tertiary)",
              flexShrink: 0,
            }}
          >
            {durationStr && <span>⏱ {durationStr}</span>}
            <span
              style={{
                padding: "1px 6px",
                borderRadius: 4,
                background: color + "22",
                color: color,
                fontWeight: 600,
              }}
            >
              {status.toUpperCase()}
            </span>
          </div>

          {/* Connector ports - visual indicators */}
          <div
            style={{
              position: "absolute",
              left: -4,
              top: "50%",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color,
              border: "2px solid var(--bg-base)",
              transform: "translateY(-50%)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              right: -4,
              top: "50%",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color,
              border: "2px solid var(--bg-base)",
              transform: "translateY(-50%)",
              pointerEvents: "none",
            }}
          />
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: PipelineNodeShape) {
    const color = NODE_STATUS_COLORS[shape.props.status] || "var(--text-tertiary)";
    return (
      <rect
        width={shape.props.w}
        height={shape.props.h}
        rx={8}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
      />
    );
  }
}