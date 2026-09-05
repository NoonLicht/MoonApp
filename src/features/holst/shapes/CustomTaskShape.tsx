import React from "react";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  TLBaseShape,
} from "@tldraw/tldraw";
import { customTaskShapeProps } from "./types";

export type CustomTaskShape = TLBaseShape<"customTask", typeof customTaskShapeProps>;

const STATUS_COLORS: Record<string, string> = {
  todo: "var(--text-tertiary)",
  in_progress: "var(--amber)",
  done: "var(--teal)",
  deferred: "var(--violet)",
};

const STATUS_BG: Record<string, string> = {
  todo: "var(--track)",
  in_progress: "var(--amber-soft)",
  done: "var(--teal-soft)",
  deferred: "var(--violet-soft)",
};

export class CustomTaskShapeUtil extends BaseBoxShapeUtil<CustomTaskShape> {
  static override type = "customTask" as const;
  static override props = customTaskShapeProps;

  getDefaultProps(): CustomTaskShape["props"] {
    return {
      title: "New Task",
      description: "",
      status: "todo",
      assignee: "",
      dueDate: "",
      priority: "medium",
      progress: 0,
      tags: [],
      taskId: "",
    };
  }

  override canEdit = () => true;
  override canResize = () => true;

  component(shape: CustomTaskShape) {
    const { title, status, assignee, dueDate, priority, progress, tags } = shape.props;
    const statusColor = STATUS_COLORS[status] || "var(--text-tertiary)";
    const statusBg = STATUS_BG[status] || "var(--track)";

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
            border: `1px solid var(--glass-border)`,
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-primary)",
            boxShadow: "var(--shadow)",
          }}
        >
          {/* Status bar */}
          <div
            style={{
              height: 3,
              background: statusColor,
              flexShrink: 0,
            }}
          />

          {/* Header */}
          <div
            style={{
              padding: "6px 10px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderBottom: "1px solid var(--glass-border)",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 4,
                fontSize: 9,
                fontWeight: 600,
                background: statusBg,
                color: statusColor,
              }}
            >
              {status.replace("_", " ")}
            </span>
            <span style={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {title}
            </span>
            {priority === "urgent" && <span style={{ color: "var(--coral)", fontSize: 10 }}>🔴</span>}
            {priority === "high" && <span style={{ color: "var(--amber)", fontSize: 10 }}>⚡</span>}
          </div>

          {/* Progress bar */}
          {progress > 0 && (
            <div
              style={{
                padding: "0 10px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: "var(--track)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, progress)}%`,
                    height: "100%",
                    background: "var(--teal)",
                    borderRadius: 2,
                    transition: "width 0.3s",
                  }}
                />
              </div>
              <span style={{ fontSize: 9, color: "var(--text-tertiary)" }}>{progress}%</span>
            </div>
          )}

          {/* Description preview */}
          <div
            style={{
              flex: 1,
              padding: "4px 10px",
              fontSize: 10,
              color: "var(--text-secondary)",
              overflow: "hidden",
              lineHeight: 1.4,
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {shape.props.description?.slice(0, 180) || <span style={{ opacity: 0.4 }}>No description</span>}
          </div>

          {/* Meta footer */}
          <div
            style={{
              padding: "3px 10px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderTop: "1px solid var(--glass-border)",
              fontSize: 9,
              color: "var(--text-tertiary)",
              flexShrink: 0,
            }}
          >
            {assignee && (
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                👤 {assignee}
              </span>
            )}
            {dueDate && (
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                📅 {dueDate}
              </span>
            )}
            {tags.slice(0, 2).map((t, i) => (
              <span key={i} style={{ padding: "0 4px", borderRadius: 3, background: "var(--track)" }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: CustomTaskShape) {
    return (
      <rect
        width={shape.props.w}
        height={shape.props.h}
        rx={12}
        fill="none"
        stroke="var(--amber)"
        strokeWidth={1.5}
      />
    );
  }
}