import { frameSizeOf, frameLengthOf, type FramePreset } from "@/pages/myspace/m3e/lib/tokens";
import { draftGradient, BEZEL, clamp, FRAME_LABEL_H, uiFontFamily, SETTLE_MS } from "@/pages/myspace/m3e/lib/tokens";
import { FrameSizePicker } from "@/pages/myspace/m3e/components/Inspector";
import { t } from "@/pages/myspace/m3e/lib/i18n";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { modalRailOf } from "@/pages/myspace/m3e/lib/rail";
import { LoadingIndicator } from "@/pages/myspace/m3e/components/Loading";
import { maxFrameLength } from "@/pages/myspace/m3e/lib/tidy";
import type React from "react";
import type { View } from "@/pages/myspace/m3e/lib/editorState";
import type { Frame, Palette, Group } from "@/pages/myspace/m3e/lib/tokens";
import type { Lang } from "@/pages/myspace/m3e/lib/i18n";

/** a screen changing size eases the way a settling part does */
export const SIZE_TRANSITION = `width ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1), height ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1), border-radius ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`;

/** While the model works on a screen, the scheme's colors drift through its bezel. */
export function ThinkingRing({ p, frame }: { p: Palette; frame: Frame }) {
  const still = useReducedMotion();
  const w = frameSizeOf(frame).w + BEZEL * 2;
  const h = frameLengthOf(frame) + BEZEL * 2;
  const d = Math.ceil(Math.hypot(w, h)) + 80;
  const stops = [
    p.primary,
    p.tertiaryContainer,
    p.inversePrimary,
    p.secondaryContainer,
    p.primaryContainer,
    p.primary,
  ];
  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      <motion.div
        animate={still ? undefined : { rotate: 360 }}
        transition={{ repeat: Infinity, duration: 3.2, ease: "linear" }}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: d,
          height: d,
          marginLeft: -d / 2,
          marginTop: -d / 2,
          background: `conic-gradient(from 0deg, ${stops.join(", ")})`,
          filter: "blur(22px)",
        }}
      />
    </motion.div>
  );
}

export interface FrameCardProps {
  f: Frame;
  easing: boolean;
  onFramePointerDown: (e: React.PointerEvent, f: Frame) => void;
  view: View;
  on: boolean;
  p: Palette;
  handMode: boolean;
  lang: Lang;
  setFramePreset: (id: string, preset: FramePreset | { w: number; h: number; }) => void;
  w: number;
  h: number;
  radius: 40 | 28;
  dp: Palette;
  draftBusy: boolean;
  lengthDragId: string | null;
  aiFrameId: string | null;
  bg: string;
  groups: Group[];
  frameOf: Map<string, string>;
  renderGroup: (g: Group, ox: number, oy: number) => React.JSX.Element;
  fold: number;
  canvasBg: string;
  selectedMinLength: number;
  onLengthHandleDown: (e: React.PointerEvent, f: Frame) => void;
  onLengthHandleKey: (e: React.KeyboardEvent, f: Frame) => void;
}

