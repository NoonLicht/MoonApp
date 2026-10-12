import { AnimatePresence } from "motion/react";
import { effectivePrompt } from "@/pages/myspace/m3e/lib/prompt";
import {
  TAPPABLE,
  isMeasured,
  BEZEL,
  frameRadius,
  frameRect,
  frameSizeOf,
  frameLengthOf,
  groupBounds,
  fontFamilyOf,
  uiFontFamily,
  SETTLE_CSS_VARS,
  SETTLE_MS,
  Transition,
  TRANSITIONS,
} from "@/pages/myspace/m3e/lib/tokens";
import { Icon, MeasuredContent } from "@/pages/myspace/m3e/components/M3Node";
import { SizeHandles } from "@/pages/myspace/m3e/components/SizeHandles";
import { Preview } from "@/pages/myspace/m3e/components/Preview";
import { Toolbar } from "@/pages/myspace/m3e/components/Toolbar";
import { readProject, saveProject } from "@/pages/myspace/m3e/lib/project";
import { ShareDialog } from "@/pages/myspace/m3e/components/ShareMenu";
import { DocPaletteContext, ThemeContext } from "@/pages/myspace/m3e/lib/theme";
import {
  BottomSheet,
  MobileActionBar,
  MobileInspector,
  MobileLang,
  MobileSettings,
} from "@/pages/myspace/m3e/components/Mobile";
import { ConfirmDialog, IconBtn, Segmented } from "@/pages/myspace/m3e/components/ui";
import { LangContext, t } from "@/pages/myspace/m3e/lib/i18n";
import EditorRightPanel from "@/pages/myspace/m3e/components/EditorRightPanel";
import EditorLeftPanel from "@/pages/myspace/m3e/components/EditorLeftPanel";
import EditAccessDialog from "@/pages/myspace/m3e/components/EditAccessDialog";
import FrameCard from "@/pages/myspace/m3e/components/FrameCard";
import DragGhost from "@/pages/myspace/m3e/components/DragGhost";
import {
  HANDLED,
  ROUND,
  WIDE,
  BAR_SIDES,
  TALL,
  TALL_SIDES,
} from "@/pages/myspace/m3e/lib/editorModel";
import type { useM3eEditorResult } from "@/pages/myspace/m3e/useM3eEditor";

