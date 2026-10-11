import type { TidyState } from "@/pages/myspace/m3e/components/ui";
import { IconBtn, Segmented } from "@/pages/myspace/m3e/components/ui";
import { t } from "@/pages/myspace/m3e/lib/i18n";
import { PANEL_FADE_H } from "@/pages/myspace/m3e/components/ui";
import { FrameInspector } from "@/pages/myspace/m3e/components/FramePanel";
import { buildPrompt } from "@/pages/myspace/m3e/lib/prompt";
import { Inspector } from "@/pages/myspace/m3e/components/Inspector";
import { PromptPanel } from "@/pages/myspace/m3e/components/PromptPanel";
import { isPlatform } from "@/pages/myspace/m3e/lib/tokens";
import type React from "react";
import type { Palette, Frame, Item, Doc, Place, Group, FrameMode, FramePreset, Platform } from "@/pages/myspace/m3e/lib/tokens";
import type { Lang } from "@/pages/myspace/m3e/lib/i18n";
import type { AiActionKey } from "@/pages/myspace/m3e/components/AiPanel";

/** Перетаскивание ползунка длины кадра: исходное состояние и снимок для истории. */
export type LengthDrag = { from: { frames: Frame[]; groups: Group[] }; snap: () => void };

export interface EditorRightPanelProps {
  panelStyle: React.CSSProperties;
  rightW: number;
  setResizing: React.Dispatch<React.SetStateAction<"left" | "right" | null>>;
  p: Palette;
  promptCoverUp: boolean;
  lang: Lang;
  rightTab: "edit" | "prompt";
  setRightTab: React.Dispatch<React.SetStateAction<"edit" | "prompt">>;
  setRightOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedFrame: Frame | null;
  selected: Item | null;
  setFramePreset: (id: string, preset: FramePreset | { w: number; h: number; }) => void;
  patchFrame: (id: string, patch: Partial<Frame>) => void;
  deleteFrame: (id: string) => void;
  duplicateFrame: (id: string) => void;
  openPreview: (startId?: string | null) => void;
  doc: Doc;
  widths: Record<string, number>;
  saveFrameImage: (f: Frame) => Promise<void>;
  tidyState: TidyState | null;
  tidy: (f: Frame) => void;
  setPlace: (f: Frame, place: Place) => void;
  selectedMinLength: number;
  setFrameLength: (id: string, length: number, drag?: LengthDrag) => void;
  aiReady: boolean;
  aiReason: string | undefined;
  aiBusy: boolean;
  aiFrameId: string | null;
  runAi: (action: AiActionKey, f: Frame, itemId?: string) => Promise<void>;
  cancelAi: () => void;
  tidyTarget: Frame | null;
  selectedIds: string[];
  groups: Group[];
  selectedPartFrame: Frame | null;
  frame: FrameMode;
  frames: Frame[];
  patchSelected: (patch: Partial<Item>) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  selectedLocked: boolean;
  toggleLockSelected: () => void;
  selectionPlaceable: boolean;
  placeSelected: (col: "left" | "centerH" | "right", row: "top" | "centerV" | "bottom") => void;
  selectedRect: { x: number; y: number; w: number; h: number; } | null;
  onShowOn: (on: boolean) => void;
  onShowMenu: (on: boolean) => void;
  selectedGroup: Group | null;
  selectionWhole: boolean;
  groupSelected: () => void;
  ungroupSelected: () => void;
  setPromptCoverUp: React.Dispatch<React.SetStateAction<boolean>>;
  setTitle: React.Dispatch<React.SetStateAction<string>>;
  setBrief: React.Dispatch<React.SetStateAction<string>>;
  setPromptEdit: React.Dispatch<React.SetStateAction<string | undefined>>;
  setPromptOptions: React.Dispatch<React.SetStateAction<string[] | undefined>>;
  setPlatform: React.Dispatch<React.SetStateAction<Platform | null>>;
}

