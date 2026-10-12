import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTheme } from "@/pages/myspace/m3e/lib/theme";
import { MENU_EASE } from "@/pages/myspace/m3e/components/M3Menu";

/** weight of a heading or label: heavier under the emphasized type setting */
export const useWeight = () => {
  const emphasized = useTheme().emphasized;
  return (normal: number, strong: number) => (emphasized ? strong : normal);
};

export function Icon({
  name,
  size = 24,
  color,
  fill,
  weight,
}: {
  name: string;
  size?: number;
  color?: string;
  fill?: boolean;
  weight?: number;
}) {
  return (
    <span
      className="msr"
      /* the ligature is a picture, not words: a screen reader should not spell out its name */
      aria-hidden
      data-fill={fill ? "1" : "0"}
      style={{
        fontSize: size,
        color,
        fontVariationSettings: weight
          ? `"FILL" ${fill ? 1 : 0}, "wght" ${weight}, "GRAD" 0, "opsz" 24`
          : undefined,
      }}
    >
      {name}
    </span>
  );
}

/** One touch of a part: where it landed, how far the circle has to travel to cover the shape it
 *  landed in, and which shape that was -- a split button's two halves light up one at a time. */
export type Ripple = {
  id: number;
  part: string | null;
  /** the finger or pointer that made it, so lifting one finger leaves another's light alone */
  pointer?: number;
  x: number;
  y: number;
  d: number;
  /** the size it starts at, as a part of the whole: a light handed from one drawing of a part to
   *  another carries on from where the first one had got to rather than starting over */
  from?: number;
  /** how long it has left to finish growing, in seconds */
  dur?: number;
};

/** how long a ripple takes to cover what it was started in */
export const RIPPLE_GROW = 0.42;

/** how far out of the point touched a circle must grow to cover the whole of an element */
export function rippleSize(r: { width: number; height: number }, x: number, y: number): number {
  return (
    2 *
    Math.max(
      Math.hypot(x, y),
      Math.hypot(r.width - x, y),
      Math.hypot(x, r.height - y),
      Math.hypot(r.width - x, r.height - y),
    )
  );
}

/** The circles themselves: they spread out of the point touched at the colour of whatever is
 *  written on the part -- white over a filled button -- and fade once the finger is off it.
 *  M3's pressed state layer is a tenth of that colour; the ripple arrives a shade stronger and
 *  settles onto it. The caller gives them something to be clipped by. */
export function Ripples({ list, color }: { list: Ripple[]; color: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {list.map((r) => (
        <motion.span
          key={r.id}
          aria-hidden
          initial={{ opacity: 0.16, scale: r.from ?? 0 }}
          animate={{ opacity: 0.12, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : {
                  scale: { duration: r.dur ?? RIPPLE_GROW, ease: MENU_EASE },
                  opacity: { duration: 0.3, ease: MENU_EASE },
                }
          }
          style={{
            position: "absolute",
            left: r.x - r.d / 2,
            top: r.y - r.d / 2,
            width: r.d,
            height: r.d,
            borderRadius: "50%",
            background: color,
            pointerEvents: "none",
          }}
        />
      ))}
    </AnimatePresence>
  );
}

/** what a part being pressed is lighting up, for the shapes drawn deep inside it to read */
export const RippleCtx = createContext<{ list: Ripple[]; color: string } | null>(null);

/** the light of a press, inside one shape of a part: the shape clips it and keeps its corners */
export function RippleShape({ part }: { part: string | null }) {
  const ctx = useContext(RippleCtx);
  if (!ctx) return null;
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        borderRadius: "inherit",
        pointerEvents: "none",
      }}
    >
      <Ripples list={ctx.list.filter((r) => r.part === part)} color={ctx.color} />
    </span>
  );
}

/** the touches a part is holding, and where each of them landed */
export function useRipples(on: boolean) {
  const [list, setList] = useState<Ripple[]>([]);
  const next = useRef(0);
  /* the light stays for as long as the finger is down, wherever it travels: a part being dragged
   * across the canvas keeps it, and it fades once the finger is lifted rather than at the edge
   * of the part. The release is watched on the window, because that is where a drag ends. */
  const waiting = useRef<(() => void) | null>(null);
  const end = () => {
    waiting.current?.();
    setList((rs) => (rs.length ? [] : rs));
  };
  const add = (e: React.PointerEvent) => {
    if (!on) return;
    /* only the main button of a mouse is a press: a right or a middle click opens nothing here */
    if (e.pointerType === "mouse" && e.button !== 0) return;
    /* a part made of more than one shape says which one was touched */
    const seg = (e.target as HTMLElement | null)?.closest?.(
      "[data-part-shape]",
    ) as HTMLElement | null;
    const el = seg ?? (e.currentTarget as HTMLElement);
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setList((rs) => [
      ...rs,
      { id: ++next.current, part: seg?.dataset.partShape ?? null, x, y, d: rippleSize(r, x, y) },
    ]);
    waiting.current?.();
    const done = () => {
      waiting.current = null;
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      setList((rs) => (rs.length ? [] : rs));
    };
    waiting.current = done;
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };
  /* a part taken off the canvas mid-press leaves no listener behind */
  useEffect(() => () => waiting.current?.(), []);
  return { list, add, end };
}
