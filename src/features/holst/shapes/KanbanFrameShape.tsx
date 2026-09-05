import React from "react";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  TLBaseShape,
} from "@tldraw/tldraw";
import { kanbanFrameShapeProps } from "./types";

export type KanbanFrameShape = TLBaseShape<"kanbanFrame", typeof kanbanFrameShapeProps>;

export class KanbanFrameShapeUtil extends BaseBoxShapeUtil<KanbanFrameShape> {
  static override type = "kanbanFrame" as const;
  static override props = kanbanFrameShapeProps;

  getDefaultProps(): KanbanFrameShape["props"] {
    return {
      title: "New Column",
      columnStatus: "todo",
      color: "var(--teal)",
      cardIds: [],
    };
  }

  override canEdit = () => true;
  override canResize = () => true;
  override canDropShapes = () => true;

  component(shape: KanbanFrameShape) {
    const { title, color, columnStatus } = shape.props;

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
            border: `1px solid ${color || "var(--glass-border)"}`,
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
          {/* Column header */}
          <div
            style={{
              padding: "8px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: color || "var(--glass-strong)",
              borderBottom: "1px solid var(--glass-border)",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: color || "var(--teal)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 700, flex: 1 }}>{title}</span>
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 4,
                background: "var(--track)",
                fontSize: 9,
                color: "var(--text-tertiary)",
              }}
            >
              {columnStatus.replace("_", " ")}
            </span>
          </div>

          {/* Drop zone */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              padding: "6px 8px",
              gap: 4,
              overflow: "hidden",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <div
              style={{
                border: "2px dashed var(--glass-border)",
                borderRadius: 6,
                padding: 12,
                textAlign: "center",
                fontSize: 10,
                color: "var(--text-tertiary)",
                opacity: 0.5,
              }}
            >
              Drop cards here
            </div>
          </div>
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: KanbanFrameShape) {
    return (
      <rect
        width={shape.props.w}
        height={shape.props.h}
        rx={12}
        fill="none"
        stroke={shape.props.color || "var(--teal)"}
        strokeWidth={1.5}
        strokeDasharray="6 4"
      />
    );
  }
}