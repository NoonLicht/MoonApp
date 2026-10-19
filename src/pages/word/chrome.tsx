import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Minus,
  MessageSquare,
  PenLine,
  Plus,
  Redo2,
  Save,
  Search,
  Share2,
  Sparkles,
  Undo2,
} from "lucide-react";
import { getOverlayRoot } from "@/components/overlayHost";
import { locationLabel, useCommandSearch } from "@/pages/word/dialogs/custom2";
import { MenuPopup } from "@/pages/word/ribbon/Menu";
import type { Cx, Item } from "@/pages/word/ribbon/types";
import { AutosaveSwitch } from "@/components/DocAutosaveUi";
import type { DocAutosave } from "@/lib/docAutosave";

/** Строка заголовка документа: быстрый доступ, название, поиск команд, режим правки, примечания. */
export function TitleBar({ cx, name, auto }: { cx: Cx; name: string; auto: DocAutosave }) {
  const s = cx.s;
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const [mode, setMode] = useState<DOMRect | null>(null);
  const m = useCommandSearch(cx, q);
  const box = useRef<HTMLDivElement>(null);
  const rect = box.current?.getBoundingClientRect();
  const track = s.settings.trackChanges;
  const modeItems: Item[] = [
    {
      label: "Editing",
      act: { cmd: "review.trackChanges", p: { value: false } },
      check: () => !track,
    },
    {
      label: "Reviewing",
      act: { cmd: "review.trackChanges", p: { value: true } },
      check: () => track,
    },
  ];
  return (
    <div className="wd-titlebar">
      <div className="wd-qat">
        <button
          type="button"
          className="wd-ctl wd-small"
          title={cx.tw("Save")}
          aria-label={cx.tw("Save")}
          onClick={() => cx.ui.exportAs("docx")}
        >
          <Save size={15} />
        </button>
        <button
          type="button"
          className="wd-ctl wd-small"
          title={cx.tw("Undo")}
          aria-label={cx.tw("Undo")}
          disabled={!s.canUndo}
          onClick={() => cx.run("edit.undo")}
        >
          <Undo2 size={15} />
        </button>
        <button
          type="button"
          className="wd-ctl wd-small"
          title={cx.tw("Redo")}
          aria-label={cx.tw("Redo")}
          disabled={!s.canRedo}
          onClick={() => cx.run("edit.redo")}
        >
          <Redo2 size={15} />
        </button>
      </div>
      <span className="wd-doc-title">
        {name}
        {s.dirty ? <i> •</i> : null}
      </span>
      <AutosaveSwitch auto={auto} tw={cx.tw} />
      <div className="wd-search" ref={box}>
        <Search size={13} />
        <input
          type="text"
          value={q}
          placeholder={cx.tw("Search")}
          aria-label={cx.tw("Search commands")}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              e.currentTarget.blur();
            }
            if (e.key === "Enter" && m[0]) {
              cx.run(m[0].id);
              setQ("");
              e.currentTarget.blur();
            }
          }}
        />
        {focus && q && m.length && rect
          ? createPortal(
              <div
                className="wd-menu wd-search-list"
                style={{ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 340) }}
                onMouseDown={(e) => e.preventDefault()}
              >
                {m.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="wd-m-item"
                    onClick={() => {
                      cx.run(c.id);
                      setQ("");
                    }}
                  >
                    <span className="wd-m-label">{cx.tw(c.label)}</span>
                    <span className="wd-m-hint">{locationLabel(cx, c.location)}</span>
                  </button>
                ))}
              </div>,
              getOverlayRoot() ?? document.body,
            )
          : null}
      </div>
      <button
        type="button"
        className="wd-title-btn accent"
        onClick={() => cx.ui.backstage("share")}
      >
        <Share2 size={13} />
        {cx.tw("Share")}
      </button>
      <button
        type="button"
        className="wd-title-btn"
        onClick={(e) => setMode(e.currentTarget.getBoundingClientRect())}
      >
        <PenLine size={13} />
        {cx.tw(track ? "Reviewing" : "Editing")}
      </button>
      {mode ? (
        <MenuPopup items={modeItems} cx={cx} anchor={mode} onClose={() => setMode(null)} />
      ) : null}
      <button
        type="button"
        className={`wd-title-btn${cx.ui.pane === "assistant" ? " accent" : ""}`}
        onClick={() => cx.ui.togglePane("assistant")}
      >
        <Sparkles size={13} />
        {cx.tw("Assistant")}
      </button>
      <button
        type="button"
        className={`wd-title-btn${cx.ui.pane === "comments" ? " accent" : ""}`}
        onClick={() => cx.ui.togglePane("comments")}
      >
        <MessageSquare size={13} />
        {cx.tw("Comments")}
      </button>
    </div>
  );
}

/** Строка состояния: страница, слова, язык, режимы просмотра и масштаб. */
export function StatusBar({ cx, langName }: { cx: Cx; langName: string }) {
  const s = cx.s;
  const page = (s.caret?.page ?? 0) + 1;
  const pct = Math.round(cx.ui.zoom * 100);
  const mode = s.view.readMode || s.view.mode === "read" ? "read" : s.view.mode;
  return (
    <div className="wd-status">
      <button type="button" onClick={() => cx.dialog("goto")}>
        {cx.tw("Page {n} of {m}", { n: page, m: s.pages.length })}
      </button>
      <button type="button" onClick={() => cx.dialog("wordCount")}>
        {cx.tw("Words: {n}", { n: s.words })}
      </button>
      <button type="button" onClick={() => cx.dialog("language")}>
        {langName}
      </button>
      {s.settings.trackChanges ? (
        <span style={{ color: "var(--amber)", padding: "0 6px" }}>{cx.tw("Track Changes")}</span>
      ) : null}
      {s.settings.protection ? (
        <span style={{ padding: "0 6px" }}>🔒 {s.settings.protection}</span>
      ) : null}
      <span style={{ flex: 1 }} />
      {s.status ? (
        <span
          style={{
            opacity: 0.8,
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {s.status}
        </span>
      ) : null}
      <button
        type="button"
        className={mode === "read" ? "on" : ""}
        onClick={() => cx.run("view.readMode")}
      >
        {cx.tw("Read Mode")}
      </button>
      <button
        type="button"
        className={mode === "print" ? "on" : ""}
        onClick={() => cx.run("view.printLayout")}
      >
        {cx.tw("Print Layout")}
      </button>
      <button
        type="button"
        className={mode === "web" ? "on" : ""}
        onClick={() => cx.run("view.webLayout")}
      >
        {cx.tw("Web Layout")}
      </button>
      <span className="wd-zoom">
        <button
          type="button"
          aria-label={cx.tw("Zoom Out")}
          onClick={() => cx.ui.setZoom(Math.max(0.1, +(cx.ui.zoom - 0.1).toFixed(2)))}
        >
          <Minus size={12} />
        </button>
        <input
          type="range"
          min={10}
          max={300}
          value={Math.min(300, Math.max(10, pct))}
          aria-label={cx.tw("Zoom")}
          onChange={(e) => cx.ui.setZoom(Number(e.target.value) / 100)}
        />
        <button
          type="button"
          aria-label={cx.tw("Zoom In")}
          onClick={() => cx.ui.setZoom(Math.min(5, +(cx.ui.zoom + 0.1).toFixed(2)))}
        >
          <Plus size={12} />
        </button>
        <button type="button" onClick={() => cx.dialog("zoom")} style={{ minWidth: 44 }}>
          {pct}%
        </button>
      </span>
    </div>
  );
}
