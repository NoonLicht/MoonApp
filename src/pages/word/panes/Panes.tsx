import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { api } from "@/api/client";
import { useStyles } from "@/pages/word/ribbon/custom";
import type { Cx, PaneName, Params } from "@/pages/word/ribbon/types";
import { WordAssistant } from "@/components/assistant/DocAssistant";

/** Данные панели: перечитываются при правках документа (с задержкой, чтобы не мешать набору). */
function useLoad<T>(cx: Cx, cmd: string, params: Params, live = true): [T | undefined, () => void] {
  const [data, setData] = useState<T>();
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(params);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () => {
        void cx.call(cmd, JSON.parse(key) as Params).then((r) => alive && setData(r as T));
      },
      tick === 0 ? 0 : 200,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // cx.call стабильна; обновляем по ревизии документа и ручному обновлению
  }, [cx.call, cmd, key, live ? cx.s.rev : 0, tick]);
  return [data, () => setTick((n) => n + 1)];
}

function Shell({
  title,
  side,
  onClose,
  children,
  tabs,
}: {
  title: string;
  side: "left" | "right";
  onClose: () => void;
  children: ReactNode;
  tabs?: ReactNode;
}) {
  return (
    <aside className={`wd-pane ${side}`}>
      <div className="wd-pane-head">
        <span style={{ flex: 1 }}>{title}</span>
        <button type="button" className="wd-x-btn" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {tabs}
      <div className="wd-pane-body">{children}</div>
    </aside>
  );
}

const pos = (path: number[], off = 0) => ({ story: "body", path, off });

/** Фрагмент строки по байтовым смещениям UTF-8, как их отдаёт ядро. */
function byteSlice(text: string, a: number, b: number): string {
  const bytes = new TextEncoder().encode(text);
  const cont = (i: number) => i < bytes.length && (bytes[i] & 0xc0) === 0x80;
  let from = Math.max(0, a);
  let to = Math.max(from, b);
  while (cont(from)) from++; // границы окна не должны резать многобайтовый символ
  while (to > from && cont(to)) to--;
  return new TextDecoder().decode(bytes.slice(from, to));
}

/* ---------------- Навигация ---------------- */

interface Targets {
  headings: { block: number; level: number; text: string }[];
}
interface Inspect {
  blocks: { index: number; text: string; len: number }[];
  pages: number;
}
interface Found {
  count: number;
  matches: { start: { path: number[]; off: number }; end: { path: number[]; off: number } }[];
}

