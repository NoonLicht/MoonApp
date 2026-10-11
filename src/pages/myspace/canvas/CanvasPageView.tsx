import { ObjectView } from "@/pages/myspace/canvas/ObjectView";
import { SelectionLayer } from "@/pages/myspace/canvas/SelectionLayer";
import { ToolDock } from "@/pages/myspace/canvas/ToolDock";
import { TopBar } from "@/pages/myspace/canvas/TopBar";
import { LayersPanel } from "@/pages/myspace/canvas/Layers";
import { Minimap } from "@/pages/myspace/canvas/Minimap";
import { SmartPanel } from "@/pages/myspace/canvas/SmartPanel";
import { LS, lsSet } from "@/pages/myspace/canvas/useCanvasKeyboard";
import { Shortcuts } from "@/pages/myspace/canvas/Shortcuts";
import { ContextMenu } from "@/pages/myspace/canvas/ContextMenu";
import { TemplatesModal } from "@/pages/myspace/canvas/TemplatePicker";
import type { useCanvasPageResult } from "@/pages/myspace/canvas/useCanvasPage";

/** Разметка страницы; всё состояние приходит из useCanvasPage. */
export default function CanvasPageView({ c }: { c: useCanvasPageResult }) {
  const {
    t,
    board,
    objs,
    byId,
    byIdRef,
    sel,
    selRef,
    setSel,
    tool,
    setTool,
    shapeKind,
    setShapeKind,
    emoji,
    setEmoji,
    penColor,
    penWidth,
    view,
    viewRef,
    setView,
    size,
    editing,
    hover,
    guides,
    marquee,
    penPts,
    ctx,
    setCtx,
    tplOpen,
    setTplOpen,
    rightTab,
    setRightTab,
    dropping,
    setDropping,
    grid,
    setGrid,
    snap,
    setSnap,
    helpOpen,
    setHelpOpen,
    wheelZoom,
    setWheelZoom,
    boards,
    file,
    name,
    setName,
    save,
    ready,
    wrapRef,
    worldRef,
    fileInput,
    openBoard,
    createBoard,
    removeBoard,
    onPatch,
    onMeasure,
    onCommit,
    setZoom,
    fitAll,
    fitSelection,
    focusObject,
    viewCenter,
    addImageBlob,
    applyTemplate,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    onContextMenu,
    onDrop,
    exportBoard,
    geoms,
    side,
    cursor,
  } = c;
  return (
    <div className="hc-root">
      <div
        ref={wrapRef}
        className="hc-stage"
        style={{
          cursor,
          backgroundSize: grid ? `${24 * view.z}px ${24 * view.z}px` : undefined,
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundImage: grid
            ? "radial-gradient(circle, var(--hc-dot) 1.2px, transparent 1.4px)"
            : "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onDragOver={(e) => {
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={onDrop}
      >
        <div
          ref={worldRef}
          className="hc-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          {objs.map((o) => (
            <ObjectView
              key={o.id}
              o={o}
              editing={editing === o.id}
              selected={sel.includes(o.id)}
              geom={geoms.get(o.id)}
              onCommit={onCommit}
              onPatch={onPatch}
              onMeasure={onMeasure}
            />
          ))}
          <div data-export-skip="1">
            <SelectionLayer
              objs={objs}
              byId={byId}
              sel={sel}
              hover={hover}
              z={view.z}
              guides={guides}
              marquee={marquee}
              pen={penPts}
              penColor={penColor}
              penWidth={penWidth}
              showPorts={(tool === "select" || tool === "line") && !editing}
            />
          </div>
        </div>

        {objs.length === 0 && ready && <div className="hc-empty">{t("empty")}</div>}
        {dropping && <div className="hc-drop-hint">{t("dropHere")}</div>}
      </div>

      <TopBar
        t={t}
        boards={boards}
        file={file}
        name={name}
        onName={setName}
        onOpenBoard={(f) => void openBoard(f)}
        onNewBoard={() => void createBoard()}
        onDeleteBoard={(f) => void removeBoard(f)}
        canUndo={board.canUndo}
        canRedo={board.canRedo}
        onUndo={() => board.undo()}
        onRedo={() => board.redo()}
        zoom={view.z}
        onZoom={setZoom}
        onFit={fitAll}
        onFitSel={fitSelection}
        hasSel={sel.length > 0}
        grid={grid}
        onGrid={() => {
          setGrid(!grid);
          lsSet(LS.grid, grid ? "0" : "1");
        }}
        snap={snap}
        onSnap={() => {
          setSnap(!snap);
          lsSet(LS.snap, snap ? "0" : "1");
        }}
        wheelZoom={wheelZoom}
        onWheel={() => {
          setWheelZoom(!wheelZoom);
          lsSet(LS.wheel, wheelZoom ? "0" : "1");
        }}
        onTemplates={() => setTplOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onExport={(f) => void exportBoard(f)}
        save={save}
      />
      <ToolDock
        tool={tool}
        onTool={setTool}
        shape={shapeKind}
        onShape={setShapeKind}
        emoji={emoji}
        onEmoji={setEmoji}
        onImage={() => fileInput.current?.click()}
        t={t}
      />
      <div className="hc-side" data-ui>
        <div className="hc-tabs hc-float">
          <button
            type="button"
            className={rightTab === "props" ? "on" : ""}
            onClick={() => setRightTab("props")}
          >
            {t("props")}
          </button>
          <button
            type="button"
            className={rightTab === "layers" ? "on" : ""}
            onClick={() => setRightTab("layers")}
          >
            {t("layers")}
          </button>
        </div>
        {rightTab === "layers" ? (
          <div className="hc-insp hc-float" data-ui>
            <LayersPanel
              objs={objs}
              sel={sel}
              t={t}
              onSelect={(id, add) => {
                const o = byIdRef.current.get(id);
                if (!o || o.hidden) return;
                setSel(
                  add
                    ? selRef.current.includes(id)
                      ? selRef.current.filter((s) => s !== id)
                      : [...selRef.current, id]
                    : [id],
                );
              }}
              onToggle={(id, what) =>
                board.apply((all) => all.map((x) => (x.id === id ? { ...x, [what]: !x[what] } : x)))
              }
              onRename={(id, nm) =>
                board.apply((all) =>
                  all.map((x) => (x.id === id ? { ...x, name: nm.trim() || undefined } : x)),
                )
              }
            />
          </div>
        ) : (
          side
        )}
      </div>
      <SmartPanel
        file={file}
        objs={objs}
        sel={sel}
        onFocus={(f, id) => void focusObject(f, id)}
        onApply={(fn) => board.apply(fn)}
        center={() => ({
          x: (size.w / 2 - viewRef.current.x) / viewRef.current.z,
          y: (size.h / 2 - viewRef.current.y) / viewRef.current.z,
        })}
      />
      <Minimap
        objs={objs}
        byId={byId}
        view={view}
        size={size}
        onJump={(wx, wy) =>
          setView({
            ...viewRef.current,
            x: size.w / 2 - wx * viewRef.current.z,
            y: size.h / 2 - wy * viewRef.current.z,
          })
        }
      />

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          let n = 0;
          for (const f of files) {
            const c = viewCenter();
            void addImageBlob(f, { x: c.x + n * 30, y: c.y + n * 30 });
            n++;
          }
        }}
      />
      {helpOpen && <Shortcuts onClose={() => setHelpOpen(false)} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
      {tplOpen && (
        <TemplatesModal t={t} onClose={() => setTplOpen(false)} onSelect={applyTemplate} />
      )}
    </div>
  );
}
