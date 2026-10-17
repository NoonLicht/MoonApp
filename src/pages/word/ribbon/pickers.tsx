import { useState } from "react";
import type { Cx } from "@/pages/word/ribbon/types";

/** Сетка выбора размера таблицы (как в «Вставка → Таблица»): наведение подсвечивает, клик вставляет. */
export function TableGrid({ cx, close }: { cx: Cx; close: () => void }) {
  const [hov, setHov] = useState<[number, number]>([0, 0]);
  const R = 8;
  const C = 10;
  return (
    <div className="wd-tgrid-wrap">
      <div className="wd-tgrid-title">
        {hov[0] ? `${hov[1]} × ${hov[0]} ${cx.tw("Table")}` : cx.tw("Insert Table")}
      </div>
      <div className="wd-tgrid" onMouseLeave={() => setHov([0, 0])}>
        {Array.from({ length: R * C }, (_, i) => {
          const r = Math.floor(i / C) + 1;
          const c = (i % C) + 1;
          return (
            <button
              key={i}
              type="button"
              className={`wd-tcell${r <= hov[0] && c <= hov[1] ? " on" : ""}`}
              aria-label={`${r} × ${c}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHov([r, c])}
              onClick={() => {
                cx.run("insert.table", { rows: r, cols: c });
                close();
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

const HIGHLIGHTS: [string, string][] = [
  ["yellow", "FFFF00"],
  ["brightGreen", "00FF00"],
  ["turquoise", "00FFFF"],
  ["pink", "FF00FF"],
  ["blue", "0000FF"],
  ["red", "FF0000"],
  ["darkBlue", "000080"],
  ["teal", "008080"],
  ["green", "008000"],
  ["violet", "800080"],
  ["darkRed", "800000"],
  ["darkYellow", "808000"],
  ["gray50", "808080"],
  ["gray25", "C0C0C0"],
  ["black", "000000"],
];

export const highlightHex = (name: string): string =>
  HIGHLIGHTS.find(([n]) => n === name)?.[1] ?? "FFFF00";

/** Цвета выделения текста: ядро принимает названия, а не RGB. */
export function HighlightGrid({
  cx,
  close,
  onPick,
}: {
  cx: Cx;
  close: () => void;
  onPick: (name: string) => void;
}) {
  return (
    <div className="wd-pal">
      <div className="wd-pal-row wd-pal-hl">
        {HIGHLIGHTS.map(([name, hex]) => (
          <button
            key={name}
            type="button"
            className="wd-sw"
            style={{ background: `#${hex}` }}
            title={name}
            aria-label={name}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onPick(name);
              cx.run("format.highlight", { color: name });
              close();
            }}
          />
        ))}
      </div>
    </div>
  );
}

const SYMBOLS = [
  "©",
  "®",
  "™",
  "§",
  "¶",
  "€",
  "£",
  "¥",
  "°",
  "±",
  "≠",
  "≤",
  "≥",
  "÷",
  "×",
  "∞",
  "µ",
  "α",
  "β",
  "π",
  "Ω",
  "∑",
  "√",
  "→",
  "←",
  "✓",
  "★",
  "♥",
  "—",
  "…",
];

/** Быстрый выбор частых символов. */
export function SymbolGrid({ cx, close }: { cx: Cx; close: () => void }) {
  return (
    <div className="wd-symgrid">
      {SYMBOLS.map((c) => (
        <button
          key={c}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            cx.run("insert.symbol", { char: c });
            close();
          }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
