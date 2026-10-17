import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { ChevronDown } from "lucide-react";
import Combo from "@/pages/word/ribbon/Combo";
import { MenuPopup } from "@/pages/word/ribbon/Menu";
import { lenUnit, ptToUnit, unitToPt } from "@/pages/word/lib";
import type { Cx, Item } from "@/pages/word/ribbon/types";

/** Событие «стили документа изменились» — галереи перечитывают список. */
export const STYLES_CHANGED = "wd-styles-changed";

const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** Числовое поле в единицах интерфейса: применяется по Enter и при уходе из поля. */
export function NumField({
  value,
  onCommit,
  width = 58,
  label,
  step = 0.1,
  min,
  max,
  suffix,
  disabled,
}: {
  value: number;
  onCommit: (v: number) => void;
  width?: number;
  label: string;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(String(value));
  }, [value, focus]);
  const commit = (): void => {
    const n = parseFloat(text.replace(",", "."));
    if (Number.isFinite(n)) {
      const v = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
      if (v !== value) onCommit(v);
      setText(String(v));
    } else setText(String(value));
  };
  return (
    <span className="wd-num2" style={{ width }}>
      <input
        value={text}
        aria-label={label}
        title={label}
        disabled={disabled}
        inputMode="decimal"
        onFocus={(e) => {
          setFocus(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocus(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const n = parseFloat(text.replace(",", ".")) || 0;
            const v = Math.round((n + (e.key === "ArrowUp" ? step : -step)) * 100) / 100;
            const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
            setText(String(c));
            onCommit(c);
          }
        }}
      />
      {suffix ? <i>{suffix}</i> : null}
    </span>
  );
}

function FontName({ cx }: { cx: Cx }) {
  const cur = String(cx.s.format.font ?? "");
  const fonts = cx.ui.fonts.length ? cx.ui.fonts : [cur].filter(Boolean);
  return (
    <Combo
      value={cur}
      options={fonts}
      width={140}
      label={cx.tw("Font")}
      optionStyle={(o) => ({ fontFamily: `"${o}", sans-serif` })}
      onCommit={(v) => cx.run("format.font", { name: v })}
    />
  );
}

function FontSize({ cx }: { cx: Cx }) {
  const cur = cx.s.format.size;
  return (
    <Combo
      value={cur ? String(cur) : ""}
      options={SIZES.map(String)}
      width={54}
      label={cx.tw("Font Size")}
      onCommit={(v) => {
        const n = parseFloat(v.replace(",", "."));
        if (Number.isFinite(n) && n > 0) cx.run("format.size", { size: n });
      }}
    />
  );
}

interface StyleInfo {
  id: string;
  name: string;
  type: string;
  builtIn: boolean;
  hidden: boolean;
  inGallery: boolean;
  priority: number;
  format: {
    font?: string;
    size?: number;
    color?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    caps?: boolean;
    spaceAfter?: number;
  };
}

/** Список стилей документа; перечитывается при смене документа, темы и после правок стилей. */
export function useStyles(cx: Cx): StyleInfo[] {
  const [list, setList] = useState<StyleInfo[]>([]);
  const [tick, setTick] = useState(0);
  const { docId, call } = { docId: cx.docId, call: cx.call };
  const { themeName, majorFont, minorFont } = cx.s.settings;
  useEffect(() => {
    const on = (): void => setTick((n) => n + 1);
    window.addEventListener(STYLES_CHANGED, on);
    return () => window.removeEventListener(STYLES_CHANGED, on);
  }, []);
  useEffect(() => {
    let alive = true;
    void call("styles.manage", {}).then((r) => {
      if (alive && Array.isArray(r)) setList(r as StyleInfo[]);
    });
    return () => {
      alive = false;
    };
    // call — стабильная обёртка страницы; перечитываем по смене документа/темы/событию
  }, [docId, themeName, majorFont, minorFont, tick, call]);
  return list;
}

