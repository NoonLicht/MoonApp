import React from "react";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  TLBaseShape,
  TLShapeUtilCanvasSvgDef,
} from "@tldraw/tldraw";
import { customNoteShapeProps } from "./types";

export type CustomNoteShape = TLBaseShape<"customNote", typeof customNoteShapeProps>;

export class CustomNoteShapeUtil extends BaseBoxShapeUtil<CustomNoteShape> {
  static override type = "customNote" as const;
  static override props = customNoteShapeProps;

  getDefaultProps(): CustomNoteShape["props"] {
    return {
      notePath: "",
      markdown: "",
      tags: [],
      wikiLinks: [],
      progress: 0,
      accentColor: "var(--teal)",
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    };
  }

  override canEdit = () => true;
  override canResize = () => true;

  component(shape: CustomNoteShape) {
    const { markdown, tags, progress, accentColor, notePath } = shape.props;
    const preview = markdown
      ? markdown.slice(0, 280) + (markdown.length > 280 ? "…" : "")
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
            border: `1px solid ${accentColor || "var(--glass-border)"}`,
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
          {/* Header bar */}
          <div
            style={{
              background: accentColor || "var(--teal-soft)",
              padding: "4px 10px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10,
              color: "var(--text-secondary)",
              borderBottom: "1px solid var(--glass-border)",
              flexShrink: 0,
            }}
          >
            <span>📝</span>
            <span style={{ fontWeight: 600, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notePath || "Untitled Note"}
            </span>
            {progress > 0 && (
              <span style={{ color: "var(--amber)", fontSize: 9 }}>
                {Math.round(progress * 100)}%
              </span>
            )}
          </div>

          {/* Markdown preview */}
          <div
            style={{
              flex: 1,
              padding: "8px 10px",
              overflow: "hidden",
              lineHeight: 1.5,
              fontSize: 10,
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {preview || <span style={{ opacity: 0.4, fontStyle: "italic" }}>Empty note…</span>}
          </div>

          {/* Tags row */}
          {tags.length > 0 && (
            <div
              style={{
                padding: "4px 10px",
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
                borderTop: "1px solid var(--glass-border)",
                flexShrink: 0,
              }}
            >
              {tags.slice(0, 4).map((t, i) => (
                <span
                  key={i}
                  style={{
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "var(--track)",
                    color: "var(--teal)",
                    fontSize: 9,
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: CustomNoteShape) {
    return (
      <rect
        width={shape.props.w}
        height={shape.props.h}
        rx={12}
        fill="none"
        stroke="var(--teal)"
        strokeWidth={1.5}
      />
    );
  }
}