import { useEffect, useRef } from "react";
import type { BaseCx, Item, Params } from "@/pages/word/ribbon/types";

const STANDARD = [
  "C00000",
  "FF0000",
  "FFC000",
  "FFFF00",
  "92D050",
  "00B050",
  "00B0F0",
  "0070C0",
  "002060",
  "7030A0",
];

/** Последний выбранный цвет по ключу (кнопка «цвет шрифта» применяет его снова). */
const LAST: Record<string, string> = {};
export const lastColor = (key: string, fallback: string): string => LAST[key] ?? fallback;

function mix(hex: string, to: number, amount: number): string {
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(c + (to - c) * amount)
      .toString(16)
      .padStart(2, "0"),
  );
  return ch.join("").toUpperCase();
}

/** Колонка оттенков темы, как в Word: основной цвет, затем светлее на 80/60/40 % и темнее на 25/50 %. */
function shades(hex: string, dark: boolean): string[] {
  if (dark)
    return [
      hex,
      mix(hex, 255, 0.5),
      mix(hex, 255, 0.35),
      mix(hex, 255, 0.2),
      mix(hex, 0, 0.1),
      mix(hex, 0, 0.25),
    ].slice(0, 6);
  return [
    hex,
    mix(hex, 255, 0.8),
    mix(hex, 255, 0.6),
    mix(hex, 255, 0.4),
    mix(hex, 0, 0.25),
    mix(hex, 0, 0.5),
  ];
}

function Swatch({
  hex,
  title,
  onPick,
}: {
  hex: string;
  title: string;
  onPick: (hex: string) => void;
}) {
  return (
    <button
      type="button"
      className="wd-sw"
      style={{ background: `#${hex}` }}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(hex)}
    />
  );
}

function Palette({ cx, pick }: { cx: BaseCx; pick: (hex: string) => void }) {
  const theme = cx.themeColors;
  // Порядок Word: светлый 1, тёмный 1, светлый 2, тёмный 2, акценты 1–6.
  const top =
    theme.length >= 10 ? [theme[1], theme[0], theme[3], theme[2], ...theme.slice(4, 10)] : [];
  return (
    <div className="wd-pal">
      <div className="wd-m-head">{cx.tw("Theme Colors")}</div>
      <div className="wd-pal-grid">
        {top.map((c, i) => (
          <div key={i} className="wd-pal-col">
            {shades(c, i === 0).map((s, j) => (
              <Swatch key={j} hex={s} title={`#${s}`} onPick={pick} />
            ))}
          </div>
        ))}
      </div>
      <div className="wd-m-head">{cx.tw("Standard Colors")}</div>
      <div className="wd-pal-row">
        {STANDARD.map((c) => (
          <Swatch key={c} hex={c} title={`#${c}`} onPick={pick} />
        ))}
      </div>
    </div>
  );
}

function Custom({ cx, pick, close }: { cx: BaseCx; pick: (hex: string) => void; close: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  // Системный выбор цвета шлёт «input» на каждый сдвиг; применяем только итог («change»).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = (): void => {
      pick(el.value.slice(1).toUpperCase());
      close();
    };
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, [pick, close]);
  return (
    <button
      type="button"
      className="wd-m-item"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => ref.current?.click()}
    >
      <span className="wd-m-mark" />
      <span className="wd-m-label">{cx.tw("More Colors…")}</span>
      <input ref={ref} type="color" className="wd-hidden-input" tabIndex={-1} />
    </button>
  );
}

/**
 * Пункты меню выбора цвета: «Авто», палитра темы документа, стандартные цвета, «Другие цвета…».
 * `key` — имя параметра команды (`color` у шрифта, `fill` у WordArt…), `memo` — ключ запоминания последнего цвета.
 */
export function colorMenu<C extends BaseCx = import("@/pages/word/ribbon/types").Cx>(
  cmd: string,
  o: {
    key?: string;
    auto?: string;
    none?: string;
    extra?: Params;
    memo?: string;
    noneValue?: unknown;
  } = {},
): Item<C>[] {
  const key = o.key ?? "color";
  const apply = (cx: C, v: unknown): void => cx.run(cmd, { ...o.extra, [key]: v });
  const items: Item<C>[] = [];
  if (o.auto) items.push({ label: o.auto, act: { fn: (cx) => apply(cx, "auto") } });
  if (o.none) items.push({ label: o.none, act: { fn: (cx) => apply(cx, o.noneValue ?? null) } });
  items.push({
    render: (cx, close) => {
      const pick = (hex: string): void => {
        if (o.memo) LAST[o.memo] = hex;
        apply(cx, hex);
        close();
      };
      return <Palette cx={cx} pick={pick} />;
    },
  });
  items.push({ sep: true });
  items.push({
    render: (cx, close) => (
      <Custom
        cx={cx}
        close={close}
        pick={(hex) => {
          if (o.memo) LAST[o.memo] = hex;
          apply(cx, hex);
        }}
      />
    ),
  });
  return items;
}