function StyleTile({
  st,
  cur,
  cx,
  onPick,
}: {
  st: StyleInfo;
  cur: boolean;
  cx: Cx;
  onPick: () => void;
}) {
  const f = st.format;
  const size = Math.max(10, Math.min(f.size ?? 12, 20));
  return (
    <button
      type="button"
      className={`wd-style-tile${cur ? " on" : ""}`}
      title={st.name}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span
        className="wd-style-sample"
        style={{
          fontFamily: f.font ? `"${f.font}", sans-serif` : undefined,
          fontSize: size,
          color: f.color ? `#${f.color}` : undefined,
          fontWeight: f.bold ? 700 : undefined,
          fontStyle: f.italic ? "italic" : undefined,
          textDecoration: f.underline ? "underline" : undefined,
          textTransform: f.caps ? "uppercase" : undefined,
        }}
      >
        {cx.lang === "ru" ? "АаБбВв" : "AaBbCc"}
      </span>
      <span className="wd-style-name">{cx.tw(st.name)}</span>
    </button>
  );
}

function StyleGallery({ cx }: { cx: Cx }) {
  const styles = useStyles(cx);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gallery = styles
    .filter(
      (s) =>
        s.inGallery &&
        !s.hidden &&
        (s.type === "paragraph" || s.type === "linked" || s.type === "character"),
    )
    .sort((a, b) => a.priority - b.priority);
  const curPara = cx.s.paraResolved?.style ?? "";
  const curChar = String(cx.s.format.style ?? "");
  const apply = (s: StyleInfo): void =>
    s.type === "character"
      ? cx.run("format.charStyle", { style: s.id })
      : cx.run("para.style", { style: s.id });
  const all: Item[] = [
    {
      render: (c, close) => (
        <div className="wd-style-all">
          {styles
            .filter((s) => !s.hidden && s.type !== "table" && s.type !== "numbering")
            .sort((a, b) => a.priority - b.priority)
            .map((s) => (
              <StyleTile
                key={s.id}
                st={s}
                cx={c}
                cur={s.id === curPara || s.id === curChar}
                onPick={() => {
                  apply(s);
                  close();
                }}
              />
            ))}
        </div>
      ),
    },
    { sep: true },
    { label: "Create a Style", act: { fn: (c) => c.dialog("createStyle") } },
    { label: "Clear All Formatting", act: { cmd: "format.clear" } },
    { label: "Apply Styles…", act: { fn: (c) => c.ui.togglePane("styles", true) } },
  ];
  return (
    <div className="wd-style-gal">
      <div className="wd-style-strip" ref={box}>
        {gallery.map((s) => (
          <StyleTile
            key={s.id}
            st={s}
            cx={cx}
            cur={s.id === curPara || s.id === curChar}
            onPick={() => apply(s)}
          />
        ))}
      </div>
      <div className="wd-style-btns">
        <button
          type="button"
          className="wd-ctl wd-arrow-v"
          aria-label={cx.tw("Styles")}
          title={cx.tw("Styles")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {anchor ? (
        <MenuPopup items={all} cx={cx} anchor={anchor} onClose={() => setAnchor(null)} />
      ) : null}
    </div>
  );
}

function CellSize({ cx }: { cx: Cx }) {
  const t = cx.s.ctx.table;
  const u = lenUnit(cx.lang);
  if (!t) return null;
  return (
    <div className="wd-fields">
      <label>
        <span>{cx.tw("Height:")}</span>
        <NumField
          value={ptToUnit(t.height, u)}
          step={0.1}
          min={0.02}
          label={cx.tw("Table Row Height")}
          suffix={u.name}
          onCommit={(v) =>
            cx.run("table.rowHeight", {
              height: unitToPt(v, u),
              rule: t.heightExact ? "exact" : "atLeast",
            })
          }
        />
      </label>
      <label>
        <span>{cx.tw("Width:")}</span>
        <NumField
          value={ptToUnit(t.width, u)}
          step={0.1}
          min={0.02}
          label={cx.tw("Table Column Width")}
          suffix={u.name}
          onCommit={(v) => cx.run("table.columnWidth", { width: unitToPt(v, u) })}
        />
      </label>
    </div>
  );
}

function ObjSize({ cx }: { cx: Cx }) {
  const o = cx.s.ctx.object;
  const u = lenUnit(cx.lang);
  if (!o) return null;
  const lock = o.kind === "picture";
  const size = (k: "width" | "height", v: number): void =>
    cx.run(
      "picture.size",
      lock ? { [k]: unitToPt(v, u) } : { [k]: unitToPt(v, u), lockAspect: false },
    );
  return (
    <div className="wd-fields">
      <label>
        <span>{cx.tw("H:")}</span>
        <NumField
          value={ptToUnit(o.h, u)}
          min={0.1}
          label={cx.tw("Height:")}
          suffix={u.name}
          onCommit={(v) => size("height", v)}
        />
      </label>
      <label>
        <span>{cx.tw("W:")}</span>
        <NumField
          value={ptToUnit(o.w, u)}
          min={0.1}
          label={cx.tw("Width:")}
          suffix={u.name}
          onCommit={(v) => size("width", v)}
        />
      </label>
      <label>
        <span>{cx.tw("Rotation:")}</span>
        <NumField
          value={Math.round(o.deg * 10) / 10}
          step={1}
          min={-360}
          max={360}
          label={cx.tw("Rotation:")}
          suffix="°"
          onCommit={(v) => cx.run("arrange.rotation", { degrees: v })}
        />
      </label>
    </div>
  );
}

function ParaFields({ cx }: { cx: Cx }) {
  const p = cx.s.paraResolved;
  const u = lenUnit(cx.lang);
  if (!p) return null;
  return (
    <div className="wd-fields wd-fields2">
      <b>{cx.tw("Indent")}</b>
      <b>{cx.tw("Spacing")}</b>
      <label>
        <span>{cx.tw("Left:")}</span>
        <NumField
          value={ptToUnit(p.indentLeft, u)}
          min={-30}
          label={cx.tw("Left:")}
          suffix={u.name}
          onCommit={(v) => cx.run("para.indents", { left: unitToPt(v, u) })}
        />
      </label>
      <label>
        <span>{cx.tw("Before:")}</span>
        <NumField
          value={p.spaceBefore}
          step={1}
          min={0}
          max={1584}
          label={cx.tw("Before:")}
          suffix={cx.tw("pt")}
          onCommit={(v) => cx.run("para.spacing", { before: v })}
        />
      </label>
      <label>
        <span>{cx.tw("Right:")}</span>
        <NumField
          value={ptToUnit(p.indentRight, u)}
          min={-30}
          label={cx.tw("Right:")}
          suffix={u.name}
          onCommit={(v) => cx.run("para.indents", { right: unitToPt(v, u) })}
        />
      </label>
      <label>
        <span>{cx.tw("After:")}</span>
        <NumField
          value={p.spaceAfter}
          step={1}
          min={0}
          max={1584}
          label={cx.tw("After:")}
          suffix={cx.tw("pt")}
          onCommit={(v) => cx.run("para.spacing", { after: v })}
        />
      </label>
    </div>
  );
}

const LOOK: [string, keyof NonNullable<Cx["s"]["ctx"]["table"]>["look"]][] = [
  ["Header Row", "headerRow"],
  ["First Column", "firstColumn"],
  ["Total Row", "totalRow"],
  ["Last Column", "lastColumn"],
  ["Banded Rows", "bandedRows"],
  ["Banded Columns", "bandedColumns"],
];

function TableLook({ cx }: { cx: Cx }) {
  const t = cx.s.ctx.table;
  if (!t) return null;
  return (
    <div className="wd-look">
      {LOOK.map(([label, key]) => (
        <label key={key} className="wd-check">
          <input
            type="checkbox"
            checked={t.look[key]}
            onChange={(e) => cx.run("table.look", { [key]: e.target.checked })}
          />
          <span>{cx.tw(label)}</span>
        </label>
      ))}
    </div>
  );
}

interface StyleRow {
  id: string;
  name: string;
  kind: string;
}

/** Стили таблиц: плитки с миниатюрой и названием, остальные — в выпадающем списке. */
function TableStyles({ cx }: { cx: Cx }) {
  const [list, setList] = useState<StyleRow[]>([]);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const cur = cx.s.ctx.table?.style ?? "";
  useEffect(() => {
    let alive = true;
    void cx.call("styles.list", {}).then((r) => {
      if (alive && Array.isArray(r)) setList((r as StyleRow[]).filter((s) => s.kind === "table"));
    });
    return () => {
      alive = false;
    };
  }, [cx.docId, cx.call]);
  const tile = (s: StyleRow, close?: () => void): JSX.Element => (
    <button
      key={s.id}
      type="button"
      className={`wd-tstyle${s.id === cur ? " on" : ""}`}
      title={cx.tw(s.name)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        cx.run("table.style", { style: s.id });
        close?.();
      }}
    >
      <svg viewBox="0 0 30 20" width="34" height="23" aria-hidden>
        <rect
          x="0.5"
          y="0.5"
          width="29"
          height="19"
          fill="none"
          stroke="currentColor"
          opacity=".7"
        />
        <rect x="0.5" y="0.5" width="29" height="5" fill="currentColor" opacity=".35" />
        <path
          d="M0 10.5H30M0 15.5H30M10 0V20M20 0V20"
          stroke="currentColor"
          opacity=".5"
          fill="none"
        />
      </svg>
    </button>
  );
  const items: Item[] = [
    {
      render: (_c, close) => <div className="wd-tstyle-all">{list.map((s) => tile(s, close))}</div>,
    },
    { sep: true },
    { label: "New Table Style…", act: { fn: (c) => c.dialog("newTableStyle") } },
    {
      label: "Modify Table Style…",
      enabled: (c) => !!c.s.ctx.table?.style,
      act: { fn: (c) => c.dialog("modifyTableStyle") },
    },
    {
      label: "Delete Table Style",
      enabled: (c) => !!c.s.ctx.table?.style,
      act: { cmd: "table.deleteStyle" },
    },
  ];
  return (
    <div className="wd-tstyles">
      <div className="wd-tstyle-strip">{list.slice(0, 6).map((s) => tile(s))}</div>
      <button
        type="button"
        className="wd-ctl wd-arrow-v"
        aria-label={cx.tw("Table Styles")}
        title={cx.tw("Table Styles")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        <ChevronDown size={14} />
      </button>
      {anchor ? (
        <MenuPopup items={items} cx={cx} anchor={anchor} onClose={() => setAnchor(null)} />
      ) : null}
    </div>
  );
}

const ALIGNS = [
  ["topLeft", "topCenter", "topRight"],
  ["centerLeft", "center", "centerRight"],
  ["bottomLeft", "bottomCenter", "bottomRight"],
];

function AlignGlyph({ h, v }: { h: number; v: number }) {
  const y0 = v === 0 ? 3 : v === 1 ? 7 : 11;
  const widths = [10, 7, 9];
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      {widths.map((w, i) => {
        const x = h === 0 ? 2 : h === 1 ? 8 - w / 2 : 14 - w;
        return (
          <rect key={i} x={x} y={y0 + i * 1.8 - 3} width={w} height="1.1" fill="currentColor" />
        );
      })}
    </svg>
  );
}

