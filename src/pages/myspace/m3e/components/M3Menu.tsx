import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  FAB_MENU_CLOSE,
  FAB_MENU_GAP,
  FAB_MENU_ITEM_H,
  Item,
  Palette,
  extendedFabHeight,
  extendedFabMetrics,
  menuOpen,
  scaleR,
  variantStyle,
} from "@/pages/myspace/m3e/lib/tokens";
import { useWeight, Icon } from "@/pages/myspace/m3e/components/M3Ripple";
import { ellipsis, useOpenPhase } from "@/pages/myspace/m3e/components/M3Content";

/** how long one entry takes to unroll, and how far apart the entries start */
export const MENU_ROLL = 0.28;
export const MENU_STAGGER = 0.045;
/** how long the button takes to reach the M size. A FAB taller than that reaches up into the row
 *  the nearest entry stands in, so the two are never on screen together: opening, the entries wait
 *  for the button to come down to size; shutting, the button waits for the entries to go. */
export const MENU_BUTTON_ROLL = 0.16;
/** shutting is not the unrolling backwards: the entries give way a little and fade, from the far
 *  end down, so the menu is gone long before a full reverse run would have finished */
export const MENU_SHUT = 0.16;
/** the one frame the drawing is swapped on, held long enough for the box not to ease across it */
export const MENU_SNAP_MS = 60;
export const MENU_SHUT_FADE = 0.1;
export const MENU_SHUT_STAGGER = 0.025;
export const MENU_SHUT_SCALE = 0.72;
export const MENU_BUTTON_SHUT = 0.16;
export const MENU_EASE = [0.2, 0, 0, 1] as const;

/** how long the whole reverse run takes, in milliseconds */
export const menuShutMs = (it: Item) => {
  const entries = menuEntriesShut(it);
  return Math.round(Math.max(entries, menuButtonWait(it) + MENU_BUTTON_SHUT) * 1000);
};

/** how long every entry takes to fade away */
export const menuEntriesShut = (it: Item) =>
  MENU_SHUT_FADE + Math.max(0, (it.tabs?.length ?? 1) - 1) * MENU_SHUT_STAGGER;
/** a FAB that reaches above the close button takes its turn; one that does not never waits */
export const overTall = (it: Item) => (it.size ?? FAB_MENU_CLOSE) > FAB_MENU_CLOSE;
/** what the button waits for before growing back: every entry gone */
export const menuButtonWait = (it: Item) => (overTall(it) ? menuEntriesShut(it) : 0);
/** what the entries wait for before unrolling: the button down to the close size */
export const menuEntriesWait = (it: Item) => (overTall(it) ? MENU_BUTTON_ROLL : 0);

/** Whether the menu is drawn at all, and whether it is drawn open. The two part ways while the
 *  menu shuts: the node keeps its open shape, transparent and as tall as the entries, until they
 *  have rolled back into the button, and only then becomes the FAB again. */
export function useMenuPhase(item: Item) {
  const open = menuOpen(item);
  const [drawn, setDrawn] = useState(open);
  /* read by the effect without restarting it: only the menu opening or closing may do that */
  const drawnRef = useRef(open);
  /** the frame the drawing is swapped on: the box must not ease its height across the swap */
  const [snap, setSnap] = useState(false);
  const shutMs = menuShutMs(item);
  useEffect(() => {
    if (open) {
      drawnRef.current = true;
      setDrawn(true);
      return;
    }
    if (!drawnRef.current) return;
    const id = setTimeout(() => {
      drawnRef.current = false;
      setDrawn(false);
      setSnap(true);
    }, shutMs);
    return () => clearTimeout(id);
  }, [open, shutMs]);
  useEffect(() => {
    if (!snap) return;
    const id = setTimeout(() => setSnap(false), MENU_SNAP_MS);
    return () => clearTimeout(id);
  }, [snap]);
  return { drawn, open, snap };
}

/** A FAB with its menu open: the entries it offers, and the button itself showing the close
 *  icon under them. The button stays where the author put it and grows or shrinks into the M-size
 *  close button; the entries unroll out of its right edge, the one nearest the button first.
 *  Nothing here changes the drawing's size, so the editor can measure it while it moves, and the
 *  menu is exactly as wide as its widest entry. */