function PageThumb({ cx, index }: { cx: Cx; index: number }) {
  const [url, setUrl] = useState("");
  const [vis, setVis] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => setVis(e.some((x) => x.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const page = cx.s.pages[index];
  useEffect(() => {
    if (!vis) return;
    let alive = true;
    let u = "";
    const t = setTimeout(() => {
      void api
        .wordPage(cx.docId, index + 1, 0.3)
        .then((b) => {
          if (!alive) return;
          u = URL.createObjectURL(b);
          setUrl(u);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
      if (u) setTimeout(() => URL.revokeObjectURL(u), 200);
    };
  }, [vis, cx.docId, index, cx.s.rev]);
  return (
    <button
      ref={ref}
      type="button"
      className="wd-nav-item"
      style={{
        aspectRatio: `${page?.w ?? 612} / ${page?.h ?? 792}`,
        background: "#fff",
        padding: 0,
        border: "1px solid var(--glass-border)",
      }}
      onClick={() => window.dispatchEvent(new CustomEvent("wd-scroll-page", { detail: index }))}
      aria-label={`${index + 1}`}
    >
      {url ? <img src={url} alt="" style={{ width: "100%", display: "block" }} /> : null}
    </button>
  );
}

export function NavigationPane({
  cx,
  onClose,
  focusSearch,
}: {
  cx: Cx;
  onClose: () => void;
  focusSearch: boolean;
}) {
  const [tab, setTab] = useState<"headings" | "pages" | "results">(
    focusSearch ? "results" : "headings",
  );
  const [q, setQ] = useState("");
  const [targets] = useLoad<Targets>(cx, "link.targets", {});
  const [insp] = useLoad<Inspect>(cx, "document.inspect", { text: true }, tab === "results");
  const [found, setFound] = useState<Found | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearch) input.current?.focus();
  }, [focusSearch]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      if (!q) {
        setFound(null);
        void cx.call("select.collapse", {});
        return;
      }
      void cx
        .call("edit.advancedFind", { text: q, highlight: true })
        .then((r) => alive && setFound(r as Found));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [cx, q]);
  const go = (path: number[], off = 0, end?: { path: number[]; off: number }): void => {
    cx.run("select.range", {
      anchor: pos(path, off),
      focus: pos(end?.path ?? path, end?.off ?? off),
    });
    window.dispatchEvent(new CustomEvent("wd-scroll-caret"));
  };
  const tabs = (
    <div className="wd-pane-tabs">
      {(["headings", "pages", "results"] as const).map((t) => (
        <button key={t} type="button" className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
          {cx.tw(t === "headings" ? "Headings" : t === "pages" ? "Pages" : "Results")}
        </button>
      ))}
    </div>
  );
  return (
    <Shell title={cx.tw("Navigation Pane")} side="left" onClose={onClose} tabs={tabs}>
      <input
        ref={input}
        type="text"
        value={q}
        placeholder={cx.tw("Search document")}
        onChange={(e) => {
          setQ(e.target.value);
          if (e.target.value) setTab("results");
        }}
      />
      {tab === "headings" ? (
        (targets?.headings ?? []).length ? (
          (targets?.headings ?? []).map((h) => (
            <button
              key={h.block}
              type="button"
              className="wd-nav-item"
              style={{ paddingLeft: 6 + (h.level - 1) * 14, fontWeight: h.level === 1 ? 600 : 400 }}
              onClick={() => go([h.block])}
            >
              {h.text || "—"}
            </button>
          ))
        ) : (
          <div className="wd-muted">
            {cx.tw("Create an outline for your document with headings.")}
          </div>
        )
      ) : null}
      {tab === "pages" ? cx.s.pages.map((_, i) => <PageThumb key={i} cx={cx} index={i} />) : null}
      {tab === "results" ? (
        found ? (
          <>
            <div className="wd-muted">{cx.tw("Found {n}", { n: found.count })}</div>
            {found.matches.slice(0, 200).map((m, i) => {
              const text = insp?.blocks.find((b) => b.index === m.start.path[0])?.text ?? "";
              const before = byteSlice(text, Math.max(0, m.start.off - 24), m.start.off);
              const hit = byteSlice(text, m.start.off, m.end.off);
              const after = byteSlice(text, m.end.off, m.end.off + 40);
              return (
                <button
                  key={i}
                  type="button"
                  className="wd-nav-item"
                  onClick={() => go(m.start.path, m.start.off, m.end)}
                >
                  <span className="wd-muted">…{before}</span>
                  <mark style={{ background: "var(--amber-soft)", color: "inherit" }}>{hit}</mark>
                  <span className="wd-muted">{after}…</span>
                </button>
              );
            })}
          </>
        ) : (
          <div className="wd-muted">{cx.tw("Type text to search.")}</div>
        )
      ) : null}
    </Shell>
  );
}

/* ---------------- Примечания ---------------- */

interface Comment {
  id: number;
  author: string;
  date: string;
  parent: number | null;
  resolved: boolean;
  text: string;
  anchor: { path: number[]; off: number };
}

const fmtDate = (d: string): string => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleString();
};

export function CommentsPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const [list, reload] = useLoad<Comment[]>(cx, "review.comments", {});
  const [reply, setReply] = useState<{ id: number; text: string } | null>(null);
  const [edit, setEdit] = useState<{ id: number; text: string } | null>(null);
  const roots = (list ?? []).filter((c) => c.parent == null);
  return (
    <Shell title={cx.tw("Comments")} side="right" onClose={onClose}>
      <button type="button" className="wd-mini" onClick={() => cx.dialog("newComment")}>
        {cx.tw("New Comment")}
      </button>
      {roots.length === 0 ? (
        <div className="wd-muted">{cx.tw("No comments in the document.")}</div>
      ) : null}
      {roots.map((c) => (
        <div key={c.id} className="wd-card" style={c.resolved ? { opacity: 0.6 } : undefined}>
          <button
            type="button"
            className="wd-nav-item"
            style={{ padding: 0 }}
            onClick={() =>
              cx.run("select.range", {
                anchor: pos(c.anchor.path, c.anchor.off),
                focus: pos(c.anchor.path, c.anchor.off),
              })
            }
          >
            <b>{c.author}</b>
            <div className="meta">{fmtDate(c.date)}</div>
          </button>
          {edit?.id === c.id ? (
            <>
              <textarea
                rows={3}
                value={edit.text}
                onChange={(e) => setEdit({ id: c.id, text: e.target.value })}
              />
              <div className="actions">
                <button
                  type="button"
                  className="wd-mini"
                  onClick={() => {
                    cx.run("review.editComment", { id: c.id, text: edit.text });
                    setEdit(null);
                    setTimeout(reload, 300);
                  }}
                >
                  {cx.tw("Save")}
                </button>
                <button type="button" className="wd-mini" onClick={() => setEdit(null)}>
                  {cx.tw("Cancel")}
                </button>
              </div>
            </>
          ) : (
            <div style={{ whiteSpace: "pre-wrap" }}>{c.text}</div>
          )}
          {(list ?? [])
            .filter((r) => r.parent === c.id)
            .map((r) => (
              <div
                key={r.id}
                style={{ borderLeft: "2px solid var(--glass-border)", paddingLeft: 8 }}
              >
                <b>{r.author}</b> <span className="meta wd-muted">{fmtDate(r.date)}</span>
                <div style={{ whiteSpace: "pre-wrap" }}>{r.text}</div>
              </div>
            ))}
          {reply?.id === c.id ? (
            <>
              <textarea
                rows={2}
                value={reply.text}
                autoFocus
                onChange={(e) => setReply({ id: c.id, text: e.target.value })}
              />
              <div className="actions">
                <button
                  type="button"
                  className="wd-mini"
                  disabled={!reply.text.trim()}
                  onClick={() => {
                    cx.run("review.reply", { id: c.id, text: reply.text });
                    setReply(null);
                    setTimeout(reload, 300);
                  }}
                >
                  {cx.tw("Reply")}
                </button>
                <button type="button" className="wd-mini" onClick={() => setReply(null)}>
                  {cx.tw("Cancel")}
                </button>
              </div>
            </>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="wd-mini"
                onClick={() => setReply({ id: c.id, text: "" })}
              >
                {cx.tw("Reply")}
              </button>
              <button
                type="button"
                className="wd-mini"
                onClick={() => setEdit({ id: c.id, text: c.text })}
              >
                {cx.tw("Edit Comment")}
              </button>
              <button
                type="button"
                className="wd-mini"
                onClick={() => {
                  cx.run("select.range", {
                    anchor: pos(c.anchor.path, c.anchor.off),
                    focus: pos(c.anchor.path, c.anchor.off),
                  });
                  cx.run("review.resolveComment", { id: c.id });
                  setTimeout(reload, 300);
                }}
              >
                {cx.tw(c.resolved ? "Reopen" : "Resolve")}
              </button>
              <button
                type="button"
                className="wd-mini"
                onClick={() => {
                  cx.run("review.deleteComment", { id: c.id });
                  setTimeout(reload, 300);
                }}
              >
                {cx.tw("Delete")}
              </button>
            </div>
          )}
        </div>
      ))}
    </Shell>
  );
}

