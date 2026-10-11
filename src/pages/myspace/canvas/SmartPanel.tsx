import { useEffect, useState } from "react";
import { Sparkles, Search, Workflow, FileText, Link2, X } from "lucide-react";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import type { SemHit } from "@/api/apiSemantic";
import { make, uid, boundsOf, type Obj } from "@/pages/myspace/canvas/model";
import { layoutGraph, type LayoutDir } from "@/pages/myspace/canvas/smartLayout";
import LinkPicker, { type PickItem } from "@/components/LinkPicker";

interface Props {
  /** Файл открытой доски. */
  file: string;
  objs: Obj[];
  /** id выделенных объектов. */
  sel: string[];
  /** Перейти к объекту (возможно, на другой доске). */
  onFocus: (file: string, id: string) => void;
  /** Заменить содержимое доски (с записью в историю). */
  onApply: (fn: (o: Obj[]) => Obj[]) => void;
  /** Центр видимой области в координатах доски. */
  center: () => { x: number; y: number };
}

const objText = (o: Obj): string => String(o.text || o.name || "").trim();

/** Умные действия на доске: поиск по объектам, раскладка стикеров по смыслу, подбор заметок. */
export function SmartPanel({ file, objs, sel, onFocus, onApply, center }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SemHit[]>([]);
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState<SemHit[]>([]);

  const selOne = objs.find((o) => o.id === sel[0]);

  // «Понять доску»: связи, группы и недостающие шаги от ИИ.
  type Analysis = Awaited<ReturnType<typeof api.canvasAnalyze>>;
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const analyze = async () => {
    setAnalyzing(true);
    setMsg("");
    try {
      setAnalysis(
        await api.canvasAnalyze(
          objs.map((o) => ({
            id: o.id,
            type: o.type,
            text: o.text,
            name: o.name,
            preview: o.preview,
            path: o.path,
            src: o.src,
            link: o.link ? { kind: o.link.kind, ref: o.link.ref } : undefined,
          })),
        ),
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };
  const applyLink = (from: string, to: string) =>
    onApply((all) => [
      ...all,
      { ...make("line", { x: 0, y: 0 }), id: uid(), from: { id: from, side: "auto" }, to: { id: to, side: "auto" } },
    ]);
  const applyGroup = (name: string, ids: string[]) =>
    onApply((all) => {
      const members = all.filter((o) => ids.includes(o.id));
      if (!members.length) return all;
      const boxes = members.map((o) => boundsOf(o));
      const x = Math.min(...boxes.map((b) => b.x)) - 24;
      const y = Math.min(...boxes.map((b) => b.y)) - 40;
      const w = Math.max(...boxes.map((b) => b.x + b.w)) + 24 - x;
      const h = Math.max(...boxes.map((b) => b.y + b.h)) + 24 - y;
      const frame: Obj = { ...make("frame", { x: 0, y: 0 }), id: uid(), x, y, w, h, name, fill: "#e0e7ff", opacity: 0.45 };
      // рамка уходит под объекты, чтобы не закрывать их
      return [frame, ...all];
    });
  const applyMissing = (text: string, i: number) => {
    const c = center();
    onApply((all) => [
      ...all,
      { ...make("sticky", { x: c.x + i * 30, y: c.y + i * 30 }), id: uid(), text, fill: "#bbf7d0" },
    ]);
  };
  const applyEverything = () => {
    if (!analysis) return;
    for (const l of analysis.links) applyLink(l.from, l.to);
    for (const g of analysis.groups) applyGroup(g.name, g.ids);
    analysis.missing.forEach((m, i) => applyMissing(m.text, i));
    setMsg(
      t("canvasSmart.applied", { l: analysis.links.length, g: analysis.groups.length, m: analysis.missing.length }),
    );
    setAnalysis(null);
  };
  const title = (id: string): string => {
    const o = objs.find((x) => x.id === id);
    return o ? objText(o).slice(0, 40) || o.type : id;
  };

  // Поиск: смысловой по всем доскам, плюс точное совпадение слов на этой.
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const tm = setTimeout(async () => {
      const low = text.toLowerCase();
      const local: SemHit[] = objs
        .filter((o) => objText(o).toLowerCase().includes(low))
        .map((o) => ({
          source: "canvas",
          ref: `${file}#${o.id}`,
          title: t("canvasSmart.thisBoard"),
          snippet: objText(o),
          score: 1,
        }));
      let sem: SemHit[] = [];
      try {
        sem = await api.semSearch(text, ["canvas"], 12);
      } catch {
        /* без модели остаются точные совпадения */
      }
      if (!live) return;
      const seen = new Set(local.map((h) => h.ref));
      setHits([...local, ...sem.filter((h) => !seen.has(h.ref))].slice(0, 12));
    }, 300);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [q, objs, file]);

  // Подходящие заметки для выделенного объекта.
  useEffect(() => {
    const text = selOne ? objText(selOne) : "";
    if (!open || text.length < 4) {
      setNotes([]);
      return;
    }
    let live = true;
    api
      .semNotesFor(text, 4)
      .then((h) => live && setNotes(h))
      .catch(() => live && setNotes([]));
    return () => {
      live = false;
    };
  }, [open, selOne]);

  const arrange = (dir: LayoutDir) => {
    const pool = sel.length > 1 ? sel : null;
    const links = objs.filter((o) => o.type === "line" && o.from?.id && o.to?.id).length;
    if (!links) {
      setMsg(t("canvasSmart.needLinks"));
      return;
    }
    onApply((all) => layoutGraph(all, pool, dir));
    setMsg(t("canvasSmart.layoutDone"));
  };

  const [picker, setPicker] = useState(false);
  const addLink = (it: PickItem) => {
    const c = center();
    onApply((all) => [
      ...all,
      {
        ...make("link", c),
        id: uid(),
        text: it.title,
        preview: it.preview?.slice(0, 120),
        link: { kind: it.kind, ref: it.ref, url: it.url },
      },
    ]);
    setPicker(false);
  };

  const attach = (h: SemHit) => {
    const base = selOne ?? objs[objs.length - 1];
    const x = (base?.x ?? 0) + (base?.w ?? 0) + 40;
    const y = base?.y ?? 0;
    onApply((all) => [
      ...all,
      {
        ...make("note", { x: 0, y: 0 }, { w: 240, h: 130 }),
        id: uid(),
        x,
        y,
        path: h.ref,
        name: h.title,
        preview: h.snippet,
        text: h.title,
      },
    ]);
  };

  const box: React.CSSProperties = {
    position: "absolute",
    left: 64,
    bottom: 10,
    zIndex: 30,
    width: 300,
    maxHeight: "70%",
    overflow: "auto",
    padding: 10,
    borderRadius: 12,
    border: "1px solid var(--glass-border)",
    background: "var(--bg-elev, var(--bg-base))",
    boxShadow: "0 8px 30px rgba(0,0,0,.25)",
    fontSize: 12,
  };
  const btn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px",
    borderRadius: 8,
    border: "1px solid var(--glass-border)",
    background: "var(--track)",
    color: "var(--text-primary)",
    cursor: "pointer",
    fontSize: 12,
  };

  return (
    <>
      <button
        type="button"
        title={t("canvasSmart.toggleTitle")}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...btn,
          position: "absolute",
          left: 10,
          bottom: 10,
          zIndex: 31,
          padding: 8,
          color: open ? "var(--amber)" : undefined,
        }}
      >
        <Sparkles size={16} />
      </button>
      {open && (
        <div style={box} onPointerDown={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <b>{t("canvasSmart.title")}</b>
            <X size={14} style={{ cursor: "pointer" }} onClick={() => setOpen(false)} />
          </div>
          <label style={{ ...btn, width: "100%", cursor: "text" }}>
            <Search size={13} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("canvasSmart.searchPh")}
              style={{
                flex: 1,
                border: "none",
                background: "transparent",
                color: "inherit",
                outline: "none",
              }}
            />
          </label>
          {hits.map((h) => {
            const [f, id] = h.ref.split("#");
            return (
              <div
                key={h.ref}
                style={{
                  padding: "5px 4px",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--glass-border)",
                }}
                onClick={() => onFocus(f, id)}
              >
                <div style={{ color: "var(--amber)" }}>{h.title}</div>
                <div style={{ color: "var(--text-tertiary)" }}>{h.snippet.slice(0, 90)}</div>
              </div>
            );
          })}

          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            <button type="button" style={btn} onClick={() => setPicker(true)}>
              <Link2 size={13} /> {t("canvasSmart.insertFromApp")}
            </button>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                style={{ ...btn, flex: 1 }}
                title={t("canvasSmart.layoutLRTitle")}
                onClick={() => arrange("LR")}
              >
                <Workflow size={13} /> {t("canvasSmart.layoutLR")}
              </button>
              <button
                type="button"
                style={{ ...btn, flex: 1 }}
                title={t("canvasSmart.layoutTBTitle")}
                onClick={() => arrange("TB")}
              >
                <Workflow size={13} style={{ transform: "rotate(90deg)" }} />{" "}
                {t("canvasSmart.layoutTB")}
              </button>
            </div>
            <button type="button" style={btn} disabled={analyzing} onClick={() => void analyze()} title={t("canvasSmart.understandHint")}>
              <Sparkles size={13} /> {analyzing ? t("canvasSmart.understandBusy") : t("canvasSmart.understand")}
            </button>
            {analysis && (
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ color: "var(--text-tertiary)" }}>{t("canvasSmart.seen", { n: analysis.seen })}</div>
                {analysis.links.length + analysis.groups.length + analysis.missing.length === 0 && (
                  <div>{t("canvasSmart.nothing")}</div>
                )}
                {analysis.links.length > 0 && <b>{t("canvasSmart.links")}</b>}
                {analysis.links.map((l, i) => (
                  <div key={`l${i}`} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ flex: 1 }}>
                      {title(l.from)} → {title(l.to)}
                      {l.why && <span style={{ color: "var(--text-tertiary)" }}> · {l.why}</span>}
                    </span>
                    <button type="button" style={btn} onClick={() => applyLink(l.from, l.to)}>
                      {t("canvasSmart.apply")}
                    </button>
                  </div>
                ))}
                {analysis.groups.length > 0 && <b>{t("canvasSmart.groups")}</b>}
                {analysis.groups.map((g, i) => (
                  <div key={`g${i}`} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ flex: 1 }}>
                      {g.name} ({g.ids.length})
                    </span>
                    <button type="button" style={btn} onClick={() => applyGroup(g.name, g.ids)}>
                      {t("canvasSmart.apply")}
                    </button>
                  </div>
                ))}
                {analysis.missing.length > 0 && <b>{t("canvasSmart.missing")}</b>}
                {analysis.missing.map((m, i) => (
                  <div key={`m${i}`} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ flex: 1 }}>{m.text}</span>
                    <button type="button" style={btn} onClick={() => applyMissing(m.text, i)}>
                      {t("canvasSmart.apply")}
                    </button>
                  </div>
                ))}
                {analysis.links.length + analysis.groups.length + analysis.missing.length > 0 && (
                  <button type="button" style={btn} onClick={applyEverything}>
                    {t("canvasSmart.applyAll")}
                  </button>
                )}
              </div>
            )}
            {msg && <div style={{ color: "var(--text-secondary)" }}>{msg}</div>}
          </div>

          {notes.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>
                <FileText size={12} /> {t("canvasSmart.relatedNotes")}
              </div>
              {notes.map((h) => (
                <div
                  key={h.ref}
                  title={t("canvasSmart.addNoteCard")}
                  style={{
                    padding: "4px",
                    cursor: "pointer",
                    borderBottom: "1px solid var(--glass-border)",
                  }}
                  onClick={() => attach(h)}
                >
                  <span style={{ color: "var(--amber)" }}>{h.title}</span>{" "}
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {Math.round(h.score * 100)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {picker && <LinkPicker onClose={() => setPicker(false)} onPick={addLink} />}
    </>
  );
}
