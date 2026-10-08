import { useMemo, type CSSProperties, type ReactNode } from "react";
import { sanitizeNode, type CNode } from "@/pages/myspace/m3e/lib/custom";
import { onToken, type ColorToken, type Palette } from "@/pages/myspace/m3e/lib/tokens";

const ROLE: Record<string, { size: number; weight: number; line: number }> = {
  headline: { size: 24, weight: 700, line: 1.2 },
  title: { size: 16, weight: 600, line: 1.3 },
  body: { size: 14, weight: 400, line: 1.4 },
  label: { size: 12, weight: 500, line: 1.3 },
  caption: { size: 11, weight: 400, line: 1.3 },
};

const FLEX_ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
const FLEX_JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
};

function Sym({ name, size, color }: { name: string; size: number; color?: string }) {
  return (
    <span
      className="msr"
      aria-hidden
      style={{ fontSize: size, color, width: size, height: size, lineHeight: 1 }}
    >
      {name}
    </span>
  );
}

/** Цвет текста и значков: роль на залитом фоне читается поверх него, на прозрачном — поверх экрана. */
function colorOf(
  c: ColorToken | "variant" | "primary" | undefined,
  p: Palette,
  on: string,
): string {
  if (!c) return on;
  if (c === "variant") return p.onSurfaceVariant;
  if (c === "primary") return p.primary;
  // токен фона, выбранный как цвет, означает «цвет, читаемый на этом фоне»
  return onToken(c, p);
}

