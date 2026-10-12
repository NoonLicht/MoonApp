import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  H,
  Item,
  Kind,
  Palette,
  R_INNER,
  SPLIT_GAP,
  SPLIT_MAIN_SLOT,
  SPLIT_MENU_ITEM_H,
  SPLIT_MENU_PAD,
  SPLIT_MENU_SHEET_GAP,
  SPLIT_MENU_SLOT,
  buttonHeightOf,
  chipHeightOf,
  chipMetrics,
  extendedFabHeight,
  extendedFabMetrics,
  menuOpen,
  buttonMetrics,
  scaleR,
  menuRises,
  splitMetrics,
  variantShadow,
  variantStyle,
} from "@/pages/myspace/m3e/lib/tokens";
import { useWeight, Icon, RippleShape } from "@/pages/myspace/m3e/components/M3Ripple";
import {
  MENU_ROLL,
  MENU_STAGGER,
  MENU_SHUT,
  MENU_EASE,
  FabMenuContent,
} from "@/pages/myspace/m3e/components/M3Menu";

export const ellipsis = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

export const NO_BOX: Kind[] = [
  "circularProgress",
  "linearProgress",
  "loadingIndicator",
  "switch",
  "checkbox",
  "radio",
  "slider",
  "text",
  "divider",
  "splitButton",
  "fabMenu",
  "carousel",
  "rating",
  "segmentedButton",
];

/** Padding follows M3: icon+label is tighter than label alone. */
export function ButtonContent({ item }: { item: Item }) {
  const w = useWeight();
  const hasIcon = !!item.icon;
  const hasLabel = item.label.trim().length > 0;
  /* padding, gap, icon and label all come from the M3 size the height lands on;
   * with no label the icon is centred instead, which makes the button a circle */
  const m = buttonMetrics(buttonHeightOf(item));
  const padX = hasLabel ? m.padX : Math.round((m.h - m.icon) / 2);
  return (
    <span
      className="m3-size-ease"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: item.size ? "100%" : undefined,
        boxSizing: "border-box",
        gap: hasIcon && hasLabel ? m.gap : 0,
        paddingLeft: padX,
        paddingRight: padX,
        height: m.h,
        fontSize: m.font,
        fontWeight: w(500, 700),
        letterSpacing: 0.1,
        whiteSpace: "nowrap",
      }}
    >
      {hasIcon && <Icon name={item.icon!} size={m.icon} fill={item.variant === "filled"} />}
      {hasLabel && <span>{item.label}</span>}
    </span>
  );
}

export function ExtendedFabContent({ item }: { item: Item }) {
  const w = useWeight();
  const hasIcon = !!item.icon;
  const hasLabel = item.label.trim().length > 0;
  /* the padding, the icon and the label are the ones the height it was given asks for */
  const m = extendedFabMetrics(extendedFabHeight(item));
  return (
    <span
      className="m3-size-ease"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: hasIcon && hasLabel ? m.gap : 0,
        paddingLeft: m.padX,
        paddingRight: m.padX,
        height: m.h,
        fontSize: m.font,
        fontWeight: w(500, 700),
        whiteSpace: "nowrap",
      }}
    >
      {hasIcon && <Icon name={item.icon!} size={m.icon} />}
      {hasLabel && <span>{item.label}</span>}
    </span>
  );
}

export function ChipContent({ item, p }: { item: Item; p: Palette }) {
  const on = !!item.checked;
  const lead = on ? "check" : item.icon;
  /* the padding, the icon and the label are the ones the height it was given asks for */
  const m = chipMetrics(chipHeightOf(item));
  return (
    <span
      className="m3-size-ease"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: m.gap,
        paddingLeft: lead ? m.lead : m.padX,
        paddingRight: m.padX,
        height: m.h,
        fontSize: m.font,
        fontWeight: 500,
        whiteSpace: "nowrap",
        color: on ? p.onSecondaryContainer : undefined,
      }}
    >
      {lead && <Icon name={lead} size={m.icon} />}
      <span>{item.label}</span>
    </span>
  );
}

export function SwitchContent({ item, p }: { item: Item; p: Palette }) {
  const hasLabel = item.label.trim().length > 0;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 14,
        height: H - 8,
        whiteSpace: "nowrap",
        width: item.size ? "100%" : undefined,
        justifyContent: item.size ? "space-between" : undefined,
      }}
    >
      {hasLabel && (
        <span
          style={{ fontSize: 16, color: p.onSurface, overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {item.label}
        </span>
      )}
      <SwitchControl on={!!item.checked} p={p} />
    </span>
  );
}