/* ---------------- Исправления ---------------- */

interface Change {
  author: string;
  date: string;
  kind: string;
  text: string;
  start: { path: number[]; off: number };
  end: { path: number[]; off: number };
}

export function ReviewingPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const [list] = useLoad<Change[]>(cx, "review.changes", {});
  const select = (c: Change): void =>
    cx.run("select.range", {
      anchor: pos(c.start.path, c.start.off),
      focus: pos(c.end.path, c.end.off),
    });
  const kindLabel = (k: string): string =>
    cx.tw(k === "insert" ? "Inserted" : k === "delete" ? "Deleted" : "Formatted");
  return (
    <Shell title={cx.tw("Reviewing Pane")} side="left" onClose={onClose}>
      <div className="wd-muted">{cx.tw("{n} revisions", { n: (list ?? []).length })}</div>
      {(list ?? []).map((c, i) => (
        <div key={i} className="wd-card">
          <button
            type="button"
            className="wd-nav-item"
            style={{ padding: 0 }}
            onClick={() => select(c)}
          >
            <b>{kindLabel(c.kind)}</b> · {c.author}
            <div className="meta">{fmtDate(c.date)}</div>
            <div
              style={{
                whiteSpace: "pre-wrap",
                textDecoration: c.kind === "delete" ? "line-through" : undefined,
              }}
            >
              {c.text.slice(0, 200)}
            </div>
          </button>
          <div className="actions">
            <button
              type="button"
              className="wd-mini"
              onClick={() => {
                select(c);
                cx.run("review.accept");
              }}
            >
              {cx.tw("Accept")}
            </button>
            <button
              type="button"
              className="wd-mini"
              onClick={() => {
                select(c);
                cx.run("review.reject");
              }}
            >
              {cx.tw("Reject")}
            </button>
          </div>
        </div>
      ))}
      <div className="actions" style={{ display: "flex", gap: 4 }}>
        <button type="button" className="wd-mini" onClick={() => cx.run("review.acceptAll")}>
          {cx.tw("Accept All Changes")}
        </button>
        <button type="button" className="wd-mini" onClick={() => cx.run("review.rejectAll")}>
          {cx.tw("Reject All Changes")}
        </button>
      </div>
    </Shell>
  );
}