export function FabMenuContent({
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
  const tabs = item.tabs ?? [];
  const filled = item.variant === "filled";
  const itemStyle = filled
    ? { background: p.primaryContainer, color: p.onPrimaryContainer }
    : { background: p.secondaryContainer, color: p.onSecondaryContainer };
  const extended = item.kind === "extendedFab";
  /* the close button is the M size: a small or a large FAB eases into it rather than jumping */
  const grow = (item.size ?? FAB_MENU_CLOSE) / FAB_MENU_CLOSE;
  /* opening, the entry nearest the button leads; shutting, the run plays back from the far end */
  const wait = menuEntriesWait(item);
  const after = (i: number) => wait + (tabs.length - 1 - i) * MENU_STAGGER;
  const before = (i: number) => i * MENU_SHUT_STAGGER;
  const phase = useOpenPhase(shown);
  const open = phase === "open";
  const closing = phase === "closing";
  const roll = (i: number) =>
    reducedMotion
      ? { duration: 0 }
      : open
        ? { duration: MENU_ROLL, ease: MENU_EASE, delay: after(i) }
        : { duration: MENU_SHUT, ease: MENU_EASE, delay: before(i) };
  const fade = (i: number) =>
    reducedMotion
      ? { duration: 0 }
      : open
        ? { duration: 0.12, delay: after(i) + MENU_ROLL * 0.55 }
        : { duration: 0.06, delay: before(i) };
  /* an entry is not there at all until its own roll begins, so a menu waiting its turn shows no
     slivers stacked over the button; on the way out it is the fade that takes it */
  const show = (i: number) =>
    reducedMotion
      ? { duration: 0 }
      : open
        ? { duration: 0, delay: after(i) }
        : closing
          ? { duration: MENU_SHUT_FADE, ease: MENU_EASE, delay: before(i) }
          : { duration: 0 };
  return (
    /* the column hangs from the bottom: the button keeps its place while the box above it grows */
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        gap: FAB_MENU_GAP,
        height: "100%",
      }}
    >
      {tabs.map((tab, i) => (
        <motion.span
          key={i}
          /* the entry arrives with its roll and leaves by fading, part way through a roll it
             never finishes */
          initial={false}
          animate={{ opacity: open ? 1 : 0 }}
          transition={show(i)}
          style={{
            position: "relative",
            color: itemStyle.color,
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            height: FAB_MENU_ITEM_H,
            padding: "0 24px 0 20px",
            fontSize: 16,
            fontWeight: w(500, 700),
            whiteSpace: "nowrap",
            maxWidth: "100%",
            boxSizing: "border-box",
            flex: "0 0 auto",
          }}
        >
          {/* the pill itself unrolls from its right edge, so the entry opens towards the text */}
          <motion.span
            aria-hidden
            initial={false}
            animate={{ scaleX: open ? 1 : closing ? MENU_SHUT_SCALE : 0.06 }}
            transition={roll(i)}
            style={{
              ...itemStyle,
              position: "absolute",
              inset: 0,
              transformOrigin: "100% 50%",
              borderRadius: scaleR(28),
              boxShadow: "0 1px 3px rgba(0,0,0,0.16)",
            }}
          />
          {/* the icon and the label arrive once there is a pill wide enough to hold them */}
          <motion.span
            initial={false}
            animate={{ opacity: open ? 1 : 0 }}
            transition={fade(i)}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: 12,
              minWidth: 0,
            }}
          >
            {tab.icon && <Icon name={tab.icon} size={22} />}
            <span style={ellipsis}>{tab.label}</span>
          </motion.span>
        </motion.span>
      ))}
      <motion.span
        /* scaled rather than resized: the button, its icon and its corners all land on the M size
           together, and the drawing the editor measures never changes width */
        initial={false}
        animate={extended ? undefined : { scale: open ? 1 : grow }}
        transition={
          reducedMotion
            ? { duration: 0 }
            : open
              ? { duration: MENU_BUTTON_ROLL, ease: MENU_EASE }
              : { duration: MENU_BUTTON_SHUT, ease: MENU_EASE, delay: menuButtonWait(item) }
        }
        style={{
          /* the button the menu hangs off is the FAB itself, wearing the icon that shuts it */
          ...variantStyle(item.variant, p),
          transformOrigin: "100% 100%",
          width: extended ? undefined : FAB_MENU_CLOSE,
          height: extended ? extendedFabHeight(item) : FAB_MENU_CLOSE,
          padding: extended ? "0 20px" : undefined,
          gap: 12,
          fontSize: 16,
          fontWeight: w(500, 700),
          whiteSpace: "nowrap",
          borderRadius: scaleR(
            extended
              ? extendedFabMetrics(extendedFabHeight(item)).radius
              : Math.round(FAB_MENU_CLOSE * 0.28),
          ),
          display: "grid",
          placeItems: "center",
          boxShadow: "0 3px 8px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)",
          flex: "0 0 auto",
        }}
      >
        {/* the cross and the button's own icon trade places, so the swap at either end is
            between two drawings that already match */}
        <span style={{ display: "grid", placeItems: "center", gridArea: "1 / 1" }}>
          <motion.span
            initial={false}
            animate={{ opacity: open ? 1 : 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.1, delay: open ? 0.04 : 0 }}
            style={{ gridArea: "1 / 1", display: "grid", placeItems: "center" }}
          >
            <Icon name="close" size={24} />
          </motion.span>
          {item.icon && (
            <motion.span
              initial={false}
              animate={{ opacity: open ? 0 : 1 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { duration: 0.1, delay: open ? 0 : menuButtonWait(item) + 0.04 }
              }
              style={{ gridArea: "1 / 1", display: "grid", placeItems: "center" }}
            >
              <Icon name={item.icon} size={24} />
            </motion.span>
          )}
        </span>
        {extended && item.label.trim() && <span style={{ gridArea: "1 / 2" }}>{item.label}</span>}
      </motion.span>
    </div>
  );
}