export default function EditorRightPanel({ panelStyle, rightW, setResizing, p, promptCoverUp, lang, rightTab, setRightTab, setRightOpen, selectedFrame, selected, setFramePreset, patchFrame, deleteFrame, duplicateFrame, openPreview, doc, widths, saveFrameImage, tidyState, tidy, setPlace, selectedMinLength, setFrameLength, aiReady, aiReason, aiBusy, aiFrameId, runAi, cancelAi, tidyTarget, selectedIds, groups, selectedPartFrame, frame, frames, patchSelected, deleteSelected, duplicateSelected, selectedLocked, toggleLockSelected, selectionPlaceable, placeSelected, selectedRect, onShowOn, onShowMenu, selectedGroup, selectionWhole, groupSelected, ungroupSelected, setPromptCoverUp, setTitle, setBrief, setPromptEdit, setPromptOptions, setPlatform }: EditorRightPanelProps) {
  return (
    <aside style={{ ...panelStyle, width: rightW }}>
                    <div
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setResizing("right");
                      }}
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: -3,
                        width: 6,
                        cursor: "col-resize",
                        zIndex: 5,
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        /* the close button lands exactly where the button that reopens the panel sits */
                        padding: "20px 20px 8px 16px",
                        /* the band is the panel's own colour; the strip below it carries the fade */
                        background: p.surface,
                        /* while the prompt stands full screen the band has nothing to do: it fades out as the cover opens and back in as it closes */
                        opacity: promptCoverUp ? 0 : 1,
                        pointerEvents: promptCoverUp ? "none" : undefined,
                        transition: "opacity 220ms ease",
                      }}
                      inert={promptCoverUp ? "" : undefined}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Segmented<"edit" | "prompt">
                          options={[
                            {
                              key: "edit",
                              icon: "tune",
                              title: t("edit", lang),
                              grow: false,
                              wide: true,
                            },
                            {
                              key: "prompt",
                              icon: "auto_awesome",
                              label: t("prompt", lang),
                              title: t("prompt", lang),
                              grow: true,
                            },
                          ]}
                          value={rightTab}
                          onChange={setRightTab}
                          p={p}
                          height={34}
                        />
                      </div>
                      {/* the same button in the same spot as the one that reopens the panel, but plain:
                       * the filled look belongs to the one that has to be found over the canvas */}
                      <IconBtn
                        icon="right_panel_close"
                        p={p}
                        size={36}
                        onClick={() => setRightOpen(false)}
                        title={t("closePanel", lang)}
                      />
                    </div>
                    <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                      {/* what scrolls past the top of the panel dissolves into the band instead of being cut */}
                      <div
                        aria-hidden
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          height: PANEL_FADE_H,
                          zIndex: 3,
                          background: `linear-gradient(to bottom, ${p.surface}, ${p.surface}00)`,
                          pointerEvents: "none",
                        }}
                      />
                      {rightTab === "edit" && selectedFrame && !selected ? (
                        <FrameInspector
                          frame={selectedFrame}
                          palette={p}
                          onSize={(preset) => setFramePreset(selectedFrame.id, preset)}
                          onChange={(patch) => patchFrame(selectedFrame.id, patch)}
                          onDelete={() => deleteFrame(selectedFrame.id)}
                          onDuplicate={() => duplicateFrame(selectedFrame.id)}
                          onPreview={() => openPreview(selectedFrame.id)}
                          prompt={buildPrompt(doc, widths, selectedFrame.id, lang)}
                          onSaveImage={() => saveFrameImage(selectedFrame)}
                          tidy={tidyState ?? "done"}
                          onTidy={() => tidy(selectedFrame)}
                          onPlace={(pl) => setPlace(selectedFrame, pl)}
                          minLength={selectedMinLength}
                          onLength={(length) => setFrameLength(selectedFrame.id, length)}
                          ai={{
                            ready: aiReady,
                            reason: aiReason,
                            busy: aiBusy && aiFrameId === selectedFrame.id,
                            onRun: () => runAi("describe", selectedFrame),
                            onCancel: cancelAi,
                          }}
                        />
                      ) : rightTab === "edit" ? (
                        <Inspector
                          ai={{
                            ready: aiReady && !!tidyTarget,
                            reason: aiReason,
                            busy: aiBusy,
                            onRun: () => {
                              if (tidyTarget && selected) runAi("behavior", tidyTarget, selected.id);
                            },
                            onCancel: cancelAi,
                          }}
                          item={selectedIds.length > 1 ? null : selected}
                          railStandalone={groups.some(
                            (g) => g.items.length === 1 && g.items[0].id === selected?.id,
                          )}
                          frame={selectedPartFrame}
                          palette={p}
                          frames={frame === "phone" ? frames : []}
                          onChange={patchSelected}
                          onDelete={deleteSelected}
                          onDuplicate={duplicateSelected}
                          locked={selectedLocked}
                          onToggleLock={toggleLockSelected}
                          onPlace={selectionPlaceable ? placeSelected : undefined}
                          widths={widths}
                          selfRect={selectedRect}
                          allFrames={frames}
                          onShowOn={onShowOn}
                          onShowMenu={onShowMenu}
                          multi={selectedIds.length}
                          grouped={!!selectedGroup}
                          selectionWhole={selectionWhole}
                          selectionKey={selectedIds.join(" ")}
                          onGroup={groupSelected}
                          onUngroup={ungroupSelected}
                        />
                      ) : (
                        <PromptPanel
                          doc={doc}
                          widths={widths}
                          palette={p}
                          onCover={setPromptCoverUp}
                          onDoc={(patch) => {
                            if (patch.title !== undefined) setTitle(patch.title);
                            if (patch.brief !== undefined) setBrief(patch.brief);
                            if ("promptEdit" in patch) setPromptEdit(patch.promptEdit);
                            if ("promptOptions" in patch) setPromptOptions(patch.promptOptions);
                            if ("platform" in patch)
                              setPlatform(isPlatform(patch.platform) ? patch.platform : null);
                          }}
                        />
                      )}
                    </div>
                  </aside>
  );
}