/* ---------------- Стили ---------------- */

export function StylesPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const styles = useStyles(cx);
  const cur = cx.s.paraResolved?.style ?? "";
  const curChar = String(cx.s.format.style ?? "");
  const list = styles
    .filter((s) => !s.hidden && s.type !== "table" && s.type !== "numbering")
    .sort((a, b) => a.priority - b.priority);
  return (
    <Shell title={cx.tw("Styles")} side="right" onClose={onClose}>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="wd-mini" onClick={() => cx.dialog("createStyle")}>
          {cx.tw("Create a Style")}
        </button>
        <button type="button" className="wd-mini" onClick={() => cx.run("format.clear")}>
          {cx.tw("Clear All Formatting")}
        </button>
      </div>
      {list.map((s) => (
        <button
          key={s.id}
          type="button"
          className="wd-nav-item"
          style={s.id === cur || s.id === curChar ? { background: "var(--wd-on)" } : undefined}
          onClick={() =>
            s.type === "character"
              ? cx.run("format.charStyle", { style: s.id })
              : cx.run("para.style", { style: s.id })
          }
        >
          <span
            style={{
              fontFamily: s.format.font ? `"${s.format.font}"` : undefined,
              fontSize: Math.min(s.format.size ?? 12, 22),
              color: s.format.color ? `#${s.format.color}` : undefined,
              fontWeight: s.format.bold ? 700 : undefined,
              fontStyle: s.format.italic ? "italic" : undefined,
            }}
          >
            {cx.tw(s.name)}
          </span>
          <span className="wd-muted" style={{ float: "right" }}>
            {s.type === "character" ? "a" : "¶"}
          </span>
        </button>
      ))}
    </Shell>
  );
}

/* ---------------- Правописание ---------------- */

interface Issue {
  kind: string;
  message: string;
  text: string;
  suggestions: string[];
  start: { path: number[]; off: number };
  end: { path: number[]; off: number };
}

