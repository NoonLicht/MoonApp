import { Icon } from "@/pages/myspace/m3e/components/M3Node";
import { IconBtn } from "@/pages/myspace/m3e/components/ui";
import { isRuUi, t } from "@/pages/myspace/m3e/lib/i18n";
import { Logo } from "@/pages/myspace/m3e/components/Logo";
import { PartsPalette } from "@/pages/myspace/m3e/components/PartsPalette";
import { makeCustomItem } from "@/pages/myspace/m3e/lib/library";
import { ColorPanel } from "@/pages/myspace/m3e/components/ColorPanel";
import { MotionPanel, ShapePanel, TypePanel } from "@/pages/myspace/m3e/components/ThemePanel";
import { AiPanel } from "@/pages/myspace/m3e/components/AiPanel";
import { LayersPanel } from "@/pages/myspace/m3e/components/Layers";
import type React from "react";
import type { Palette, Kind, Item, Theme, Frame, Group } from "@/pages/myspace/m3e/lib/tokens";
import type { Lang } from "@/pages/myspace/m3e/lib/i18n";
import type { ChromeMode } from "@/pages/myspace/m3e/lib/chrome";
import type { CustomSpec } from "@/pages/myspace/m3e/lib/custom";
import type { AiSettings } from "@/pages/myspace/m3e/lib/ai";

/** the icon rail on the left edge of the parts / layers panel */
export const RAIL_W = 46;
export type LeftTab = "parts" | "layers" | "color" | "shape" | "type" | "motion" | "ai";
/** the left rail: parts and layers, then the four theme axes of the whole design */
export const LEFT_TABS: {
  key: LeftTab;
  icon: string;
  title: "parts" | "layers" | "colors" | "shape" | "typography" | "motion" | "ai";
}[] = [
  { key: "parts", icon: "add_box", title: "parts" },
  { key: "layers", icon: "layers", title: "layers" },
  { key: "color", icon: "palette", title: "colors" },
  { key: "shape", icon: "rounded_corner", title: "shape" },
  { key: "type", icon: "text_fields", title: "typography" },
  { key: "motion", icon: "animation", title: "motion" },
  { key: "ai", icon: "auto_awesome", title: "ai" },
];

export interface EditorLeftPanelProps {
  panelStyle: React.CSSProperties;
  leftOpen: boolean;
  leftW: number;
  overBin: boolean;
  p: Palette;
  setRailHover: React.Dispatch<React.SetStateAction<boolean>>;
  setLeftOpen: React.Dispatch<React.SetStateAction<boolean>>;
  railHover: boolean;
  lang: Lang;
  leftTab: LeftTab;
  setLeftTab: React.Dispatch<React.SetStateAction<LeftTab>>;
  chrome: { palette: Palette; mode: ChromeMode; toggle: () => void; };
  favorites: Kind[];
  setFavorites: React.Dispatch<React.SetStateAction<Kind[]>>;
  onPartPointerDown: (e: React.PointerEvent, kind: Kind, made?: Item) => void;
  addPart: (kind: Kind, made?: Item) => void;
  aiSettings: AiSettings;
  library: { list: CustomSpec[]; save: (spec: CustomSpec) => void; remove: (i: number) => void; };
  paletteKey: string;
  setPaletteKey: React.Dispatch<React.SetStateAction<string>>;
  customPalette: Palette | null;
  setCustomPalette: React.Dispatch<React.SetStateAction<Palette | null>>;
  dynamicColor: boolean;
  setDynamicColor: React.Dispatch<React.SetStateAction<boolean>>;
  theme: Theme;
  patchTheme: (patch: Partial<Theme>) => void;
  updateAiSettings: (s: AiSettings) => void;
  frames: Frame[];
  layersFrame: Frame | null;
  setLayersFrameId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedFrameId: React.Dispatch<React.SetStateAction<string | null>>;
  framesRef: React.MutableRefObject<Frame[]>;
  glideToFrame: (f: Frame) => void;
  layerGroups: Group[];
  widths: Record<string, number>;
  selectedIds: string[];
  setSelectedLinkId: React.Dispatch<React.SetStateAction<string | null>>;
  setRightTab: React.Dispatch<React.SetStateAction<"edit" | "prompt">>;
  reorderLayers: (topFirst: string[]) => void;
  toggleGroupLock: (id: string) => void;
  reorderGroupItems: (groupId: string, order: string[]) => void;
  onLayerDragging: (dragging: boolean) => void;
  setResizing: React.Dispatch<React.SetStateAction<"left" | "right" | null>>;
}