/** Разметка страницы; всё состояние приходит из useM3eEditor. */
export default function M3eEditorView({ c }: { c: useM3eEditorResult }) {
  const {
    lang,
    editAccess,
    groups,
    frames,
    paletteKey,
    setPaletteKey,
    customPalette,
    setCustomPalette,
    dynamicColor,
    setDynamicColor,
    theme,
    patchTheme,
    frame,
    changeLanguage,
    isMobile,
    sheet,
    setSheet,
    confirmClear,
    setConfirmClear,
    exportFrame,
    toast,
    setTitle,
    setBrief,
    setPromptEdit,
    setPromptOptions,
    promptCoverUp,
    setPromptCoverUp,
    setPlatform,
    pendingImport,
    setPendingImport,
    shareOpen,
    setShareOpen,
    ideaText,
    setIdeaText,
    draftBusy,
    draftBefore,
    revealing,
    view,
    viewReady,
    easing,
    cameraEasing,
    mode,
    setMode,
    leftOpen,
    setLeftOpen,
    rightOpen,
    setRightOpen,
    leftW,
    leftTab,
    setLeftTab,
    railHover,
    setRailHover,
    setLayersFrameId,
    rightW,
    rightTab,
    setRightTab,
    favorites,
    setFavorites,
    selectedIds,
    setSelectedIds,
    selectedFrameId,
    setSelectedFrameId,
    selectedLinkId,
    setSelectedLinkId,
    linkDrag,
    previewId,
    drag,
    widths,
    resizing,
    setResizing,
    aiSettings,
    library,
    aiBusy,
    aiFrameId,
    aiNote,
    projectFileRef,
    dp,
    chrome,
    p,
    canvasRef,
    measureEls,
    groupsRef,
    framesRef,
    pastRef,
    futureRef,
    undo,
    redo,
    allItems,
    canvasRect,
    setZoomAt,
    fit,
    onTouchCapture,
    sx,
    sy,
    dragLit,
    onPartPointerDown,
    widthDragId,
    sizeEditId,
    widthShift,
    nudgeSize,
    onWidthHandleDown,
    itemRects,
    onCanvasPointerDown,
    onFramePointerDown,
    selected,
    patchSelected,
    deleteSelected,
    selectedLocked,
    selectionPlaceable,
    selectionWhole,
    toggleLockSelected,
    duplicateSelected,
    selectedGroup,
    placeSelected,
    groupSelected,
    ungroupSelected,
    clearAll,
    importDoc,
    startDraft,
    quickUndo,
    keepDraft,
    undoDraft,
    selectedFrame,
    selectedMinLength,
    menuId,
    onShowOn,
    onShowMenu,
    onLook,
    selectedRect,
    selectedPartFrame,
    tidyTarget,
    addPart,
    changeFrame,
    addFrame,
    patchFrame,
    setFramePreset,
    setFrameLength,
    lengthDragId,
    onLengthHandleDown,
    onLengthHandleKey,
    tidyState,
    tidy,
    setPlace,
    showToast,
    updateAiSettings,
    aiReady,
    aiReason,
    runAi,
    cancelAi,
    deleteFrame,
    duplicateFrame,
    saveFrameImage,
    renderExport,
    glideToFrame,
    openPreview,
    closePreview,
    doc,
    links,
    startLinkDrag,
    setLinkTransition,
    removeLink,
    runRadii,
    frameOf,
    layersFrame,
    layerGroups,
    onLayerDragging,
    reorderLayers,
    toggleGroupLock,
    reorderGroupItems,
    renderGroup,
    handMode,
    panning,
    marquee,
    canvasBg,
    panelStyle,
    showRight,
    overBin,
    guide,
    visibleWorld,
  } = c;
  return (
    <LangContext.Provider value={lang}>
      <ThemeContext.Provider value={theme}>
        <DocPaletteContext.Provider value={dp}>
          <div
            className={`m3e-app-root${revealing ? " m3e-reveal" : ""}${widthDragId || sizeEditId ? " m3-size-now" : ""}`}
            /* the preview sits outside this tree and owns the keyboard while it is up */
            inert={editAccess !== "editable" || previewId !== null ? "" : undefined}
            aria-hidden={editAccess !== "editable" || previewId !== null}
            style={{
              /* the settle time and curve the stylesheet eases with, from the one place they are set */
              ...(SETTLE_CSS_VARS as React.CSSProperties),
              width: "100%",
              height: "100%",
              fontFamily: uiFontFamily(lang),
              color: p.onSurface,
              display: "flex",
              overflow: "hidden",
              background: p.surfaceContainer,
              cursor: resizing ? "col-resize" : undefined,
              userSelect: resizing ? "none" : undefined,
              ["--sb" as string]: p.outlineVariant,
            }}
          >
            {/* hidden measuring layer for text-sized kinds */}
            <div
              aria-hidden
              className="m3-measure"
              style={{
                position: "fixed",
                left: -99999,
                top: 0,
                visibility: "hidden",
                pointerEvents: "none",
                fontFamily: fontFamilyOf(theme.font, lang),
              }}
            >
              {allItems
                .map(onLook)
                .filter((it) => isMeasured(it))
                .map((it) => (
                  <div
                    key={it.id}
                    ref={(el) => {
                      if (el) measureEls.current.set(it.id, el);
                      else measureEls.current.delete(it.id);
                    }}
                    style={{
                      display: "inline-flex",
                      boxSizing: "border-box",
                      border:
                        it.variant === "outlined" &&
                        (it.kind === "button" || it.kind === "chip" || it.kind === "extendedFab")
                          ? "1px solid transparent"
                          : "none",
                    }}
                  >
                    <MeasuredContent item={it} p={dp} />
                  </div>
                ))}
            </div>

            {exportFrame && (
              <div
                aria-hidden
                style={{
                  position: "fixed",
                  left: -99999,
                  top: 0,
                  pointerEvents: "none",
                  fontFamily: fontFamilyOf(theme.font, lang),
                }}
              >
                {renderExport(exportFrame)}
              </div>
            )}

            {/* the part in flight rides above every panel so it stays visible while crossing them */}
            {drag?.active &&
              (() => {
                const r = canvasRect();
                return (
                  <DragGhost
                    r={r}
                    view={view}
                    theme={theme}
                    lang={lang}
                    drag={drag}
                    sx={sx}
                    sy={sy}
                    dp={dp}
                    widths={widths}
                    dragLit={dragLit}
                    groupsRef={groupsRef}
                    runRadii={runRadii}
                  />
                );
              })()}

            {/* ---- left: rail + parts / layers ---- */}
            {!isMobile && (
              <EditorLeftPanel
                panelStyle={panelStyle}
                leftOpen={leftOpen}
                leftW={leftW}
                overBin={overBin}
                p={p}
                setRailHover={setRailHover}
                setLeftOpen={setLeftOpen}
                railHover={railHover}
                lang={lang}
                leftTab={leftTab}
                setLeftTab={setLeftTab}
                chrome={chrome}
                favorites={favorites}
                setFavorites={setFavorites}
                onPartPointerDown={onPartPointerDown}
                addPart={addPart}
                aiSettings={aiSettings}
                library={library}
                paletteKey={paletteKey}
                setPaletteKey={setPaletteKey}
                customPalette={customPalette}
                setCustomPalette={setCustomPalette}
                dynamicColor={dynamicColor}
                setDynamicColor={setDynamicColor}
                theme={theme}
                patchTheme={patchTheme}
                updateAiSettings={updateAiSettings}
                frames={frames}
                layersFrame={layersFrame}
                setLayersFrameId={setLayersFrameId}
                setSelectedIds={setSelectedIds}
                setSelectedFrameId={setSelectedFrameId}
                framesRef={framesRef}
                glideToFrame={glideToFrame}
                layerGroups={layerGroups}
                widths={widths}
                selectedIds={selectedIds}
                setSelectedLinkId={setSelectedLinkId}
                setRightTab={setRightTab}
                reorderLayers={reorderLayers}
                toggleGroupLock={toggleGroupLock}
                reorderGroupItems={reorderGroupItems}
                onLayerDragging={onLayerDragging}
                setResizing={setResizing}
              />
            )}

            {/* ---- canvas ---- */}
            <main
              style={{
                flex: 1,
                position: "relative",
                minWidth: 0,
                padding: isMobile ? 6 : 8,
              }}
            >
              <div
                ref={canvasRef}
                onPointerDown={onCanvasPointerDown}
                onPointerDownCapture={onTouchCapture}
                style={{
                  position: "absolute",
                  inset: isMobile ? 6 : 8,
                  overflow: "hidden",
                  borderRadius: 24,
                  background: canvasBg,
                  cursor: panning ? "grabbing" : handMode ? "grab" : "default",
                  touchAction: "none",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                    transformOrigin: "0 0",
                    transition: cameraEasing
                      ? `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
                      : undefined,
                    willChange: "transform",
                    visibility: viewReady ? "visible" : "hidden",
                    fontFamily: fontFamilyOf(theme.font, lang),
                  }}
                >
                  {frame === "phone" &&
                    frames.map((f) => {
                      const on = f.id === selectedFrameId;
                      const bg = dp[f.bg ?? "surface"];
                      const { w, h: fold } = frameSizeOf(f);
                      const h = frameLengthOf(f);
                      const radius = frameRadius(f);
                      return (
                        <FrameCard
                          key={f.id}
                          f={f}
                          easing={easing}
                          onFramePointerDown={onFramePointerDown}
                          view={view}
                          on={on}
                          p={p}
                          handMode={handMode}
                          lang={lang}
                          setFramePreset={setFramePreset}
                          w={w}
                          h={h}
                          radius={radius}
                          dp={dp}
                          draftBusy={draftBusy}
                          lengthDragId={lengthDragId}
                          aiFrameId={aiFrameId}
                          bg={bg}
                          groups={groups}
                          frameOf={frameOf}
                          renderGroup={renderGroup}
                          fold={fold}
                          canvasBg={canvasBg}
                          selectedMinLength={selectedMinLength}
                          onLengthHandleDown={onLengthHandleDown}
                          onLengthHandleKey={onLengthHandleKey}
                        />
                      );
                    })}

                  {groups.filter((g) => !frameOf.has(g.id)).map((g) => renderGroup(g, 0, 0))}

                  {/* a lone button shows a handle on each of its four edges, and a lone icon button
                  four points around its circle: dragging one changes the part's size in place,
                  and whatever sits opposite stays where it is */}
                  {/* a FAB showing its menu is being edited as a menu, not sized as a button */}
                  {!handMode &&
                    !drag &&
                    selectedIds.length === 1 &&
                    selected &&
                    selected.id !== menuId &&
                    HANDLED.has(selected.kind) &&
                    (() => {
                      const g = groups.find(
                        (x) =>
                          x.items.length === 1 &&
                          !x.free &&
                          !x.locked &&
                          x.items[0].id === selected.id,
                      );
                      if (!g) return null;
                      const b = groupBounds(g, widths);
                      /* the same offset the group is drawn with while its left or top edge is being dragged */
                      const sx = widthShift?.gid === g.id ? widthShift.dx : 0;
                      const sy = widthShift?.gid === g.id ? widthShift.dy : 0;
                      return (
                        <SizeHandles
                          /* the handles belong to this one part: another part picked gets its own, in
                           * place, rather than these flying across the canvas to it */
                          key={selected.id}
                          /* one measure, so the part is held by the points around it rather than by
                           * its edges: a circle's diameter, a label's height */
                          round={ROUND.has(selected.kind)}
                          /* a bar and a slider have a width and nothing else: they are held by their two
                           * ends; a carousel is the other way about and is held by its top and bottom */
                          sides={
                            WIDE.has(selected.kind)
                              ? BAR_SIDES
                              : TALL.has(selected.kind)
                                ? TALL_SIDES
                                : undefined
                          }
                          /* a part with a height of its own is held by all four edges; one whose height follows its kind by its two ends */
                          box={{ l: b.l + sx, t: b.t + sy, r: b.r + sx, b: b.b + sy }}
                          z={view.z}
                          instant={widthDragId === selected.id || sizeEditId === selected.id}
                          p={p}
                          onDown={(e, side) => onWidthHandleDown(e, g, selected, side)}
                          onNudge={(side, dir) => nudgeSize(g, selected, side, dir)}
                        />
                      );
                    })()}

                  {/* a tappable part shows a dot on its right edge: pull it onto a screen to say where the part leads */}
                  {frame === "phone" &&
                    !handMode &&
                    !drag &&
                    selectedIds.length === 1 &&
                    selected &&
                    TAPPABLE.includes(selected.kind) &&
                    (() => {
                      const r = itemRects().find((x) => x.id === selected.id);
                      if (!r) return null;
                      const sx = r.r;
                      const sy = (r.t + r.b) / 2;
                      return (
                        <>
                          {linkDrag && (
                            <>
                              {linkDrag.over &&
                                (() => {
                                  const f = frames.find((x) => x.id === linkDrag.over);
                                  if (!f) return null;
                                  const fr = frameRect(f);
                                  return (
                                    <div
                                      aria-hidden
                                      style={{
                                        position: "absolute",
                                        left: fr.l - BEZEL,
                                        top: fr.t - BEZEL,
                                        width: fr.r - fr.l + BEZEL * 2,
                                        height: fr.b - fr.t + BEZEL * 2,
                                        borderRadius: 40,
                                        outline: `${3 / view.z}px solid ${p.primary}`,
                                        background: `${p.primary}1f`,
                                        pointerEvents: "none",
                                        zIndex: 55,
                                      }}
                                    />
                                  );
                                })()}
                              <svg
                                aria-hidden
                                style={{
                                  position: "absolute",
                                  left: 0,
                                  top: 0,
                                  overflow: "visible",
                                  pointerEvents: "none",
                                  zIndex: 56,
                                }}
                                width={1}
                                height={1}
                              >
                                <path
                                  d={`M${linkDrag.sx} ${linkDrag.sy} C${linkDrag.sx + 80} ${linkDrag.sy} ${linkDrag.x - 80} ${linkDrag.y} ${linkDrag.x} ${linkDrag.y}`}
                                  fill="none"
                                  stroke={p.primary}
                                  strokeWidth={2.5 / view.z}
                                  strokeLinecap="round"
                                  strokeDasharray={`${6 / view.z} ${6 / view.z}`}
                                />
                                <circle
                                  cx={linkDrag.x}
                                  cy={linkDrag.y}
                                  r={5 / view.z}
                                  fill={p.primary}
                                />
                              </svg>
                            </>
                          )}
                          <div
                            role="button"
                            aria-label={t("linkHandle", lang)}
                            title={t("linkHandle", lang)}
                            onPointerDown={(e) => startLinkDrag(e, selected.id, sx, sy)}
                            style={{
                              position: "absolute",
                              left: sx,
                              top: sy,
                              width: 18,
                              height: 18,
                              borderRadius: 9,
                              transform: `translate(${10 / view.z}px, -50%) scale(${1 / view.z})`,
                              transformOrigin: "0 50%",
                              background: p.primary,
                              border: `2px solid ${p.surface}`,
                              boxShadow: "0 1px 6px rgba(0,0,0,0.4)",
                              cursor: "crosshair",
                              zIndex: 57,
                            }}
                          />
                        </>
                      );
                    })()}

                  {links.length > 0 && (
                    <svg
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        overflow: "visible",
                        pointerEvents: "none",
                      }}
                      width={1}
                      height={1}
                    >
                      <defs>
                        <marker
                          id="m3e-arrow"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="8"
                          markerHeight="8"
                          orient="auto"
                        >
                          <path d="M0 0 L10 5 L0 10 z" fill={p.primary} />
                        </marker>
                      </defs>
                      {!draftBusy &&
                        links.map((l) => {
                          const on = l.id === selectedLinkId;
                          return (
                            <g key={l.id}>
                              <path
                                d={l.d}
                                fill="none"
                                stroke="transparent"
                                strokeWidth={18 / view.z}
                                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  setSelectedLinkId(l.id);
                                  setSelectedIds([]);
                                  setSelectedFrameId(null);
                                }}
                              />
                              <path
                                d={l.d}
                                fill="none"
                                stroke={p.primary}
                                strokeWidth={on ? 3 : 2}
                                strokeDasharray={on ? undefined : "6 6"}
                                strokeLinecap="round"
                                markerEnd="url(#m3e-arrow)"
                                opacity={on ? 1 : 0.7}
                              />
                            </g>
                          );
                        })}
                    </svg>
                  )}

                  {links
                    .filter((l) => l.id === selectedLinkId)
                    .map((l) => (
                      <div
                        key={l.id}
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{
                          position: "absolute",
                          left: l.mx,
                          top: l.my,
                          transform: `translate(-50%, 14px) scale(${1 / view.z})`,
                          transformOrigin: "50% 0",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          padding: 6,
                          borderRadius: 26,
                          background: p.surfaceContainerLow,
                          boxShadow: "0 4px 16px rgba(0,0,0,0.16)",
                          zIndex: 60,
                        }}
                      >
                        <Segmented<Transition>
                          options={TRANSITIONS.map((t) => ({
                            key: t.key,
                            icon: t.icon,
                            title: t.label,
                          }))}
                          value={l.t}
                          onChange={(t) => setLinkTransition(l.id, t)}
                          p={p}
                          height={36}
                          grow={false}
                        />
                        <IconBtn
                          icon="link_off"
                          p={p}
                          danger
                          onClick={() => removeLink(l.id)}
                          title={t("removeLink", lang)}
                          size={36}
                        />
                      </div>
                    ))}

                  {guide?.gx !== undefined && (
                    <div
                      style={{
                        position: "absolute",
                        left: guide.gx,
                        top: visibleWorld.t,
                        width: 1.5 / view.z,
                        height: visibleWorld.h,
                        background: p.primary,
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  {guide?.gy !== undefined && (
                    <div
                      style={{
                        position: "absolute",
                        top: guide.gy,
                        left: visibleWorld.l,
                        height: 1.5 / view.z,
                        width: visibleWorld.w,
                        background: p.primary,
                        pointerEvents: "none",
                      }}
                    />
                  )}

                  {marquee && (
                    <div
                      style={{
                        position: "absolute",
                        left: Math.min(marquee.x0, marquee.x1),
                        top: Math.min(marquee.y0, marquee.y1),
                        width: Math.abs(marquee.x1 - marquee.x0),
                        height: Math.abs(marquee.y1 - marquee.y0),
                        border: `${1 / view.z}px solid ${p.primary}`,
                        background: `${p.primary}14`,
                        borderRadius: 4 / view.z,
                        pointerEvents: "none",
                      }}
                    />
                  )}
                </div>
              </div>

              {draftBusy && (
                <div
                  style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
                  aria-hidden
                >
                  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
                    <defs>
                      <linearGradient id="m3e-drafting" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor={p.primary} />
                        <stop offset="50%" stopColor={p.tertiaryContainer} />
                        <stop offset="100%" stopColor={p.primaryContainer} />
                        <animateTransform
                          attributeName="gradientTransform"
                          type="rotate"
                          from="0 0.5 0.5"
                          to="360 0.5 0.5"
                          dur="3s"
                          repeatCount="indefinite"
                        />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              )}
              <Toolbar
                p={p}
                mode={mode}
                onMode={setMode}
                frame={frame}
                onFrame={changeFrame}
                zoom={view.z}
                onZoom={(z) => setZoomAt(z)}
                onFit={fit}
                canUndo={pastRef.current.length > 0}
                canRedo={futureRef.current.length > 0}
                onUndo={undo}
                onRedo={redo}
                onClear={() => {
                  if (groupsRef.current.length || framesRef.current.length) setConfirmClear(true);
                }}
                onAddFrame={addFrame}
                onPreview={() => openPreview()}
                tidy={selectedIds.length > 1 ? undefined : (tidyState ?? undefined)}
                onTidy={tidyTarget ? () => tidy(tidyTarget) : undefined}
                place={tidyTarget?.place}
                onPlace={tidyTarget ? (pl) => setPlace(tidyTarget, pl) : undefined}
                note={aiNote}
                onSaveProject={() => saveProject(doc)}
                onOpenProject={() => projectFileRef.current?.click()}
                onShare={!isMobile ? () => setShareOpen(true) : undefined}
                shareState={draftBusy ? "busy" : draftBefore ? "review" : "idle"}
                onDraftKeep={keepDraft}
                onDraftUndo={undoDraft}
                onDraftSave={() => saveProject(doc)}
                quickUndo={quickUndo}
                rightInset={showRight ? rightW : 0}
                mobile={isMobile}
                onSettings={() => setSheet(sheet === "settings" ? null : "settings")}
                onLangSheet={() => setSheet(sheet === "lang" ? null : "lang")}
                onPrompt={async () => {
                  try {
                    await navigator.clipboard.writeText(effectivePrompt(doc, widths, lang));
                    showToast(t("copied", lang), 1400, "check");
                  } catch {
                    /* буфер обмена недоступен — не копируем, это не ошибка */
                  }
                }}
              />

              {isMobile && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: 80,
                    textAlign: "center",
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: p.onSurfaceVariant,
                    pointerEvents: "none",
                    zIndex: 40,
                  }}
                >
                  {t("mobileNote", lang)}
                </div>
              )}

              {isMobile && sheet === null && (
                <button
                  onClick={() => addPart("button")}
                  title={t("addButton", lang)}
                  aria-label={t("addButton", lang)}
                  className="m3-press"
                  style={{
                    position: "absolute",
                    right: 16,
                    bottom: "calc(16px + var(--bottom-ui, 0px) + env(safe-area-inset-bottom))",
                    width: 64,
                    height: 64,
                    borderRadius: 20,
                    border: "none",
                    background: p.primary,
                    color: p.onPrimary,
                    cursor: "pointer",
                    display: "grid",
                    placeItems: "center",
                    zIndex: 46,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
                  }}
                >
                  <Icon name="add" size={28} />
                </button>
              )}

              {isMobile && selected && sheet === null && (
                <MobileActionBar
                  p={p}
                  onEdit={() => setSheet("edit")}
                  onDuplicate={duplicateSelected}
                  onDelete={deleteSelected}
                />
              )}

              <AnimatePresence>
                {isMobile && sheet === "edit" && selected && (
                  <BottomSheet key="edit" p={p} onClose={() => setSheet(null)}>
                    <MobileInspector
                      item={selected}
                      palette={p}
                      onChange={patchSelected}
                      onDelete={() => {
                        deleteSelected();
                        setSheet(null);
                      }}
                      onDuplicate={duplicateSelected}
                      onClose={() => setSheet(null)}
                    />
                  </BottomSheet>
                )}
                {isMobile && sheet === "settings" && (
                  <BottomSheet key="settings" p={p} onClose={() => setSheet(null)}>
                    <MobileSettings
                      palette={p}
                      paletteKey={paletteKey}
                      onPalette={setPaletteKey}
                      theme={theme}
                      onTheme={patchTheme}
                    />
                  </BottomSheet>
                )}
                {isMobile && sheet === "lang" && (
                  <BottomSheet key="lang" p={p} onClose={() => setSheet(null)}>
                    <MobileLang
                      palette={p}
                      lang={lang}
                      onLang={(l) => {
                        changeLanguage(l);
                        setSheet(null);
                      }}
                    />
                  </BottomSheet>
                )}
              </AnimatePresence>

              {toast && (
                <div
                  style={{
                    position: "absolute",
                    left: "50%",
                    bottom: 96,
                    transform: "translateX(-50%)",
                    padding: "10px 18px",
                    borderRadius: 20,
                    background: p.inverseSurface,
                    color: p.inverseOnSurface,
                    fontSize: 13,
                    fontWeight: 600,
                    zIndex: 47,
                    pointerEvents: "none",
                  }}
                >
                  {toast}
                </div>
              )}

              {!rightOpen && !isMobile && (
                <div style={{ position: "absolute", right: 20, top: 20, zIndex: 45 }}>
                  <IconBtn
                    icon="right_panel_open"
                    p={p}
                    on
                    onClick={() => setRightOpen(true)}
                    title={t("edit", lang)}
                    size={36}
                  />
                </div>
              )}
            </main>

            {/* ---- right: inspector / prompt ---- */}
            {showRight && (
              <EditorRightPanel
                panelStyle={panelStyle}
                rightW={rightW}
                setResizing={setResizing}
                p={p}
                promptCoverUp={promptCoverUp}
                lang={lang}
                rightTab={rightTab}
                setRightTab={setRightTab}
                setRightOpen={setRightOpen}
                selectedFrame={selectedFrame}
                selected={selected}
                setFramePreset={setFramePreset}
                patchFrame={patchFrame}
                deleteFrame={deleteFrame}
                duplicateFrame={duplicateFrame}
                openPreview={openPreview}
                doc={doc}
                widths={widths}
                saveFrameImage={saveFrameImage}
                tidyState={tidyState}
                tidy={tidy}
                setPlace={setPlace}
                selectedMinLength={selectedMinLength}
                setFrameLength={setFrameLength}
                aiReady={aiReady}
                aiReason={aiReason}
                aiBusy={aiBusy}
                aiFrameId={aiFrameId}
                runAi={runAi}
                cancelAi={cancelAi}
                tidyTarget={tidyTarget}
                selectedIds={selectedIds}
                groups={groups}
                selectedPartFrame={selectedPartFrame}
                frame={frame}
                frames={frames}
                patchSelected={patchSelected}
                deleteSelected={deleteSelected}
                duplicateSelected={duplicateSelected}
                selectedLocked={selectedLocked}
                toggleLockSelected={toggleLockSelected}
                selectionPlaceable={selectionPlaceable}
                placeSelected={placeSelected}
                selectedRect={selectedRect}
                onShowOn={onShowOn}
                onShowMenu={onShowMenu}
                selectedGroup={selectedGroup}
                selectionWhole={selectionWhole}
                groupSelected={groupSelected}
                ungroupSelected={ungroupSelected}
                setPromptCoverUp={setPromptCoverUp}
                setTitle={setTitle}
                setBrief={setBrief}
                setPromptEdit={setPromptEdit}
                setPromptOptions={setPromptOptions}
                setPlatform={setPlatform}
              />
            )}

            <input
              ref={projectFileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file)
                  void readProject(file).then((next) =>
                    next
                      ? setPendingImport(next)
                      : showToast(t("invalidProject", lang), 3000, "error"),
                  );
              }}
            />

            <ConfirmDialog
              open={pendingImport !== null}
              icon="file_open"
              title={t("replaceProjectTitle", lang)}
              body={t("replaceProject", lang)}
              p={p}
              onCancel={() => setPendingImport(null)}
              onConfirm={() => {
                if (pendingImport) importDoc(pendingImport);
                setPendingImport(null);
              }}
            />

            <ShareDialog
              p={p}
              doc={doc}
              aiReady={aiReady}
              idea={ideaText}
              onIdea={setIdeaText}
              open={shareOpen}
              onClose={() => setShareOpen(false)}
              onDraft={(idea) => void startDraft(idea)}
              onSetupAi={() => {
                setShareOpen(false);
                setLeftOpen(true);
                setLeftTab("ai");
              }}
            />

            <ConfirmDialog
              open={confirmClear}
              title={t("clearAllTitle", lang)}
              body={t("clearAllBody", lang)}
              p={p}
              onCancel={() => setConfirmClear(false)}
              onConfirm={clearAll}
            />
          </div>

          <AnimatePresence>
            {previewId !== null && frames.length > 0 && (
              <Preview
                key="preview"
                doc={doc}
                widths={widths}
                palette={dp}
                startId={previewId}
                onClose={closePreview}
              />
            )}
          </AnimatePresence>

          {editAccess === "readonly" && <EditAccessDialog p={p} lang={lang} />}
        </DocPaletteContext.Provider>
      </ThemeContext.Provider>
    </LangContext.Provider>
  );
}
