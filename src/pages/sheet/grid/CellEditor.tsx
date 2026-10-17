import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SheetGrid, SheetState } from "@/api/apiSheet";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";
import type { EditApi, EditState } from "@/pages/sheet/edit";
import type { Geo } from "@/pages/sheet/grid/geometry";
import { formulaContext, useFunctions } from "@/pages/sheet/functions";

interface Props {
  edit: EditState;
  api: EditApi;
  geo: Geo;
  grid: SheetGrid | null;
  zoom: number;
  scroll: { x: number; y: number };
  headerW: number;
  headerH: number;
  state: SheetState;
  size: { w: number; h: number };
  docs: SheetDocs;
}

/** Подсказки по функциям под редактором: список по набранному слову и подпись текущей функции. */
export function FormulaHints({
  text,
  caret,
  docs,
  onPick,
  anchor,
  selected,
  setSelected,
}: {
  text: string;
  caret: number;
  docs: SheetDocs;
  onPick: (name: string) => void;
  anchor?: { left: number; top: number };
  selected: number;
  setSelected: (n: number) => void;
}) {
  const fns = useFunctions(docs);
  const ctx = useMemo(() => formulaContext(text, caret), [text, caret]);
  const matches = useMemo(() => {
    if (!text.startsWith("=") || ctx.word.length < 1 || /^[A-Za-z]{1,3}\d+$/.test(ctx.word)) return [];
    const q = ctx.word.toUpperCase();
    return fns.filter((f) => f.name.startsWith(q)).slice(0, 8);
  }, [fns, ctx.word, text]);
  const sig = ctx.fn ? fns.find((f) => f.name === ctx.fn) : undefined;
  const sigParts = sig ? sig.signature.replace(/^[^(]*\(/, "").replace(/\)\s*$/, "").split(/,\s*/) : [];
  if (!matches.length && !sig) return null;
  return (
    <div className="sh-hints" style={anchor}>
      {matches.length ? (
        <ul role="listbox">
          {matches.map((f, i) => (
            <li
              key={f.name}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? "on" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(f.name);
              }}
              onMouseEnter={() => setSelected(i)}
              title={f.description}
            >
              <b>{f.name}</b>
              <span>{f.description.slice(0, 60)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {sig && !matches.length ? (
        <div className="sh-sig">
          <b>{sig.name}</b>(
          {sigParts.map((p, i) => (
            <span key={i} className={i === Math.min(ctx.arg, sigParts.length - 1) ? "cur" : ""}>
              {i ? ", " : ""}
              {p}
            </span>
          ))}
          )
        </div>
      ) : null}
    </div>
  );
}

export default function CellEditor({ edit, api, geo, zoom: Z, scroll, headerW, headerH, state, size, docs, grid }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(edit.text.length);
  const [sel, setSel] = useState(0);
  const merged = grid?.merges.find((m) => edit.r >= m.r0 && edit.r <= m.r1 && edit.c >= m.c0 && edit.c <= m.c1);
  const r0 = merged?.r0 ?? edit.r;
  const c0 = merged?.c0 ?? edit.c;
  const rect = geo.rect(r0, c0, merged?.r1 ?? edit.r, merged?.c1 ?? edit.c);
  const frozenC = c0 < geo.fc;
  const frozenR = r0 < geo.fr;
  const left = headerW + rect.x * Z - (frozenC ? 0 : scroll.x);
  const top = headerH + rect.y * Z - (frozenR ? 0 : scroll.y);
  const f = state.format;
  const fontPx = (f.size * 96) / 72 * Z;
  const lines = edit.text.split("\n");
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  const minW = rect.w * Z;
  const width = Math.min(Math.max(minW, longest.length * fontPx * 0.56 + 26), Math.max(minW, size.w - left - 8));
  const height = Math.max(rect.h * Z, lines.length * fontPx * 1.3 + 4);
  const color = f.color && f.color !== "#000000" ? f.color : "#000";

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el || edit.origin !== "cell") return;
    el.focus({ preventScroll: true });
    const pos = edit.caret ?? el.value.length;
    el.setSelectionRange(pos, pos);
    setCaret(pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.origin, edit.caret, edit.r, edit.c]);

  // Начальный текст мог прийти позже (ядро): держим курсор в конце.
  useEffect(() => {
    api.caret.current = caret;
  }, [api.caret, caret]);

  const ctx = formulaContext(edit.text, caret);
  const fns = useFunctions(docs);
  const matches =
    edit.text.startsWith("=") && ctx.word.length >= 1 && !/^[A-Za-z]{1,3}\d+$/.test(ctx.word)
      ? fns.filter((x) => x.name.startsWith(ctx.word.toUpperCase())).slice(0, 8)
      : [];

  const pick = (name: string): void => {
    const el = ta.current;
    const t = edit.text;
    const next = `${t.slice(0, ctx.wordStart)}${name}(${t.slice(caret)}`;
    api.set(next, ctx.wordStart + name.length + 1);
    void el;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const k = e.key;
    if (matches.length) {
      if (k === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(matches.length - 1, s + 1));
        return;
      }
      if (k === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
        return;
      }
      if (k === "Tab" || (k === "Enter" && !e.altKey && !e.ctrlKey)) {
        e.preventDefault();
        pick(matches[Math.min(sel, matches.length - 1)].name);
        return;
      }
    }
    if (k === "Escape") {
      e.preventDefault();
      api.cancel();
    } else if (k === "Enter") {
      e.preventDefault();
      if (e.altKey) {
        const el = e.currentTarget;
        const s = el.selectionStart;
        api.set(`${edit.text.slice(0, s)}\n${edit.text.slice(el.selectionEnd)}`, s + 1);
      } else if (e.ctrlKey || e.metaKey) void api.commit("none", { fill: !e.shiftKey, array: e.shiftKey });
      else void api.commit(e.shiftKey ? "up" : "down");
    } else if (k === "Tab") {
      e.preventDefault();
      void api.commit(e.shiftKey ? "left" : "right");
    } else if (k === "F2") {
      e.preventDefault();
      api.begin(edit.text, "cell", edit.mode === "enter" ? "edit" : "enter");
    } else if (edit.mode === "enter" && (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight")) {
      // В режиме ввода стрелка завершает его и двигает выделение (в формуле после оператора — указывает ячейку).
      const afterOp = /[=(,+\-*/^&<>:;]$/.test(edit.text.slice(0, caret));
      if (edit.text.startsWith("=") && afterOp) return;
      e.preventDefault();
      void api.commit(k === "ArrowUp" ? "up" : k === "ArrowDown" ? "down" : k === "ArrowLeft" ? "left" : "right");
    } else if (k === "F4" && edit.text.startsWith("=")) {
      e.preventDefault();
      api.set(cycleAbsolute(edit.text, caret), caret);
    }
  };

  const hintAnchor = { left: Math.min(left, Math.max(0, size.w - 340)), top: top + height + 2 };
  return (
    <>
      <textarea
        ref={ta}
        className="sh-editor"
        value={edit.text}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          left,
          top,
          width,
          height,
          fontSize: fontPx,
          fontFamily: `"${f.font}", Calibri, Carlito, "Segoe UI", Arial, sans-serif`,
          fontWeight: f.bold ? 700 : 400,
          fontStyle: f.italic ? "italic" : "normal",
          color,
          textAlign: f.h === "Right" ? "right" : f.h === "Center" ? "center" : "left",
        }}
        onChange={(e) => {
          api.set(e.target.value, e.target.selectionStart);
          setCaret(e.target.selectionStart);
          setSel(0);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
      />
      <FormulaHints
        text={edit.text}
        caret={caret}
        docs={docs}
        onPick={pick}
        anchor={hintAnchor}
        selected={sel}
        setSelected={setSel}
      />
    </>
  );
}

/** F4: переключение ссылки под курсором между A1, $A$1, A$1, $A1. */
export function cycleAbsolute(text: string, caret: number): string {
  const re = /\$?[A-Za-z]{1,3}\$?\d{1,7}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (caret >= m.index && caret <= m.index + m[0].length) {
      const mm = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(m[0]);
      if (!mm) break;
      const [, dc, col, dr, row] = mm;
      const next = !dc && !dr ? `$${col}$${row}` : dc && dr ? `${col}$${row}` : !dc && dr ? `$${col}${row}` : `${col}${row}`;
      return text.slice(0, m.index) + next + text.slice(m.index + m[0].length);
    }
  }
  return text;
}