export default function EditorLeftPanel({ panelStyle, leftOpen, leftW, overBin, p, setRailHover, setLeftOpen, railHover, lang, leftTab, setLeftTab, chrome, favorites, setFavorites, onPartPointerDown, addPart, aiSettings, library, paletteKey, setPaletteKey, customPalette, setCustomPalette, dynamicColor, setDynamicColor, theme, patchTheme, updateAiSettings, frames, layersFrame, setLayersFrameId, setSelectedIds, setSelectedFrameId, framesRef, glideToFrame, layerGroups, widths, selectedIds, setSelectedLinkId, setRightTab, reorderLayers, toggleGroupLock, reorderGroupItems, onLayerDragging, setResizing }: EditorLeftPanelProps) {
  return (
    <aside
                    style={{
                      ...panelStyle,
                      width: leftOpen ? leftW : RAIL_W,
                      flexDirection: "row",
                      transition: "width 200ms cubic-bezier(0.2, 0, 0, 1)",
                    }}
                  >
                    {/* dropping a canvas part anywhere on this side deletes it, whichever tab is open */}
                    {overBin && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          zIndex: 5,
                          background: "rgba(179,38,30,0.10)",
                          display: "grid",
                          placeItems: "center",
                          pointerEvents: "none",
                          color: p.error,
                        }}
                      >
                        <div
                          style={{
                            width: 72,
                            height: 72,
                            borderRadius: 36,
                            background: p.errorContainer,
                            color: p.onErrorContainer,
                            display: "grid",
                            placeItems: "center",
                            boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
                          }}
                        >
                          <Icon name="delete" size={34} />
                        </div>
                      </div>
                    )}
                    <div
                      onPointerEnter={() => setRailHover(true)}
                      onPointerLeave={() => setRailHover(false)}
                      onClick={(e) => {
                        // a click on the rail's empty background opens the panel
                        if (!leftOpen && e.target === e.currentTarget) setLeftOpen(true);
                      }}
                      style={{
                        width: RAIL_W,
                        flex: "0 0 auto",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 6,
                        padding: "10px 0",
                        background: p.surfaceContainerLow,
                        cursor: leftOpen ? undefined : "pointer",
                      }}
                    >
                      {!leftOpen && railHover ? (
                        <IconBtn
                          icon="left_panel_open"
                          p={p}
                          on
                          onClick={() => setLeftOpen(true)}
                          title={t("openPanel", lang)}
                          size={34}
                        />
                      ) : (
                        <div
                          onClick={() => !leftOpen && setLeftOpen(true)}
                          style={{
                            width: 40,
                            height: 40,
                            display: "grid",
                            placeItems: "center",
                            cursor: leftOpen ? "default" : "pointer",
                          }}
                        >
                          <Logo size={28} color={p.primary} glyph={p.onPrimary} />
                        </div>
                      )}
                      <div style={{ height: 6 }} />
                      {LEFT_TABS.map((tab, i) => (
                        <div key={tab.key} style={{ marginTop: i === 2 || i === 6 ? 10 : 0 }}>
                          <IconBtn
                            icon={tab.icon}
                            p={p}
                            on={leftOpen && leftTab === tab.key}
                            onClick={() => {
                              setLeftTab(tab.key);
                              setLeftOpen(true);
                            }}
                            title={t(tab.title, lang)}
                            size={36}
                          />
                        </div>
                      ))}
                      <div style={{ flex: 1 }} onClick={() => !leftOpen && setLeftOpen(true)} />
                      <IconBtn
                        icon={chrome.mode === "dark" ? "light_mode" : "dark_mode"}
                        p={p}
                        onClick={chrome.toggle}
                        title={
                          chrome.mode === "dark"
                            ? isRuUi()
                              ? "Светлый интерфейс"
                              : "Light interface"
                            : isRuUi()
                              ? "Тёмный интерфейс"
                              : "Dark interface"
                        }
                        size={36}
                      />
                    </div>
                    {leftOpen && (
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "10px 10px 0 14px",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: 14,
                              color: p.onSurface,
                              flex: 1,
                            }}
                          >
                            {t(LEFT_TABS.find((x) => x.key === leftTab)?.title ?? "parts", lang)}
                          </span>
                          <IconBtn
                            icon="left_panel_close"
                            p={p}
                            onClick={() => setLeftOpen(false)}
                            title={t("closePanel", lang)}
                          />
                        </div>
                        <div style={{ flex: 1, minHeight: 0 }}>
                          {leftTab === "parts" ? (
                            <PartsPalette
                              palette={p}
                              favorites={favorites}
                              onToggleFavorite={(k) =>
                                setFavorites((f) =>
                                  f.includes(k) ? f.filter((x) => x !== k) : [...f, k],
                                )
                              }
                              onPartPointerDown={onPartPointerDown}
                              onPartActivate={addPart}
                              ai={aiSettings}
                              mine={library.list}
                              onSaveCustom={library.save}
                              onRemoveCustom={library.remove}
                              onCustomAdd={(spec) => addPart("custom", makeCustomItem(spec))}
                              onCustomDown={(e, spec) =>
                                onPartPointerDown(e, "custom", makeCustomItem(spec))
                              }
                            />
                          ) : leftTab === "color" ? (
                            <ColorPanel
                              p={p}
                              paletteKey={paletteKey}
                              onPalette={setPaletteKey}
                              custom={customPalette}
                              onCustom={setCustomPalette}
                              dynamic={dynamicColor}
                              onDynamic={setDynamicColor}
                              theme={theme}
                              onTheme={patchTheme}
                            />
                          ) : leftTab === "shape" ? (
                            <ShapePanel p={p} theme={theme} onChange={patchTheme} />
                          ) : leftTab === "type" ? (
                            <TypePanel p={p} theme={theme} onChange={patchTheme} />
                          ) : leftTab === "motion" ? (
                            <MotionPanel p={p} theme={theme} onChange={patchTheme} />
                          ) : leftTab === "ai" ? (
                            <AiPanel p={p} settings={aiSettings} onSettings={updateAiSettings} />
                          ) : (
                            <LayersPanel
                              p={p}
                              frames={frames}
                              frameId={layersFrame?.id ?? null}
                              onFrame={(id) => {
                                setLayersFrameId(id);
                                setSelectedIds([]);
                                setSelectedFrameId(id);
                                const f = framesRef.current.find((x) => x.id === id);
                                if (f) glideToFrame(f);
                              }}
                              groups={layerGroups}
                              widths={widths}
                              selectedIds={selectedIds}
                              onSelect={(ids, add) => {
                                setSelectedIds((cur) =>
                                  add ? [...cur.filter((x) => !ids.includes(x)), ...ids] : ids,
                                );
                                setSelectedFrameId(null);
                                setSelectedLinkId(null);
                                setRightTab("edit");
                              }}
                              onReorder={reorderLayers}
                              onToggleLock={toggleGroupLock}
                              onReorderItems={reorderGroupItems}
                              onDragging={onLayerDragging}
                            />
                          )}
                        </div>
                      </div>
                    )}
                    {leftOpen && (
                      <div
                        onPointerDown={(e) => {
                          e.preventDefault();
                          setResizing("left");
                        }}
                        style={{
                          position: "absolute",
                          top: 0,
                          bottom: 0,
                          right: -3,
                          width: 6,
                          cursor: "col-resize",
                          zIndex: 5,
                        }}
                      />
                    )}
                  </aside>
  );
}
