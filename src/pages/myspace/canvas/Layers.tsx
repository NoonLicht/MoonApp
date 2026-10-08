import { useState } from "react";
import {
  Box,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  Frame,
  Image as ImageIcon,
  ListTodo,
  Lock,
  PenLine,
  Shapes,
  Smile,
  Spline,
  StickyNote,
  Type,
  FileText,
} from "lucide-react";
import type { Obj, ObjType } from "@/pages/myspace/canvas/model";
import type { Key } from "@/pages/myspace/canvas/strings";

const ICONS: Record<ObjType, typeof Box> = {
  shape: Shapes,
  text: Type,
  sticky: StickyNote,
  frame: Frame,
  group: Folder,
  line: Spline,
  stroke: PenLine,
  image: ImageIcon,
  task: ListTodo,
  note: FileText,
  sticker: Smile,
};

const label = (o: Obj, t: (k: Key) => string): string => {
  if (o.name) return o.name;
  if (o.type === "sticker") return o.emoji ?? "";
  const txt = (o.text ?? "").trim().replace(/\s+/g, " ");
  if (txt) return txt.slice(0, 28);
  switch (o.type) {
    case "frame":
      return t("frameName");
    case "group":
      return t("groupName");
    case "shape":
      return t("shape");
    case "sticky":
      return t("sticky");
    case "text":
      return t("text");
    case "line":
      return t("line");
    case "stroke":
      return t("pen");
    case "image":
      return t("image");
    case "task":
      return t("task");
    case "note":
      return t("note");
    default:
      return t("object");
  }
};

interface Props {
  objs: Obj[];
  sel: string[];
  t: (k: Key) => string;
  onSelect: (id: string, additive: boolean) => void;
  onToggle: (id: string, what: "hidden" | "locked") => void;
  onRename: (id: string, name: string) => void;
}

/** Список слоёв: сверху самые верхние, рамки и группы раскрываются. */
export function LayersPanel({ objs, sel, t, onSelect, onToggle, onRename }: Props) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const kids = new Map<string | null, Obj[]>();
  for (const o of objs) {
    const k = o.parent ?? null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k)!.push(o);
  }
  const rows: { o: Obj; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = [...(kids.get(parent) ?? [])].reverse();
    for (const o of list) {
      rows.push({ o, depth });
      if ((o.type === "frame" || o.type === "group") && !closed.has(o.id)) walk(o.id, depth + 1);
    }
  };
  walk(null, 0);

  if (rows.length === 0) return <div className="hc-layers-empty">{t("layersEmpty")}</div>;
  return (
    <div className="hc-layers">
      {rows.map(({ o, depth }) => {
        const Icon = ICONS[o.type] ?? Box;
        const container = o.type === "frame" || o.type === "group";
        return (
          <div
            key={o.id}
            className={`hc-layer${sel.includes(o.id) ? " on" : ""}${o.hidden ? " dim" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={(e) => onSelect(o.id, e.shiftKey || e.ctrlKey || e.metaKey)}
            onDoubleClick={() => setEditing(o.id)}
          >
            {container ? (
              <button
                type="button"
                className="hc-icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setClosed((s) => {
                    const n = new Set(s);
                    if (n.has(o.id)) n.delete(o.id);
                    else n.add(o.id);
                    return n;
                  });
                }}
              >
                <ChevronRight
                  size={13}
                  style={{
                    transform: closed.has(o.id) ? undefined : "rotate(90deg)",
                    transition: "transform .15s",
                  }}
                />
              </button>
            ) : (
              <span style={{ width: 20 }} />
            )}
            <Icon size={14} className="hc-layer-ico" />
            {editing === o.id ? (
              <input
                autoFocus
                className="hc-layer-input"
                defaultValue={label(o, t)}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  onRename(o.id, e.currentTarget.value);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span className="hc-layer-name">{label(o, t)}</span>
            )}
            <button
              type="button"
              className="hc-icon-sm"
              title={o.locked ? t("unlock") : t("lock")}
              style={{ opacity: o.locked ? 1 : undefined }}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(o.id, "locked");
              }}
            >
              {o.locked && <Lock size={12} />}
            </button>
            <button
              type="button"
              className="hc-icon-sm"
              title={o.hidden ? t("show") : t("hide")}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(o.id, "hidden");
              }}
            >
              {o.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
