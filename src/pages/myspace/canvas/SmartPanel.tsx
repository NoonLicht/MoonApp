import { useEffect, useMemo, useState } from "react";
import { Sparkles, Search, LayoutGrid, FileText, X } from "lucide-react";
import { api } from "@/api/client";
import type { SemHit } from "@/api/apiSemantic";
import { make, uid, type Obj } from "@/pages/myspace/canvas/model";

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
}

const objText = (o: Obj): string => String(o.text || o.name || "").trim();

/**
 * Раскладка стикеров по смыслу: группы → рамки, внутри рамки стикеры сеткой.
 * Рамки идут вниз по списку слоёв (под стикеры), стикерам выставляется parent.
 */
export function layoutByGroups(objs: Obj[], ids: string[], groups: number[][]): Obj[] {
  const byId = new Map(objs.map((o) => [o.id, o]));
  const items = ids.map((id) => byId.get(id)).filter((o): o is Obj => !!o);
  if (!items.length) return objs;
  const minX = Math.min(...items.map((o) => o.x));
  const minY = Math.min(...items.map((o) => o.y));
  const CW = 190;
  const CH = 170;
  const PAD = 16;
  const HEAD = 44;
  // одиночки собираем в «Разное»
  const real = groups.filter((g) => g.length > 1);
  const rest = groups.filter((g) => g.length === 1).flat();
  if (rest.length) real.push(rest);

  const frames: Obj[] = [];
  const moved = new Map<string, Obj>();
  let cx = minX;
  let cy = minY;
  let rowH = 0;
  const maxRow = 4;
  let inRow = 0;
  real.forEach((g, gi) => {
    const cols = Math.max(1, Math.ceil(Math.sqrt(g.length)));
    const rows = Math.ceil(g.length / cols);
    const w = cols * CW + PAD;
    const h = rows * CH + HEAD + PAD;
    if (inRow >= maxRow) {
      cx = minX;
      cy += rowH + 40;
      rowH = 0;
      inRow = 0;
    }
    const first = items[g[0]];
    const label = g === rest ? "Разное" : objText(first).slice(0, 26) || `Тема ${gi + 1}`;
    const frame: Obj = {
      ...make("frame", { x: 0, y: 0 }, { w, h }),
      x: cx,
      y: cy,
      w,
      h,
      name: label,
      parent: null,
    };
    frames.push(frame);
    g.forEach((idx, k) => {
      const o = items[idx];
      moved.set(o.id, {
        ...o,
        x: cx + PAD / 2 + (k % cols) * CW + (CW - o.w) / 2,
        y: cy + HEAD + Math.floor(k / cols) * CH,
        parent: frame.id,
      });
    });
    cx += w + 40;
    rowH = Math.max(rowH, h);
    inRow++;
  });
  return [...frames, ...objs.map((o) => moved.get(o.id) ?? o)];
}

/** Умные действия на доске: поиск по объектам, раскладка стикеров по смыслу, подбор заметок. */
export function SmartPanel({ file, objs, sel, onFocus, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SemHit[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<SemHit[]>([]);

  const stickies = useMemo(() => objs.filter((o) => o.type === "sticky" && objText(o)), [objs]);
  const selStickies = stickies.filter((o) => sel.includes(o.id));
  const selOne = objs.find((o) => o.id === sel[0]);

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
          title: "эта доска",
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

  const arrange = async () => {
    const pool = selStickies.length > 1 ? selStickies : stickies.filter((o) => !o.parent);
    if (pool.length < 2) {
      setMsg("Нужно хотя бы два стикера с текстом");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const groups = await api.semGroup(
        pool.map((o) => objText(o)),
        0.7,
      );
      const ids = pool.map((o) => o.id);
      onApply((all) => layoutByGroups(all, ids, groups));
      setMsg(`Готово: ${groups.filter((g) => g.length > 1).length} тем`);
    } catch (e) {
      setMsg(
        (e as Error).message.includes("model")
          ? "Установите модель во вкладке «Похожее»"
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
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
        title="Умные действия: поиск, раскладка по смыслу, заметки"
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
            <b>Умные действия</b>
            <X size={14} style={{ cursor: "pointer" }} onClick={() => setOpen(false)} />
          </div>
          <label style={{ ...btn, width: "100%", cursor: "text" }}>
            <Search size={13} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Найти объект по смыслу…"
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

          <div style={{ marginTop: 10 }}>
            <button type="button" style={btn} disabled={busy} onClick={() => void arrange()}>
              <LayoutGrid size={13} />
              {busy
                ? "Раскладываю…"
                : selStickies.length > 1
                  ? "Разложить выделенные стикеры по темам"
                  : "Разложить стикеры по темам"}
            </button>
            {msg && <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>{msg}</div>}
          </div>

          {notes.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>
                <FileText size={12} /> Заметки по теме выделенного
              </div>
              {notes.map((h) => (
                <div
                  key={h.ref}
                  title="Добавить карточку заметки рядом"
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
    </>
  );
}