export function ProofingPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const [list] = useLoad<Issue[]>(cx, "review.issues", {});
  return (
    <Shell title={cx.tw("Editor")} side="right" onClose={onClose}>
      {(list ?? []).length === 0 ? (
        <div className="wd-muted">{cx.tw("No spelling or grammar issues found.")}</div>
      ) : null}
      {(list ?? []).map((it, i) => (
        <div key={i} className="wd-card">
          <button
            type="button"
            className="wd-nav-item"
            style={{ padding: 0 }}
            onClick={() =>
              cx.run("select.range", {
                anchor: pos(it.start.path, it.start.off),
                focus: pos(it.end.path, it.end.off),
              })
            }
          >
            <b>{it.text}</b>
            <div className="meta">{cx.tw(it.message)}</div>
          </button>
          <div className="actions">
            {it.suggestions.slice(0, 5).map((s) => (
              <button
                key={s}
                type="button"
                className="wd-mini"
                onClick={() => {
                  cx.run("select.range", {
                    anchor: pos(it.start.path, it.start.off),
                    focus: pos(it.end.path, it.end.off),
                  });
                  cx.run("review.applySuggestion", { text: s });
                }}
              >
                {s}
              </button>
            ))}
            <button
              type="button"
              className="wd-mini"
              onClick={() => {
                cx.run("select.range", {
                  anchor: pos(it.start.path, it.start.off),
                  focus: pos(it.end.path, it.end.off),
                });
                cx.run("review.ignoreAll");
              }}
            >
              {cx.tw("Ignore All")}
            </button>
            <button
              type="button"
              className="wd-mini"
              onClick={() => cx.run("review.addToDictionary", { word: it.text })}
            >
              {cx.tw("Add to Dictionary")}
            </button>
          </div>
        </div>
      ))}
    </Shell>
  );
}

/* ---------------- Доступность ---------------- */

export function AccessibilityPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const [r] = useLoad<{ ok: boolean; issues: { issue: string; kind: string; fix?: string }[] }>(
    cx,
    "file.accessibility",
    {},
  );
  return (
    <Shell title={cx.tw("Check Accessibility")} side="right" onClose={onClose}>
      {r?.ok ? <div className="wd-muted">{cx.tw("No accessibility issues found.")}</div> : null}
      {(r?.issues ?? []).map((it, i) => (
        <div key={i} className="wd-card">
          <b>{cx.tw(it.issue)}</b>
          <div className="meta">{it.kind}</div>
        </div>
      ))}
    </Shell>
  );
}

/* ---------------- Замещающий текст ---------------- */

export function AltTextPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const o = cx.s.ctx.object;
  const [text, setText] = useState(o?.alt ?? "");
  useEffect(() => setText(o?.alt ?? ""), [o?.alt, o?.kind]);
  return (
    <Shell title={cx.tw("Alt Text")} side="right" onClose={onClose}>
      {o ? (
        <>
          <textarea
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={cx.tw("Alt text")}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="wd-mini"
              onClick={() =>
                cx.run(o.kind === "picture" ? "picture.altText" : "object.altText", { text })
              }
            >
              {cx.tw("Save")}
            </button>
            <button
              type="button"
              className="wd-mini"
              onClick={() =>
                cx.run(o.kind === "picture" ? "picture.altText" : "object.altText", {
                  text: "",
                  decorative: true,
                })
              }
            >
              {cx.tw("Mark as decorative")}
            </button>
          </div>
        </>
      ) : (
        <div className="wd-muted">{cx.tw("Select a picture or shape.")}</div>
      )}
    </Shell>
  );
}

/* ---------------- Буфер обмена ---------------- */