/** the M3 switch track and handle, 52 × 32 */
export function SwitchControl({ on, p }: { on: boolean; p: Palette }) {
  return (
    <span
      style={{
        position: "relative",
        width: 52,
        height: 32,
        borderRadius: 16,
        background: on ? p.primary : p.surfaceContainerHighest,
        border: on ? "2px solid transparent" : `2px solid ${p.outline}`,
        boxSizing: "border-box",
        flex: "0 0 auto",
        transition: "background 160ms",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "50%",
          left: on ? 22 : 4,
          width: on ? 24 : 16,
          height: on ? 24 : 16,
          marginTop: on ? -12 : -8,
          borderRadius: 12,
          background: on ? p.onPrimary : p.outline,
          display: "grid",
          placeItems: "center",
          color: p.onPrimaryContainer,
          transition: "left 160ms, width 160ms, height 160ms",
        }}
      >
        {on && <Icon name="check" size={16} weight={600} />}
      </span>
    </span>
  );
}

export function CheckboxContent({ item, p }: { item: Item; p: Palette }) {
  const on = !!item.checked;
  const hasLabel = item.label.trim().length > 0;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 40,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{ width: 40, height: 40, display: "grid", placeItems: "center", flex: "0 0 auto" }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 3,
            boxSizing: "border-box",
            border: on ? "none" : `2px solid ${p.onSurfaceVariant}`,
            background: on ? p.primary : "transparent",
            color: p.onPrimary,
            display: "grid",
            placeItems: "center",
          }}
        >
          {on && <Icon name="check" size={16} weight={700} />}
        </span>
      </span>
      {hasLabel && (
        <span style={{ fontSize: 16, color: p.onSurface, paddingRight: 8 }}>{item.label}</span>
      )}
    </span>
  );
}

export function TextContent({ item, p }: { item: Item; p: Palette }) {
  const w = useWeight();
  const fs = item.size ?? 28;
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: fs,
        lineHeight: 1.3,
        fontWeight: item.bold ? w(700, 800) : w(400, fs >= 22 ? 600 : 500),
        letterSpacing: fs >= 28 ? -0.25 : 0,
        color: p.onSurface,
        whiteSpace: "nowrap",
        padding: "0 2px",
      }}
    >
      {item.label || " "}
    </span>
  );
}

/** A split button: the labeled action and, after a hairline gap, the arrow that opens its menu.
 *  Both segments are read off the button scale the height lands on, and they keep their own
 *  corners, so the box around them stays plain. */
