import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { api } from "@/api/client";
import { FONTS, type LineGeom, type Obj, type ShapeKind } from "@/pages/myspace/canvas/model";

/* ───────────── геометрия фигур ───────────── */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Контур фигуры в её собственных координатах (0..w, 0..h). */
export function shapePath(kind: ShapeKind, w: number, h: number, radius: number): string {
  const R = Math.max(0, Math.min(radius, w / 2, h / 2));
  switch (kind) {
    case "rect":
      return `M0 0H${w}V${h}H0Z`;
    case "rounded":
      return `M${R} 0H${w - R}Q${w} 0 ${w} ${R}V${h - R}Q${w} ${h} ${w - R} ${h}H${R}Q0 ${h} 0 ${h - R}V${R}Q0 0 ${R} 0Z`;
    case "ellipse": {
      const rx = w / 2;
      const ry = h / 2;
      return `M0 ${ry}A${rx} ${ry} 0 1 0 ${w} ${ry}A${rx} ${ry} 0 1 0 0 ${ry}Z`;
    }
    case "diamond":
      return `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
    case "triangle":
      return `M${w / 2} 0L${w} ${h}L0 ${h}Z`;
    case "hexagon": {
      const k = Math.min(w * 0.25, h * 0.5);
      return `M${k} 0H${w - k}L${w} ${h / 2}L${w - k} ${h}H${k}L0 ${h / 2}Z`;
    }
    case "parallelogram": {
      const k = Math.min(w * 0.22, h);
      return `M${k} 0H${w}L${w - k} ${h}H0Z`;
    }
    case "cylinder": {
      const e = Math.min(h * 0.18, w * 0.25);
      return `M0 ${e}A${w / 2} ${e} 0 0 1 ${w} ${e}V${h - e}A${w / 2} ${e} 0 0 1 0 ${h - e}ZM0 ${e}A${w / 2} ${e} 0 0 0 ${w} ${e}`;
    }
    case "star": {
      const cx = w / 2;
      const cy = h / 2;
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (-90 + i * 36) * (Math.PI / 180);
        const rr = i % 2 === 0 ? 1 : 0.42;
        pts.push(`${r2(cx + Math.cos(a) * (w / 2) * rr)} ${r2(cy + Math.sin(a) * (h / 2) * rr)}`);
      }
      return `M${pts.join("L")}Z`;
    }
    case "cloud": {
      const x = (v: number) => r2(w * v);
      const y = (v: number) => r2(h * v);
      return (
        `M${x(0.25)} ${y(0.85)}` +
        `C${x(0.05)} ${y(0.85)} ${x(0)} ${y(0.55)} ${x(0.14)} ${y(0.5)}` +
        `C${x(0.08)} ${y(0.25)} ${x(0.3)} ${y(0.12)} ${x(0.42)} ${y(0.26)}` +
        `C${x(0.5)} ${y(0.02)} ${x(0.8)} ${y(0.08)} ${x(0.8)} ${y(0.34)}` +
        `C${x(1.02)} ${y(0.34)} ${x(1.04)} ${y(0.72)} ${x(0.84)} ${y(0.74)}` +
        `C${x(0.84)} ${y(0.92)} ${x(0.55)} ${y(0.95)} ${x(0.5)} ${y(0.82)}` +
        `C${x(0.42)} ${y(0.95)} ${x(0.3)} ${y(0.95)} ${x(0.25)} ${y(0.85)}Z`
      );
    }
    case "arrow": {
      const t = h * 0.28;
      const head = Math.min(w * 0.4, h);
      return `M0 ${t}H${w - head}V0L${w} ${h / 2}L${w - head} ${h}V${h - t}H0Z`;
    }
    case "chat": {
      const body = h * 0.82;
      const rr = Math.min(R || 16, body / 2, w / 2);
      return `M${rr} 0H${w - rr}Q${w} 0 ${w} ${rr}V${body - rr}Q${w} ${body} ${w - rr} ${body}H${w * 0.38}L${w * 0.22} ${h}L${w * 0.26} ${body}H${rr}Q0 ${body} 0 ${body - rr}V${rr}Q0 0 ${rr} 0Z`;
    }
  }
}

/** Доля габарита, внутри которой помещается текст: [слева, сверху, справа, снизу]. */
function textInset(kind: ShapeKind | undefined): [number, number, number, number] {
  switch (kind) {
    case "ellipse":
      return [0.14, 0.14, 0.14, 0.14];
    case "diamond":
      return [0.25, 0.25, 0.25, 0.25];
    case "triangle":
      return [0.25, 0.4, 0.25, 0.05];
    case "hexagon":
      return [0.14, 0.04, 0.14, 0.04];
    case "parallelogram":
      return [0.16, 0.04, 0.16, 0.04];
    case "cylinder":
      return [0.04, 0.24, 0.04, 0.1];
    case "star":
      return [0.28, 0.3, 0.28, 0.22];
    case "cloud":
      return [0.14, 0.24, 0.14, 0.2];
    case "arrow":
      return [0.04, 0.2, 0.3, 0.2];
    case "chat":
      return [0.04, 0.04, 0.04, 0.22];
    default:
      return [0.02, 0.02, 0.02, 0.02];
  }
}

const lum = (hex: string): number => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
/** Цвет текста, читаемый на заливке. */
export const inkOn = (fill?: string): string =>
  !fill || fill === "none" || fill === "transparent"
    ? "var(--text-primary)"
    : lum(fill) < 0.5
      ? "#ffffff"
      : "#1c1d2b";

const DASH = { solid: undefined, dashed: "10 7", dotted: "2 7" } as const;

/* ───────────── текст ───────────── */

function textStyle(o: Obj): CSSProperties {
  const ink =
    o.tc ?? (o.type === "text" ? (o.fill ? inkOn(o.fill) : "var(--text-primary)") : inkOn(o.fill));
  return {
    fontFamily: FONTS[o.ff ?? "sans"],
    fontSize: o.fs ?? 16,
    fontWeight: o.fw ?? 500,
    fontStyle: o.italic ? "italic" : "normal",
    textAlign: o.ta ?? "left",
    color: ink,
    lineHeight: 1.3,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  };
}

const VA = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

function TextBlock({
  o,
  editing,
  onCommit,
  box,
  placeholder,
}: {
  o: Obj;
  editing: boolean;
  onCommit: (text: string, cancel?: boolean) => void;
  box?: CSSProperties;
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    done.current = false;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);
  const finish = (cancel = false) => {
    if (done.current) return;
    done.current = true;
    onCommit(ref.current?.innerText.replace(/\n$/, "") ?? "", cancel);
  };
  const text = o.text ?? "";
  return (
    <div
      style={{
        position: "absolute",
        display: "flex",
        flexDirection: "column",
        justifyContent: VA[o.va ?? "middle"],
        boxSizing: "border-box",
        padding: "6px 8px",
        pointerEvents: "none",
        ...box,
      }}
    >
      <div
        ref={ref}
        data-nodrag={editing ? "1" : undefined}
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={false}
        onPointerDown={(e) => editing && e.stopPropagation()}
        onBlur={() => editing && finish()}
        onKeyDown={(e) => {
          if (!editing) return;
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            finish();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            finish();
          }
        }}
        style={{
          ...textStyle(o),
          outline: "none",
          pointerEvents: editing ? "auto" : "none",
          cursor: editing ? "text" : undefined,
          minHeight: "1.3em",
          userSelect: editing ? "text" : "none",
          caretColor: "currentColor",
          opacity: !editing && !text && placeholder ? 0.35 : 1,
        }}
      >
        {editing ? text : text || placeholder || ""}
      </div>
    </div>
  );
}

/* ───────────── объекты ───────────── */

export interface ViewProps {
  o: Obj;
  editing: boolean;
  selected: boolean;
  geom?: LineGeom;
  onCommit: (id: string, text: string, cancel?: boolean) => void;
  onPatch: (id: string, patch: Partial<Obj>, history?: boolean) => void;
  onMeasure: (id: string, h: number) => void;
}

function Heads({ g, o }: { g: LineGeom; o: Obj }) {
  const color = o.stroke ?? "#8b7bf0";
  const s = Math.max(8, (o.sw ?? 2) * 4);
  const head = (kind: string | undefined, e: { x: number; y: number }, ang: number, k: string) => {
    if (!kind || kind === "none") return null;
    if (kind === "dot") return <circle key={k} cx={e.x} cy={e.y} r={s * 0.4} fill={color} />;
    const tri = `M0 0L${-s} ${-s * 0.5}L${-s} ${s * 0.5}Z`;
    return (
      <g key={k} transform={`translate(${e.x} ${e.y}) rotate(${ang})`}>
        {kind === "triangle" ? (
          <path d={tri} fill={color} />
        ) : (
          <path
            d={`M${-s} ${-s * 0.55}L0 0L${-s} ${s * 0.55}`}
            fill="none"
            stroke={color}
            strokeWidth={o.sw ?? 2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </g>
    );
  };
  return (
    <>
      {head(o.h1, g.a, g.angA, "a")}
      {head(o.h2, g.b, g.angB, "b")}
    </>
  );
}

function ObjectViewInner(props: ViewProps) {
  const { o, editing, geom, onCommit, onPatch, onMeasure } = props;
  const wrap: CSSProperties = {
    position: "absolute",
    left: o.x,
    top: o.y,
    width: o.w,
    height: o.h,
    transform: o.rot ? `rotate(${o.rot}deg)` : undefined,
    transformOrigin: "50% 50%",
    opacity: o.hidden ? 0.0 : o.type === "frame" ? 1 : (o.opacity ?? 1),
    display: o.hidden ? "none" : undefined,
    pointerEvents: "none",
  };
  const commit = (text: string, cancel?: boolean) => onCommit(o.id, text, cancel);

  /* автовысота текстового блока */
  const autoRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (o.type !== "text" || !o.auto || !autoRef.current) return;
    const el = autoRef.current;
    const h = Math.max(24, Math.ceil(el.scrollHeight));
    if (Math.abs(h - o.h) > 1) onMeasure(o.id, h);
  });

  /* превью заметки подгружается один раз */
  useEffect(() => {
    if (o.type !== "note" || o.preview !== undefined || !o.path) return;
    let live = true;
    api
      .myspaceRead(o.path)
      .then((f: { content?: string }) => {
        if (!live) return;
        const preview = (f?.content || "").replace(/[#*`>\-[\]]/g, "").slice(0, 420);
        onPatch(o.id, { preview }, false);
      })
      .catch(() => live && onPatch(o.id, { preview: "⚠" }, false));
    return () => {
      live = false;
    };
  }, [o.type, o.preview, o.path, o.id, onPatch]);

  switch (o.type) {
    case "shape": {
      const kind = o.shape ?? "rounded";
      const [il, it, ir, ib] = textInset(kind);
      const sw = o.sw ?? 2;
      return (
        <div style={wrap} data-oid={o.id}>
          <svg
            width={o.w}
            height={o.h}
            viewBox={`0 0 ${o.w} ${o.h}`}
            style={{
              position: "absolute",
              inset: 0,
              overflow: "visible",
              filter: o.shadow ? "drop-shadow(0 6px 10px rgba(0,0,0,0.28))" : undefined,
            }}
          >
            <path
              d={shapePath(kind, o.w, o.h, o.radius ?? 16)}
              fill={o.fill && o.fill !== "none" ? o.fill : "transparent"}
              stroke={sw > 0 ? (o.stroke ?? "#1f2937") : "none"}
              strokeWidth={sw}
              strokeDasharray={DASH[o.dash ?? "solid"]}
              strokeLinejoin="round"
              style={{ pointerEvents: "all" }}
              data-oid={o.id}
            />
          </svg>
          <TextBlock
            o={o}
            editing={editing}
            onCommit={commit}
            box={{
              left: o.w * il,
              top: o.h * it,
              width: o.w * (1 - il - ir),
              height: o.h * (1 - it - ib),
            }}
          />
        </div>
      );
    }
    case "sticky":
      return (
        <div
          style={{
            ...wrap,
            background: o.fill ?? "#fef08a",
            borderRadius: o.radius ?? 6,
            boxShadow: o.shadow
              ? "0 10px 18px -6px rgba(0,0,0,0.35), 0 2px 4px rgba(0,0,0,0.2)"
              : undefined,
            pointerEvents: "auto",
          }}
          data-oid={o.id}
        >
          <TextBlock
            o={o}
            editing={editing}
            onCommit={commit}
            box={{ inset: 0 }}
            placeholder="Заметка"
          />
        </div>
      );
    case "text":
      return (
        <div
          style={{ ...wrap, height: o.auto ? "auto" : o.h, minHeight: o.h, pointerEvents: "auto" }}
          data-oid={o.id}
        >
          <div ref={autoRef} style={{ position: "relative" }}>
            <TextBlock
              o={{ ...o, va: "top" }}
              editing={editing}
              onCommit={commit}
              box={{ position: "relative" }}
              placeholder="Текст"
            />
          </div>
        </div>
      );
    case "frame": {
      const sw = o.sw ?? 1;
      return (
        <div style={wrap} data-oid={o.id}>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: -26,
              maxWidth: Math.max(60, o.w),
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              pointerEvents: "auto",
              cursor: "default",
              padding: "2px 2px",
            }}
            data-oid={o.id}
            data-frame-title="1"
          >
            {editing ? (
              <input
                autoFocus
                data-nodrag="1"
                defaultValue={o.name ?? ""}
                onPointerDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => commit(e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") commit(o.name ?? "", true);
                }}
                style={{
                  font: "inherit",
                  color: "var(--text-primary)",
                  background: "var(--surface-solid)",
                  border: "1px solid var(--glass-border)",
                  borderRadius: 6,
                  padding: "1px 6px",
                  outline: "none",
                  width: Math.max(120, o.w * 0.6),
                }}
              />
            ) : (
              (o.name ?? "Рамка")
            )}
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: o.radius ?? 12,
              background: o.fill && o.fill !== "none" ? o.fill : "transparent",
              boxShadow: o.shadow ? "0 14px 30px rgba(0,0,0,0.25)" : undefined,
              opacity: o.opacity ?? 1,
            }}
          />
          <svg
            width={o.w}
            height={o.h}
            style={{ position: "absolute", inset: 0, overflow: "visible" }}
          >
            <rect
              x={0}
              y={0}
              width={o.w}
              height={o.h}
              rx={o.radius ?? 12}
              fill="none"
              stroke={sw > 0 ? (o.stroke ?? "#94a3b8") : "transparent"}
              strokeWidth={sw}
              strokeDasharray={DASH[o.dash ?? "solid"]}
              style={{ pointerEvents: "stroke" }}
              data-oid={o.id}
            />
          </svg>
        </div>
      );
    }
    case "image":
      return (
        <div
          style={{
            ...wrap,
            pointerEvents: "auto",
            borderRadius: o.radius ?? 8,
            overflow: "hidden",
          }}
          data-oid={o.id}
        >
          <img
            src={o.src}
            alt=""
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "fill",
              display: "block",
              userSelect: "none",
            }}
          />
        </div>
      );
    case "sticker":
      return (
        <div
          style={{
            ...wrap,
            display: "grid",
            placeItems: "center",
            fontSize: Math.min(o.w, o.h) * 0.78,
            lineHeight: 1,
            pointerEvents: "auto",
            userSelect: "none",
          }}
          data-oid={o.id}
        >
          {o.emoji}
        </div>
      );
    case "stroke": {
      const pts = o.pts ?? [];
      const d = pts.length
        ? `M${pts[0][0]} ${pts[0][1]}` +
          pts
            .slice(1)
            .map((p, i) => {
              const prev = pts[i];
              return `Q${prev[0]} ${prev[1]} ${(prev[0] + p[0]) / 2} ${(prev[1] + p[1]) / 2}`;
            })
            .join("") +
          `L${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`
        : "";
      return (
        <div style={wrap} data-oid={o.id}>
          <svg
            viewBox={`0 0 ${o.bw ?? o.w} ${o.bh ?? o.h}`}
            width={o.w}
            height={o.h}
            preserveAspectRatio="none"
            style={{ position: "absolute", inset: 0, overflow: "visible" }}
          >
            <path
              d={d}
              fill="none"
              stroke={o.stroke ?? "#f59e0b"}
              strokeWidth={o.sw ?? 4}
              strokeOpacity={o.opacity ?? 1}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: "stroke" }}
              data-oid={o.id}
            />
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: "stroke" }}
              data-oid={o.id}
            />
          </svg>
        </div>
      );
    }
    case "line": {
      if (!geom) return null;
      const dash = DASH[o.dash ?? "solid"];
      return (
        <svg
          width={1}
          height={1}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            pointerEvents: "none",
            display: o.hidden ? "none" : undefined,
          }}
          data-oid={o.id}
        >
          <path
            d={geom.d}
            fill="none"
            stroke="transparent"
            strokeWidth={16}
            style={{ pointerEvents: "stroke" }}
            data-oid={o.id}
          />
          <path
            d={geom.d}
            fill="none"
            stroke={o.stroke ?? "#8b7bf0"}
            strokeWidth={o.sw ?? 2}
            strokeDasharray={o.animated ? "8 6" : dash}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={o.animated ? { animation: "holst-dash 0.9s linear infinite" } : undefined}
          />
          <Heads g={geom} o={o} />
          {(o.text || editing) && (
            <foreignObject
              x={geom.mid.x - 80}
              y={geom.mid.y - 16}
              width={160}
              height={32}
              style={{ overflow: "visible" }}
            >
              <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
                <div
                  contentEditable={editing}
                  suppressContentEditableWarning
                  ref={(el) => {
                    if (el && editing && document.activeElement !== el) {
                      el.focus();
                      const r = document.createRange();
                      r.selectNodeContents(el);
                      const s = window.getSelection();
                      s?.removeAllRanges();
                      s?.addRange(r);
                    }
                  }}
                  data-nodrag={editing ? "1" : undefined}
                  onPointerDown={(e) => editing && e.stopPropagation()}
                  onBlur={(e) => editing && commit(e.currentTarget.innerText)}
                  onKeyDown={(e) => {
                    if (!editing) return;
                    e.stopPropagation();
                    if (e.key === "Enter" || e.key === "Escape") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                  style={{
                    background: "var(--surface-solid)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 8,
                    padding: "2px 8px",
                    fontSize: 13,
                    outline: "none",
                    pointerEvents: editing ? "auto" : "none",
                    whiteSpace: "pre",
                    userSelect: editing ? "text" : "none",
                  }}
                >
                  {o.text}
                </div>
              </div>
            </foreignObject>
          )}
        </svg>
      );
    }
    case "task": {
      const status = o.status ?? "todo";
      const col = status === "done" ? "#22c55e" : status === "inprogress" ? "#f59e0b" : "#94a3b8";
      const label =
        status === "done" ? "Готово" : status === "inprogress" ? "В работе" : "К выполнению";
      const subs = o.subtasks ?? [];
      return (
        <div
          style={{
            ...wrap,
            pointerEvents: "auto",
            background: o.fill ?? "#ffffff",
            borderRadius: o.radius ?? 14,
            border: `1px solid rgba(0,0,0,0.12)`,
            boxShadow: "0 8px 16px -8px rgba(0,0,0,0.35)",
            color: "#1c1d2b",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
          data-oid={o.id}
        >
          <div style={{ height: 4, background: col, flex: "0 0 auto" }} />
          <div style={{ position: "relative", flex: "0 0 auto", minHeight: 44 }}>
            <TextBlock
              o={{ ...o, fs: 15, fw: 600, va: "top", ta: "left", tc: "#1c1d2b" }}
              editing={editing}
              onCommit={commit}
              box={{ position: "relative" }}
              placeholder="Название задачи"
            />
          </div>
          <div style={{ padding: "0 10px 6px", display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              data-nodrag="1"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() =>
                onPatch(o.id, {
                  status:
                    status === "todo" ? "inprogress" : status === "inprogress" ? "done" : "todo",
                })
              }
              style={{
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
                padding: "3px 9px",
                borderRadius: 999,
                background: `${col}33`,
                color: status === "todo" ? "#475569" : col,
              }}
            >
              {label}
            </button>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              data-nodrag="1"
              title="Добавить подзадачу"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onPatch(o.id, { subtasks: [...subs, { text: "Шаг", done: false }] })}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 16,
                color: "#64748b",
              }}
            >
              +
            </button>
          </div>
          <div style={{ padding: "0 10px 8px", overflow: "auto", display: "grid", gap: 4 }}>
            {subs.map((s, i) => (
              <label
                key={i}
                data-nodrag="1"
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={s.done}
                  onChange={() =>
                    onPatch(o.id, {
                      subtasks: subs.map((x, j) => (j === i ? { ...x, done: !x.done } : x)),
                    })
                  }
                />
                <input
                  value={s.text}
                  onChange={(e) =>
                    onPatch(
                      o.id,
                      {
                        subtasks: subs.map((x, j) =>
                          j === i ? { ...x, text: e.target.value } : x,
                        ),
                      },
                      false,
                    )
                  }
                  onKeyDown={(e) => e.stopPropagation()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    outline: "none",
                    textDecoration: s.done ? "line-through" : undefined,
                    opacity: s.done ? 0.55 : 1,
                    font: "inherit",
                  }}
                />
              </label>
            ))}
          </div>
        </div>
      );
    }
    case "note":
      return (
        <div
          style={{
            ...wrap,
            pointerEvents: "auto",
            background: o.fill ?? "#ffffff",
            borderRadius: o.radius ?? 14,
            border: "1px solid rgba(0,0,0,0.12)",
            boxShadow: "0 8px 16px -8px rgba(0,0,0,0.35)",
            color: "#1c1d2b",
            padding: 12,
            boxSizing: "border-box",
            overflow: "hidden",
          }}
          data-oid={o.id}
          title={o.path}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: "#8b7bf0", marginBottom: 4 }}>
            📄 Заметка
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{o.text}</div>
          <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.35 }}>{o.preview ?? "…"}</div>
        </div>
      );
    default:
      return null;
  }
}

export const ObjectView = memo(ObjectViewInner, (a, b) => {
  const p = a;
  const n = b;
  return (
    p.o === n.o &&
    p.editing === n.editing &&
    p.selected === n.selected &&
    (p.geom?.d ?? "") === (n.geom?.d ?? "") &&
    p.geom?.mid.x === n.geom?.mid.x &&
    p.geom?.mid.y === n.geom?.mid.y
  );
});
