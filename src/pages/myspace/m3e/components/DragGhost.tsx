import { baseRadii, connectSpecOf, fontFamilyOf } from "@/pages/myspace/m3e/lib/tokens";
import { motion } from "motion/react";
import { M3Node } from "@/pages/myspace/m3e/components/M3Node";
import { VANISH } from "@/pages/myspace/m3e/lib/editorState";
import type React from "react";
import type { View, DragState } from "@/pages/myspace/m3e/lib/editorState";
import type { Theme, Palette, Group, Axis, Radii } from "@/pages/myspace/m3e/lib/tokens";
import type { Lang } from "@/pages/myspace/m3e/lib/i18n";
import type { MotionValue } from "motion/react";

export interface DragGhostProps {
  r: DOMRect | undefined;
  view: View;
  theme: Theme;
  lang: Lang;
  drag: DragState | null;
  sx: MotionValue<number>;
  sy: MotionValue<number>;
  dp: Palette;
  widths: Record<string, number>;
  dragLit: { x: number; y: number; at: number; } | null;
  groupsRef: React.MutableRefObject<Group[]>;
  runRadii: (axis: Axis, first: boolean, last: boolean, prevPh: boolean, nextPh: boolean, pull: number, outer: number, inner: number) => Radii;
}

export default function DragGhost({ r, view, theme, lang, drag, sx, sy, dp, widths, dragLit, groupsRef, runRadii }: DragGhostProps) {
  return (
    <div
                        aria-hidden
                        style={{
                          position: "fixed",
                          inset: 0,
                          pointerEvents: "none",
                          zIndex: 60,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            left: 0,
                            top: 0,
                            transform: `translate(${(r?.left ?? 0) + view.x}px, ${(r?.top ?? 0) + view.y}px) scale(${view.z})`,
                            transformOrigin: "0 0",
                            fontFamily: fontFamilyOf(theme.font, lang),
                          }}
                        >
                          {/* the part in flight */}
                          {drag?.active && (
                            <motion.div
                              style={{
                                position: "absolute",
                                left: 0,
                                top: 0,
                                x: sx,
                                y: sy,
                                pointerEvents: "none",
                                zIndex: 50,
                              }}
                              animate={{
                                opacity: drag.vanishing ? 0 : drag.overBin ? 0.4 : 1,
                                scale: drag.vanishing ? 0.6 : drag.overBin ? 0.84 : 1,
                              }}
                              transition={
                                drag.vanishing
                                  ? VANISH
                                  : {
                                      type: "spring",
                                      stiffness: 520,
                                      damping: 34,
                                      mass: 0.6,
                                    }
                              }
                            >
                              <M3Node
                                item={drag.item}
                                palette={dp}
                                widths={widths}
                                lit={dragLit}
                                dragging
                                radii={(() => {
                                  const conn = connectSpecOf(drag.item);
                                  if (!conn || !drag.snap) return baseRadii(drag.item);
                                  const g = groupsRef.current.find((x) => x.id === drag.snap!.groupId);
                                  const mm = (g?.items.length ?? 0) + 1;
                                  const k = drag.snap.index;
                                  return runRadii(
                                    conn.axis,
                                    k === 0,
                                    k === mm - 1,
                                    k > 0,
                                    k < mm - 1,
                                    drag.snap.pull,
                                    conn.outer,
                                    conn.inner,
                                  );
                                })()}
                              />
                            </motion.div>
                          )}
                        </div>
                      </div>
  );
}