export function ClipboardPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const [items, reload] = useLoad<{ text?: string; label?: string; preview?: string }[]>(
    cx,
    "edit.clipboardItems",
    {},
    false,
  );
  useEffect(reload, [cx.s.rev]);
  return (
    <Shell title={cx.tw("Clipboard")} side="left" onClose={onClose}>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="wd-mini" onClick={() => cx.run("edit.pasteAllClipboard")}>
          {cx.tw("Paste All")}
        </button>
        <button
          type="button"
          className="wd-mini"
          onClick={() => {
            cx.run("edit.clearClipboard");
            setTimeout(reload, 300);
          }}
        >
          {cx.tw("Clear All")}
        </button>
      </div>
      {(items ?? []).length === 0 ? (
        <div className="wd-muted">{cx.tw("Clipboard is empty.")}</div>
      ) : null}
      {(items ?? []).map((it, i) => (
        <button
          key={i}
          type="button"
          className="wd-nav-item wd-card"
          onClick={() => cx.run("edit.pasteClipboardItem", { index: i })}
        >
          {String(it.text ?? it.preview ?? it.label ?? "").slice(0, 160)}
        </button>
      ))}
    </Shell>
  );
}

/* ---------------- Область выделения ---------------- */

interface SelObj {
  index: number;
  kind: string;
  name: string;
  hidden: boolean;
}

export function SelectionPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const [list] = useLoad<SelObj[]>(cx, "arrange.selectionPane", {});
  return (
    <Shell title={cx.tw("Selection Pane")} side="right" onClose={onClose}>
      {(list ?? []).length === 0 ? (
        <div className="wd-muted">{cx.tw("No objects in the document.")}</div>
      ) : null}
      {(list ?? []).map((o) => (
        <button
          key={o.index}
          type="button"
          className="wd-nav-item"
          onClick={() => cx.run("select.objects", { index: o.index })}
        >
          {o.name}
        </button>
      ))}
    </Shell>
  );
}

/* ---------------- Текст SmartArt ---------------- */

export function SmartArtPane({ cx, onClose }: { cx: Cx; onClose: () => void }) {
  const sa = cx.s.ctx.object?.smartArt;
  const initial = useMemo(
    () => (sa?.items ?? []).map((i) => `${"  ".repeat(i.level ?? 0)}${i.text}`).join("\n"),
    [sa],
  );
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const apply = useCallback(() => {
    const items = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => ({
        text: l.trim(),
        level: Math.min(7, Math.floor((l.length - l.trimStart().length) / 2)),
      }));
    cx.run("smartArt.items", { items });
  }, [cx, text]);
  return (
    <Shell title={cx.tw("Text Pane")} side="right" onClose={onClose}>
      {sa ? (
        <>
          <textarea
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={apply}
            style={{ fontFamily: "var(--font-mono)" }}
          />
          <div className="wd-muted">{cx.tw("Indent with two spaces to make a sub-item.")}</div>
        </>
      ) : (
        <div className="wd-muted">{cx.tw("Select a SmartArt graphic.")}</div>
      )}
    </Shell>
  );
}

export function PaneHost({
  name,
  cx,
  onClose,
  focusSearch,
}: {
  name: PaneName;
  cx: Cx;
  onClose: () => void;
  focusSearch: boolean;
}) {
  switch (name) {
    case "navigation":
    case "find":
      return (
        <NavigationPane cx={cx} onClose={onClose} focusSearch={focusSearch || name === "find"} />
      );
    case "comments":
      return <CommentsPane cx={cx} onClose={onClose} />;
    case "reviewing":
      return <ReviewingPane cx={cx} onClose={onClose} />;
    case "styles":
      return <StylesPane cx={cx} onClose={onClose} />;
    case "proofing":
      return <ProofingPane cx={cx} onClose={onClose} />;
    case "accessibility":
      return <AccessibilityPane cx={cx} onClose={onClose} />;
    case "altText":
      return <AltTextPane cx={cx} onClose={onClose} />;
    case "clipboard":
      return <ClipboardPane cx={cx} onClose={onClose} />;
    case "selection":
      return <SelectionPane cx={cx} onClose={onClose} />;
    case "smartArt":
      return <SmartArtPane cx={cx} onClose={onClose} />;
    case "assistant":
      return <WordAssistant cx={cx} onClose={onClose} />;
  }
}