export function SplitButtonContent({ item, p, open }: { item: Item; p: Palette; open?: boolean }) {
  const w = useWeight();
  const reducedMotion = useReducedMotion();
  const st = variantStyle(item.variant, p);
  const h = buttonHeightOf(item);
  const m = splitMetrics(h);
  const outer = scaleR(h / 2);
  const inner = scaleR(R_INNER);
  const hasLabel = item.label.trim().length > 0;
  /* with no label the icon is centred instead, the way a button with none is */
  const padX = hasLabel ? m.padX : Math.round((m.h - m.icon) / 2);
  const shadow = variantShadow(item.variant);
  return (
    <span
      className="m3-size-ease"
      style={{ display: "inline-flex", alignItems: "center", gap: SPLIT_GAP, height: m.h }}
    >
      <span
        className="m3-size-ease"
        data-part-shape={SPLIT_MAIN_SLOT}
        style={{
          ...st,
          display: "inline-flex",
          alignItems: "center",
          gap: hasLabel && item.icon ? m.gap : 0,
          height: m.h,
          paddingLeft: padX,
          paddingRight: padX,
          borderTopLeftRadius: outer,
          borderBottomLeftRadius: outer,
          borderTopRightRadius: inner,
          borderBottomRightRadius: inner,
          fontSize: m.font,
          fontWeight: w(500, 700),
          whiteSpace: "nowrap",
          boxSizing: "border-box",
          boxShadow: shadow,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {item.icon && <Icon name={item.icon} size={m.icon} fill={item.variant === "filled"} />}
        {hasLabel && <span>{item.label}</span>}
        <RippleShape part={SPLIT_MAIN_SLOT} />
      </span>
      <span
        className="m3-size-ease"
        data-part-shape={SPLIT_MENU_SLOT}
        style={{
          ...st,
          display: "inline-grid",
          placeItems: "center",
          position: "relative",
          overflow: "hidden",
          /* the segment is as wide as its arrow with its own padding, so it eases like the other one */
          height: m.h,
          paddingLeft: m.trailPadX,
          paddingRight: m.trailPadX,
          /* opening the menu rounds this segment right off, the way M3 does it; the segment with
             the words keeps the shape it had */
          borderTopLeftRadius: open ? outer : inner,
          borderBottomLeftRadius: open ? outer : inner,
          borderTopRightRadius: outer,
          borderBottomRightRadius: outer,
          boxSizing: "border-box",
          boxShadow: shadow,
        }}
      >
        {/* the arrow turns over while the menu it opened is showing */}
        <span
          style={{
            display: "inline-flex",
            transform: open ? "rotate(180deg)" : "none",
            transition: reducedMotion ? "none" : "transform 200ms cubic-bezier(0.2, 0, 0, 1)",
          }}
        >
          <Icon name="keyboard_arrow_down" size={m.icon} />
        </span>
        <RippleShape part={SPLIT_MENU_SLOT} />
      </span>
    </span>
  );
}

/** Whether a menu is drawn open, on its way out, or not yet. The preview draws its screens
 *  inside an AnimatePresence that blocks animations on mount, so a menu is drawn shut for one
 *  frame and told to open on the next, where nothing blocks it. A menu that has never been open
 *  starts rolled up; one on its way out only gives way a little, because what carries it off is
 *  the fade. */
export function useOpenPhase(shown: boolean): "shut" | "open" | "closing" {
  const [phase, setPhase] = useState<"shut" | "open" | "closing">("shut");
  useEffect(() => {
    if (!shown) {
      setPhase((was) => (was === "shut" ? "shut" : "closing"));
      return;
    }
    const id = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(id);
  }, [shown]);
  return phase;
}

/** A split button with its menu open: the button where the author put it, and the sheet of
 *  entries beside it -- below the button where the screen has room, above it where it does not.
 *  The sheet grows out of the edge nearest the button, so the two read as one gesture. */
export function SplitMenuContent({
  item,
  p,
  shown = true,
}: {
  item: Item;
  p: Palette;
  shown?: boolean;
}) {
  const w = useWeight();
  const reducedMotion = useReducedMotion();
  const up = menuRises(item);
  const tabs = item.tabs ?? [];
  const phase = useOpenPhase(shown);
  const open = phase === "open";
  const sheet = (
    <motion.div
      initial={false}
      animate={{ opacity: open ? 1 : 0, scaleY: open ? 1 : 0.7 }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : { duration: open ? MENU_ROLL : MENU_SHUT, ease: MENU_EASE }
      }
      style={{
        /* it unrolls out of the edge the button is on */
        transformOrigin: up ? "50% 100%" : "50% 0%",
        background: p.surfaceContainer,
        color: p.onSurface,
        borderRadius: scaleR(12),
        padding: `${SPLIT_MENU_PAD}px 0`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.10)",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      {tabs.map((tab, i) => (
        <motion.div
          key={i}
          initial={false}
          /* the entry nearest the button is read first, so it is the first to arrive */
          animate={{ opacity: open ? 1 : 0 }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : open
                ? { duration: 0.12, delay: (up ? tabs.length - 1 - i : i) * MENU_STAGGER }
                : { duration: 0.06 }
          }
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            height: SPLIT_MENU_ITEM_H,
            padding: "0 12px",
            fontSize: 14,
            fontWeight: w(500, 700),
            whiteSpace: "nowrap",
            boxSizing: "border-box",
          }}
        >
          {tab.icon && <Icon name={tab.icon} size={24} />}
          <span style={ellipsis}>{tab.label}</span>
        </motion.div>
      ))}
    </motion.div>
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        justifyContent: up ? "flex-end" : "flex-start",
        gap: SPLIT_MENU_SHEET_GAP,
        height: "100%",
      }}
    >
      {up && sheet}
      {/* the button keeps its own width whatever the sheet under it comes to */}
      <span style={{ alignSelf: "flex-start" }}>
        <SplitButtonContent item={item} p={p} open={open} />
      </span>
      {!up && sheet}
    </div>
  );
}

export function RadioContent({ item, p }: { item: Item; p: Palette }) {
  const on = !!item.checked;
  const hasLabel = item.label.trim().length > 0;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 40,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{ width: 40, height: 40, display: "grid", placeItems: "center", flex: "0 0 auto" }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            boxSizing: "border-box",
            border: `2px solid ${on ? p.primary : p.onSurfaceVariant}`,
            display: "grid",
            placeItems: "center",
          }}
        >
          {on && <span style={{ width: 10, height: 10, borderRadius: 5, background: p.primary }} />}
        </span>
      </span>
      {hasLabel && (
        <span style={{ fontSize: 16, color: p.onSurface, paddingRight: 8 }}>{item.label}</span>
      )}
    </span>
  );
}

/** Content for kinds that size to their text; rendered again offscreen to measure. */
export function MeasuredContent({ item, p }: { item: Item; p: Palette }) {
  if (menuOpen(item))
    return item.kind === "splitButton" ? (
      <SplitMenuContent item={item} p={p} />
    ) : (
      <FabMenuContent item={item} p={p} />
    );
  switch (item.kind) {
    case "button":
      return <ButtonContent item={item} />;
    case "extendedFab":
      return <ExtendedFabContent item={item} />;
    case "chip":
      return <ChipContent item={item} p={p} />;
    case "switch":
      return <SwitchContent item={item} p={p} />;
    case "checkbox":
      return <CheckboxContent item={item} p={p} />;
    case "text":
      return <TextContent item={item} p={p} />;
    case "splitButton":
      return <SplitButtonContent item={item} p={p} />;
    case "radio":
      return <RadioContent item={item} p={p} />;
    case "fabMenu":
      return <FabMenuContent item={item} p={p} />;
    default:
      return null;
  }
}
