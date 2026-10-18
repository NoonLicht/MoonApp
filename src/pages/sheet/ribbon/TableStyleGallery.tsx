import type { ReactNode } from "react";
import type { Item } from "@/pages/word/ribbon/types";
import type { SheetCx } from "@/pages/sheet/types";

const ACCENT = ["#595959", "#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47"];
const GROUPS: [string, string, number][] = [
  ["Light", "TableStyleLight", 21],
  ["Medium", "TableStyleMedium", 28],
  ["Dark", "TableStyleDark", 11],
];

/** Миниатюра встроенного стиля таблицы Excel: вид выводится из группы, номера и акцента. */
function Thumb({ prefix, n }: { prefix: string; n: number }) {
  const acc = ACCENT[(n - 1) % 7];
  const kind = Math.floor((n - 1) / 7);
  const rows = [5, 9.5, 14, 18.5];
  const band = (i: number): boolean => i % 2 === 0;
  let head: string | null = null;
  let headLine = false;
  let bandFill = acc;
  let bandOpacity = 0.18;
  let grid = false;
  let frame = false;
  let bodyDark = false;
  if (prefix === "TableStyleLight") {
    if (kind === 0) {
      headLine = true;
      bandOpacity = 0.15;
    } else if (kind === 1) {
      head = acc;
      frame = true;
      bandOpacity = 0.12;
    } else {
      grid = true;
      head = acc;
      bandOpacity = 0.1;
    }
  } else if (prefix === "TableStyleMedium") {
    if (kind === 0) {
      head = acc;
      bandOpacity = 0.28;
    } else if (kind === 1) {
      headLine = true;
      bandOpacity = 0.3;
      frame = true;
    } else if (kind === 2) {
      head = acc;
      grid = true;
      bandOpacity = 0.22;
    } else {
      head = "#262626";
      bandOpacity = 0.4;
    }
  } else {
    head = "#1f1f1f";
    bodyDark = true;
    bandFill = n > 1 ? ACCENT[(n - 1) % 7] : "#7f7f7f";
    bandOpacity = 0.55;
  }
  return (
    <svg viewBox="0 0 40 24" width="48" height="29" aria-hidden>
      <rect width="40" height="24" fill={bodyDark ? "#3a3a3a" : "#fff"} />
      {head ? <rect width="40" height="5.5" fill={head} /> : null}
      {rows.slice(1).map((y, i) =>
        band(i) ? <rect key={y} y={y - 2.2} width="40" height="4.5" fill={bandFill} opacity={bandOpacity} /> : null,
      )}
      {headLine ? <path d="M0 5.6H40" stroke={acc} strokeWidth="1" /> : null}
      {grid ? <path d={`M0 10H40M0 14.5H40M0 19H40M13 0V24M26 0V24`} stroke={head === acc ? "#fff" : acc} strokeWidth=".6" opacity=".8" /> : null}
      {frame ? <rect x=".5" y=".5" width="39" height="23" fill="none" stroke={acc} strokeWidth="1" /> : null}
      {/* текст-заглушки */}
      {rows.map((y, i) => (
        <g key={y} opacity={i === 0 && head ? 0.9 : 0.5}>
          {[4, 17, 30].map((x) => (
            <rect key={x} x={x} y={y - 1.1} width="7" height="1.8" rx=".6" fill={i === 0 && head ? "#fff" : bodyDark ? "#ddd" : "#555"} />
          ))}
        </g>
      ))}
    </svg>
  );
}

/** Галерея стилей таблицы: плитки с миниатюрами по группам; `pick` получает идентификатор стиля. */
export default function TableStyleGallery({
  cx,
  current,
  pick,
  close,
}: {
  cx: SheetCx;
  current?: string;
  pick: (style: string) => void;
  close: () => void;
}): ReactNode {
  return (
    <div className="sh-tsg">
      {GROUPS.map(([label, prefix, count]) => (
        <div key={prefix}>
          <div className="sh-tsg-head">{cx.tw(label)}</div>
          <div className="sh-tsg-grid">
            {Array.from({ length: count }, (_, i) => {
              const id = `${prefix}${i + 1}`;
              return (
                <button
                  key={id}
                  type="button"
                  className={`sh-tsg-tile${id === current ? " on" : ""}`}
                  title={id}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    pick(id);
                    close();
                  }}
                >
                  <Thumb prefix={prefix} n={i + 1} />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Пункт меню с галереей: `current` — идентификатор выбранного стиля. */
export function galleryItem(pick: (cx: SheetCx, style: string) => void, current?: (cx: SheetCx) => string | undefined): Item<SheetCx> {
  return {
    render: (cx, close) => <TableStyleGallery cx={cx} current={current?.(cx)} pick={(st) => pick(cx, st)} close={close} />,
  };
}