function render(n: CNode, p: Palette, on: string, key: number, inRow: boolean): ReactNode {
  const grow = "grow" in n && n.grow ? { flex: `${n.grow} 1 0`, minWidth: 0 } : {};
  switch (n.t) {
    case "box": {
      const pad = Array.isArray(n.pad) ? `${n.pad[1]}px ${n.pad[0]}px` : (n.pad ?? 0);
      const fill = n.fill ? p[n.fill] : undefined;
      const text = n.fill ? onToken(n.fill, p) : on;
      const style: CSSProperties = {
        display: "flex",
        flexDirection: n.dir === "row" ? "row" : "column",
        gap: n.gap ?? 0,
        padding: pad,
        background: fill,
        borderRadius: n.r ?? 0,
        border: n.border ? `1px solid ${p[n.border]}` : undefined,
        alignItems: FLEX_ALIGN[n.align ?? (n.dir === "row" ? "center" : "stretch")],
        justifyContent: n.justify ? FLEX_JUSTIFY[n.justify] : undefined,
        width: n.w,
        height: n.h,
        boxSizing: "border-box",
        minWidth: 0,
        ...grow,
        color: text,
      };
      return (
        <div key={key} style={style}>
          {(n.c ?? []).map((c, i) => render(c, p, text, i, n.dir === "row"))}
        </div>
      );
    }
    case "text": {
      const r = ROLE[n.role ?? "body"];
      return (
        <div
          key={key}
          style={{
            fontSize: r.size,
            fontWeight: n.bold ? 700 : r.weight,
            lineHeight: r.line,
            color: colorOf(n.color, p, on),
            textAlign: n.align,
            overflow: "hidden",
            textOverflow: "ellipsis",
            ...grow,
          }}
        >
          {n.s}
        </div>
      );
    }
    case "icon": {
      const size = n.size ?? 24;
      const bg = n.bg ? p[n.bg] : undefined;
      const fg = n.bg
        ? n.color
          ? colorOf(n.color, p, on)
          : onToken(n.bg, p)
        : colorOf(n.color, p, on);
      if (!bg) return <Sym key={key} name={n.n} size={size} color={fg} />;
      const d = Math.round(size * 1.8);
      return (
        <div
          key={key}
          style={{
            width: d,
            height: d,
            borderRadius: d / 2,
            background: bg,
            display: "grid",
            placeItems: "center",
            flex: "0 0 auto",
          }}
        >
          <Sym name={n.n} size={size} color={fg} />
        </div>
      );
    }
    case "button": {
      const v = n.v ?? "filled";
      const look: CSSProperties =
        v === "filled"
          ? { background: p.primary, color: p.onPrimary }
          : v === "tonal"
            ? { background: p.secondaryContainer, color: p.onSecondaryContainer }
            : v === "outlined"
              ? { border: `1px solid ${p.outline}`, color: p.primary }
              : { color: p.primary };
      return (
        <div
          key={key}
          style={{
            height: 40,
            padding: v === "text" ? "0 12px" : "0 20px",
            borderRadius: 20,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
            boxSizing: "border-box",
            ...look,
            ...grow,
          }}
        >
          {n.icon && <Sym name={n.icon} size={18} />}
          {n.s}
        </div>
      );
    }
    case "chip":
      return (
        <div
          key={key}
          style={{
            height: 32,
            padding: "0 12px",
            borderRadius: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            boxSizing: "border-box",
            flex: "0 0 auto",
            ...(n.on
              ? { background: p.secondaryContainer, color: p.onSecondaryContainer }
              : { border: `1px solid ${p.outlineVariant}`, color: p.onSurfaceVariant }),
          }}
        >
          {n.icon && <Sym name={n.icon} size={16} />}
          {n.s}
        </div>
      );
    case "avatar": {
      const size = n.size ?? 40;
      const fill = n.fill ?? "primaryContainer";
      return (
        <div
          key={key}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            background: p[fill],
            color: onToken(fill, p),
            display: "grid",
            placeItems: "center",
            fontSize: Math.round(size * 0.4),
            fontWeight: 600,
            flex: "0 0 auto",
          }}
        >
          {n.s ?? ""}
        </div>
      );
    }
    case "image":
      return (
        <div
          key={key}
          style={{
            height: n.h ?? 120,
            width: n.w ?? (inRow ? undefined : "100%"),
            borderRadius: n.r ?? 16,
            background: p.primaryContainer,
            color: p.onPrimaryContainer,
            display: "grid",
            placeItems: "center",
            flex: n.grow ? `${n.grow} 1 0` : "0 0 auto",
            minWidth: 0,
            boxSizing: "border-box",
          }}
        >
          <Sym name={n.icon ?? "image"} size={Math.min(48, Math.round((n.h ?? 120) * 0.4))} />
        </div>
      );
    case "progress":
      return (
        <div
          key={key}
          style={{
            height: 6,
            borderRadius: 3,
            background: p.surfaceContainerHighest,
            overflow: "hidden",
            minWidth: 24,
            alignSelf: "center",
            width: n.grow ? undefined : "100%",
            ...grow,
          }}
        >
          <div
            style={{ width: `${n.v}%`, height: "100%", background: p.primary, borderRadius: 3 }}
          />
        </div>
      );
    case "switch":
      return (
        <div
          key={key}
          style={{
            width: 48,
            height: 28,
            borderRadius: 14,
            flex: "0 0 auto",
            background: n.on ? p.primary : p.surfaceContainerHighest,
            border: n.on ? "none" : `2px solid ${p.outline}`,
            boxSizing: "border-box",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: n.on ? 4 : 6,
              left: n.on ? 24 : 6,
              width: n.on ? 20 : 12,
              height: n.on ? 20 : 12,
              borderRadius: "50%",
              background: n.on ? p.onPrimary : p.outline,
            }}
          />
        </div>
      );
    case "badge":
      return (
        <div
          key={key}
          style={{
            padding: "2px 8px",
            borderRadius: 10,
            background: p.primary,
            color: p.onPrimary,
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: "nowrap",
            flex: "0 0 auto",
          }}
        >
          {n.s}
        </div>
      );
    case "divider":
      return (
        <div
          key={key}
          style={{
            height: 1,
            background: p.outlineVariant,
            alignSelf: "stretch",
            flex: "0 0 auto",
          }}
        />
      );
    case "spacer":
      return <div key={key} style={{ flex: `${n.grow ?? 1} 1 0` }} />;
  }
}

/** Содержимое составного элемента: заполняет отведённую ему область. */
export function CustomBody({ node: raw, p }: { node: CNode | undefined; p: Palette }) {
  /* документ мог прийти из файла или ссылки: рисуем только то, что прошло проверку */
  const node = useMemo(() => sanitizeNode(raw), [raw]);
  if (!node) return null;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        color: p.onSurface,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {render(
        node.t === "box" ? { ...node, w: undefined, h: undefined, grow: 1 } : node,
        p,
        p.onSurface,
        0,
        false,
      )}
    </div>
  );
}
