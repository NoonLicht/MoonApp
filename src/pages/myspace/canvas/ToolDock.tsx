import { useEffect, useRef, useState } from "react";
import {
  Frame,
  Hand,
  Image as ImageIcon,
  ListTodo,
  MousePointer2,
  PenLine,
  Shapes,
  Smile,
  Spline,
  StickyNote,
  Type,
} from "lucide-react";
import { EMOJIS, SHAPES, type ShapeKind } from "@/pages/myspace/canvas/model";
import { shapePath } from "@/pages/myspace/canvas/ObjectView";
import type { Key } from "@/pages/myspace/canvas/strings";

export type Tool =
  "select" | "hand" | "sticky" | "text" | "shape" | "line" | "frame" | "pen" | "sticker" | "task";

interface Props {
  tool: Tool;
  onTool: (t: Tool) => void;
  shape: ShapeKind;
  onShape: (s: ShapeKind) => void;
  emoji: string;
  onEmoji: (e: string) => void;
  onImage: () => void;
  t: (k: Key) => string;
  ru: boolean;
}

const ITEMS: { tool: Tool; icon: typeof Hand; key: Key; hot: string }[] = [
  { tool: "select", icon: MousePointer2, key: "select", hot: "V" },
  { tool: "hand", icon: Hand, key: "hand", hot: "H" },
  { tool: "sticky", icon: StickyNote, key: "sticky", hot: "S" },
  { tool: "text", icon: Type, key: "text", hot: "T" },
  { tool: "shape", icon: Shapes, key: "shape", hot: "R" },
  { tool: "line", icon: Spline, key: "line", hot: "L" },
  { tool: "frame", icon: Frame, key: "frame", hot: "F" },
  { tool: "pen", icon: PenLine, key: "pen", hot: "P" },
  { tool: "task", icon: ListTodo, key: "task", hot: "K" },
  { tool: "sticker", icon: Smile, key: "sticker", hot: "E" },
];

/** Панель инструментов слева. */
export function ToolDock(p: Props) {
  const [pop, setPop] = useState<"shape" | "sticker" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPop(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [pop]);

  const click = (tool: Tool) => {
    if (tool === "shape" || tool === "sticker") {
      if (p.tool === tool) setPop(pop === tool ? null : tool);
      else {
        p.onTool(tool);
        setPop(tool);
      }
      return;
    }
    setPop(null);
    p.onTool(tool);
  };

  return (
    <div className="hc-dock hc-float" data-ui ref={ref}>
      {ITEMS.map((it, i) => {
        const Icon = it.icon;
        return (
          <div key={it.tool} style={{ display: "contents" }}>
            {(i === 2 || i === 9) && <div className="hc-dock-sep" />}
            <button
              type="button"
              className={`hc-tool${p.tool === it.tool ? " on" : ""}`}
              title={`${p.t(it.key)} (${it.hot})`}
              aria-label={p.t(it.key)}
              aria-pressed={p.tool === it.tool}
              onClick={() => click(it.tool)}
            >
              {it.tool === "sticker" && p.tool === "sticker" ? (
                <span style={{ fontSize: 17, lineHeight: 1 }}>{p.emoji}</span>
              ) : (
                <Icon size={18} strokeWidth={1.9} />
              )}
              <span className="hc-hot">{it.hot}</span>
            </button>
          </div>
        );
      })}
      <div className="hc-dock-sep" />
      <button
        type="button"
        className="hc-tool"
        title={p.t("image")}
        aria-label={p.t("image")}
        onClick={p.onImage}
      >
        <ImageIcon size={18} strokeWidth={1.9} />
        <span className="hc-hot">I</span>
      </button>

      {pop === "shape" && (
        <div className="hc-pop hc-float">
          {SHAPES.map((s) => (
            <button
              key={s.kind}
              type="button"
              className={`hc-shape-opt${p.shape === s.kind ? " on" : ""}`}
              title={p.ru ? s.ru : s.en}
              onClick={() => {
                p.onShape(s.kind);
                p.onTool("shape");
                setPop(null);
              }}
            >
              <svg width={34} height={26} viewBox="0 0 34 26">
                <path
                  d={shapePath(s.kind, 28, 20, 6)}
                  transform="translate(3 3)"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ))}
        </div>
      )}
      {pop === "sticker" && (
        <div className="hc-pop hc-float">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              className={`hc-shape-opt${p.emoji === e ? " on" : ""}`}
              onClick={() => {
                p.onEmoji(e);
                p.onTool("sticker");
                setPop(null);
              }}
            >
              <span style={{ fontSize: 20 }}>{e}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