function CellAlign({ cx }: { cx: Cx }) {
  return (
    <div className="wd-cellalign">
      {ALIGNS.map((row, v) =>
        row.map((val, h) => (
          <button
            key={val}
            type="button"
            className="wd-ctl wd-small"
            title={cx.tw(
              `Align ${["Top", "Center", "Bottom"][v]} ${["Left", "Center", "Right"][h]}`,
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => cx.run("table.cellAlign", { value: val })}
          >
            <AlignGlyph h={h} v={v} />
          </button>
        )),
      )}
    </div>
  );
}

function OutlineLevel({ cx }: { cx: Cx }) {
  const { tw } = cx;
  const [levels, setLevels] = useState<number[]>([]);
  const [shown, setShown] = useState(0);
  const { call } = cx;
  useEffect(() => {
    let alive = true;
    void call("outline.state", {}).then((r) => {
      const o = r as { levels?: number[]; showLevel?: number } | undefined;
      if (alive && o) {
        setLevels(o.levels ?? []);
        setShown(o.showLevel ?? 0);
      }
    });
    return () => {
      alive = false;
    };
  }, [cx.s.rev, call]);
  const name = (l: number): string => (l >= 10 ? tw("Body Text") : tw("Level {n}", { n: l }));
  const block = cx.s.selection.focus?.path?.[0] ?? 0;
  return (
    <div className="wd-outline-row">
      <Combo
        value={name(levels[block] ?? 10)}
        options={[...Array.from({ length: 9 }, (_, i) => name(i + 1)), name(10)]}
        width={110}
        label={tw("Outline Level")}
        onCommit={(v) => {
          const i = [...Array.from({ length: 9 }, (_, k) => name(k + 1)), name(10)].indexOf(v);
          if (i >= 0) cx.run("outline.level", { level: i >= 9 ? "body" : i + 1 });
        }}
      />
      <span className="wd-lbl3">{tw("Show Level")}</span>
      <Combo
        value={shown === 0 ? tw("All Levels") : name(shown)}
        options={[tw("All Levels"), ...Array.from({ length: 9 }, (_, i) => name(i + 1))]}
        width={110}
        label={tw("Show Level")}
        onCommit={(v) => {
          const opts = [tw("All Levels"), ...Array.from({ length: 9 }, (_, i) => name(i + 1))];
          const i = opts.indexOf(v);
          if (i >= 0) cx.run("outline.showLevel", { level: i === 0 ? "all" : i });
        }}
      />
    </div>
  );
}

function HfPosition({ cx }: { cx: Cx }) {
  const u = lenUnit(cx.lang);
  const [pos, setPos] = useState<{ header: number; footer: number }>({ header: 36, footer: 36 });
  const { call } = cx;
  const load = useCallback(() => {
    void call("layout.section", {}).then((r) => {
      const o = r as { header?: number; footer?: number } | undefined;
      if (o) setPos({ header: o.header ?? 36, footer: o.footer ?? 36 });
    });
  }, [call]);
  useEffect(load, [load, cx.s.rev]);
  return (
    <div className="wd-fields">
      <label>
        <span>{cx.tw("Header from Top:")}</span>
        <NumField
          value={ptToUnit(pos.header, u)}
          min={0}
          width={70}
          label={cx.tw("Header/Footer Position")}
          suffix={u.name}
          onCommit={(v) => cx.run("hf.position", { header: unitToPt(v, u) })}
        />
      </label>
      <label>
        <span>{cx.tw("Footer from Bottom:")}</span>
        <NumField
          value={ptToUnit(pos.footer, u)}
          min={0}
          width={70}
          label={cx.tw("Header/Footer Position")}
          suffix={u.name}
          onCommit={(v) => cx.run("hf.position", { footer: unitToPt(v, u) })}
        />
      </label>
    </div>
  );
}

export const CUSTOM: Record<string, ComponentType<{ cx: Cx }>> = {
  fontName: FontName,
  fontSize: FontSize,
  styleGallery: StyleGallery,
  cellSize: CellSize,
  objSize: ObjSize,
  paraFields: ParaFields,
  tableLook: TableLook,
  tableStyles: TableStyles,
  cellAlign: CellAlign,
  outlineLevel: OutlineLevel,
  hfPosition: HfPosition,
};