export default function FrameCard({ f, easing, onFramePointerDown, view, on, p, handMode, lang, setFramePreset, w, h, radius, dp, draftBusy, lengthDragId, aiFrameId, bg, groups, frameOf, renderGroup, fold, canvasBg, selectedMinLength, onLengthHandleDown, onLengthHandleKey }: FrameCardProps) {
  return (
    <div
                              
                              data-frame={f.id}
                              style={{
                                position: "absolute",
                                left: f.x,
                                top: f.y,
                                transition: easing
                                  ? `left ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
                                  : undefined,
                              }}
                            >
                              <div
                                onPointerDown={(e) => onFramePointerDown(e, f)}
                                style={{
                                  position: "absolute",
                                  left: -BEZEL,
                                  top: -BEZEL - FRAME_LABEL_H,
                                  height: FRAME_LABEL_H,
                                  /* follows the zoom, softened: a little larger when zoomed out, a little smaller when zoomed in */
                                  transform: `scale(${clamp(1 / view.z, 0.7, 1.4)})`,
                                  transformOrigin: "left bottom",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  padding: "0 8px",
                                  fontSize: 20,
                                  fontWeight: 600,
                                  color: on ? p.primary : p.onSurfaceVariant,
                                  transition: "color 160ms",
                                  cursor: handMode ? "grab" : "move",
                                  userSelect: "none",
                                  whiteSpace: "nowrap",
                                  fontFamily: uiFontFamily(lang),
                                }}
                              >
                                <div onPointerDown={(e) => e.stopPropagation()}>
                                  <FrameSizePicker
                                    frame={f}
                                    onChange={(preset) => setFramePreset(f.id, preset)}
                                    palette={p}
                                    compact
                                  />
                                </div>
                                {f.name || t("screen", lang)}
                              </div>
                              <div
                                onPointerDown={(e) => onFramePointerDown(e, f)}
                                style={{
                                  position: "absolute",
                                  left: -BEZEL,
                                  top: -BEZEL,
                                  overflow: "hidden",
                                  width: w + BEZEL * 2,
                                  height: h + BEZEL * 2,
                                  borderRadius: radius + BEZEL,
                                  /* the chosen screen's bezel is painted in the theme's primary; the others stay dark */
                                  backgroundColor: on ? dp.primary : dp.inverseSurface,
                                  backgroundImage: draftBusy ? draftGradient(dp) : undefined,
                                  backgroundSize: draftBusy ? "300% 300%" : undefined,
                                  animation: draftBusy
                                    ? "m3e-drift 3s ease-in-out infinite"
                                    : undefined,
                                  boxShadow: on
                                    ? "0 18px 50px rgba(0,0,0,0.16)"
                                    : "0 18px 50px rgba(0,0,0,0.14)",
                                  cursor: handMode ? "grab" : "move",
                                  transition:
                                    lengthDragId === f.id
                                      ? "background-color 160ms, box-shadow 120ms"
                                      : `background-color 160ms, box-shadow 120ms, ${SIZE_TRANSITION}`,
                                }}
                              >
                                <AnimatePresence>
                                  {aiFrameId === f.id && <ThinkingRing key="ring" p={dp} frame={f} />}
                                </AnimatePresence>
                                <div
                                  data-screen={f.id}
                                  style={{
                                    position: "absolute",
                                    left: BEZEL,
                                    top: BEZEL,
                                    width: w,
                                    height: h,
                                    borderRadius: radius,
                                    background: bg,
                                    overflow: "hidden",
                                    transition: lengthDragId === f.id ? undefined : SIZE_TRANSITION,
                                  }}
                                >
                                  {groups
                                    .filter((g) => frameOf.get(g.id) === f.id)
                                    .map((g) => renderGroup(g, f.x, f.y))}
                                  {groups.some((g) => frameOf.get(g.id) === f.id && modalRailOf(g)) && (
                                    <div
                                      aria-hidden
                                      style={{
                                        position: "absolute",
                                        inset: 0,
                                        background: "rgba(0,0,0,0.32)",
                                        pointerEvents: "none",
                                        zIndex: 1,
                                      }}
                                    />
                                  )}
                                  {/* where the device ends on a screen that runs further: below it, the body scrolls */}
                                  {h > fold && (
                                    <div
                                      aria-hidden
                                      style={{
                                        position: "absolute",
                                        left: 0,
                                        right: 0,
                                        top: fold,
                                        borderTop: `2px dashed ${p.outline}`,
                                        opacity: 0.6,
                                        pointerEvents: "none",
                                        zIndex: 2,
                                      }}
                                    />
                                  )}
                                  {draftBusy && (
                                    <div
                                      style={{
                                        position: "absolute",
                                        inset: 0,
                                        zIndex: 90,
                                        background: canvasBg,
                                        display: "grid",
                                        placeItems: "center",
                                      }}
                                    >
                                      <LoadingIndicator size={96} color="url(#m3e-drafting)" />
                                    </div>
                                  )}
                                </div>
                              </div>
                              {/* the chosen screen's length grip, a small nub on its bottom bezel: drag it down and the body runs on */}
                              {on && !handMode && !draftBusy && (
                                <div
                                  role="slider"
                                  tabIndex={0}
                                  aria-label={t("screenLength", lang)}
                                  aria-valuemin={selectedMinLength}
                                  aria-valuemax={maxFrameLength(f)}
                                  aria-valuenow={h}
                                  onPointerDown={(e) => onLengthHandleDown(e, f)}
                                  onKeyDown={(e) => onLengthHandleKey(e, f)}
                                  style={{
                                    position: "absolute",
                                    left: w / 2 - 32,
                                    top: h - 4,
                                    width: 64,
                                    height: BEZEL + 8,
                                    display: "grid",
                                    placeItems: "center",
                                    transform: `scale(${clamp(1 / view.z, 1, 2)})`,
                                    cursor: "ns-resize",
                                    touchAction: "none",
                                    zIndex: 1,
                                    transition:
                                      lengthDragId === f.id
                                        ? undefined
                                        : `top ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`,
                                  }}
                                >
                                  <div
                                    style={{
                                      width: 40,
                                      height: 4,
                                      borderRadius: 2,
                                      background: dp.onPrimary,
                                      opacity: 0.9,
                                    }}
                                  />
                                </div>
                              )}
                            </div>
  );
}
