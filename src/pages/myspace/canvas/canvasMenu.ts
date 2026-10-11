import type { TranslateFn } from "@/app/i18n";
import type { strings } from "@/pages/myspace/canvas/strings";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Obj, Pt } from "@/pages/myspace/canvas/model";
import type { InspectorActions } from "@/pages/myspace/canvas/Inspector";
import type { MenuItem } from "@/pages/myspace/canvas/ContextMenu";
import type { useBoard } from "@/pages/myspace/canvas/useBoard";

/** Зависимости контекстного меню: всё, что оно вызывает на странице. */
export interface CanvasMenuDeps {
  selRef: MutableRefObject<string[]>;
  byIdRef: MutableRefObject<Map<string, Obj>>;
  clientToWorld: (cx: number, cy: number) => Pt;
  tr: TranslateFn;
  t: ReturnType<typeof strings>;
  openLinked: (o: Obj) => boolean;
  copyBoardLink: (o: Obj) => void;
  setEditing: Dispatch<SetStateAction<string | null>>;
  actions: InspectorActions;
  copySel: (cut?: boolean) => void;
  clip: MutableRefObject<string>;
  pasteInternal: (text: string, at?: Pt) => void;
  duplicate: (dx?: number, dy?: number) => void;
  removeSel: () => void;
  board: ReturnType<typeof useBoard>;
  tidy: () => void;
  fitAll: () => void;
  setSel: (ids: string[]) => void;
}

/** Пункты меню правой кнопки: для выделенного объекта или для пустого места. */
export function buildCanvasMenu(clientX: number, clientY: number, d: CanvasMenuDeps): MenuItem[] {
  const { selRef, byIdRef, clientToWorld, tr, t, openLinked, copyBoardLink, setEditing, actions, copySel, clip, pasteInternal, duplicate, removeSel, board, tidy, fitAll, setSel } = d;
  const has = selRef.current.length > 0;
  const pt = clientToWorld(clientX, clientY);
  const only = selRef.current.length === 1 ? byIdRef.current.get(selRef.current[0]) : undefined;
  const canText =
    !!only && !only.locked && ["shape", "sticky", "text", "task", "frame"].includes(only.type);
  const canFill = selRef.current.some((s) => {
    const o = byIdRef.current.get(s);
    return !!o && ["shape", "sticky", "task", "frame", "text"].includes(o.type);
  });
  const multi = selRef.current.length > 1;
  const anyGroup = selRef.current.some((s) => byIdRef.current.get(s)?.type === "group");
  const items: MenuItem[] = has
    ? [
        ...(only && (only.type === "link" || (only.type === "note" && only.path))
          ? [{ label: tr("canvasPage.open"), hint: "2×", onClick: () => openLinked(only) }]
          : []),
        ...(only && only.type !== "line" && only.type !== "group"
          ? [
              {
                label: tr("canvasPage.copyLinkForNote"),
                onClick: () => copyBoardLink(only),
              },
            ]
          : []),
        ...(canText
          ? [{ label: t("edit"), hint: "Enter", onClick: () => setEditing(only!.id) }]
          : []),
        ...(canFill
          ? [
              {
                label: "",
                onClick: () => undefined,
                swatches: {
                  colors: [
                    "#ffffff",
                    "#fef08a",
                    "#bbf7d0",
                    "#bfdbfe",
                    "#fbcfe8",
                    "#fed7aa",
                    "#ddd6fe",
                    "#e5e7eb",
                    "#1f2937",
                  ],
                  onPick: (c: string) => actions.patch({ fill: c }, "fill"),
                },
              },
              { sep: true, label: "", onClick: () => undefined },
            ]
          : []),
        { label: t("cut"), hint: "Ctrl+X", onClick: () => copySel(true) },
        { label: t("copy"), hint: "Ctrl+C", onClick: () => copySel() },
        {
          label: t("paste"),
          hint: "Ctrl+V",
          onClick: () => clip.current && pasteInternal(clip.current, pt),
          disabled: !clip.current,
        },
        { label: t("duplicate"), hint: "Ctrl+D", onClick: () => duplicate() },
        { sep: true, label: "", onClick: () => undefined },
        ...(multi ? [{ label: t("group"), hint: "Ctrl+G", onClick: actions.group }] : []),
        ...(anyGroup ? [{ label: t("ungroup"), hint: "Ctrl+⇧G", onClick: actions.ungroup }] : []),
        { label: t("front"), hint: "Ctrl+⇧]", onClick: () => actions.order("front") },
        { label: t("back"), hint: "Ctrl+⇧[", onClick: () => actions.order("back") },
        { label: t("lock"), hint: "Ctrl+⇧L", onClick: actions.lock },
        { label: t("hide"), onClick: actions.hide },
        { sep: true, label: "", onClick: () => undefined },
        { label: t("del"), hint: "Del", danger: true, onClick: removeSel },
      ]
    : [
        {
          label: t("paste"),
          hint: "Ctrl+V",
          onClick: () => clip.current && pasteInternal(clip.current, pt),
          disabled: !clip.current,
        },
        {
          label: t("selectAll"),
          hint: "Ctrl+A",
          onClick: () =>
            setSel(board.ref.current.filter((o) => !o.parent && !o.hidden).map((o) => o.id)),
        },
        {
          label: t("delAll"),
          danger: true,
          disabled: board.ref.current.length === 0,
          onClick: () => {
            setSel([]);
            board.apply(() => []);
          },
        },
        { label: t("tidy"), onClick: tidy },
        { label: t("fit"), hint: "⇧1", onClick: fitAll },
      ];

  return items;
}
