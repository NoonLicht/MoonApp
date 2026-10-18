import type { CSSProperties, ReactNode } from "react";
import type { Item } from "@/pages/word/ribbon/types";
import type { SheetCx } from "@/pages/sheet/types";

interface Look {
  css: CSSProperties;
  sample?: string;
}

const box = (c: string): string => `1px solid ${c}`;

/** Вид плитки стиля ячейки (как в Excel по умолчанию). */
const LOOKS: Record<string, Look> = {
  Normal: { css: { background: "#fff", color: "#000" } },
  Bad: { css: { background: "#FFC7CE", color: "#9C0006" } },
  Good: { css: { background: "#C6EFCE", color: "#006100" } },
  Neutral: { css: { background: "#FFEB9C", color: "#9C5700" } },
  Calculation: { css: { background: "#F2F2F2", color: "#FA7D00", fontWeight: 700, border: box("#7F7F7F") } },
  "Check Cell": { css: { background: "#A5A5A5", color: "#fff", fontWeight: 700, border: "2px solid #3F3F3F" } },
  "Explanatory Text": { css: { background: "#fff", color: "#7F7F7F", fontStyle: "italic" } },
  Input: { css: { background: "#FFCC99", color: "#3F3F76", border: box("#7F7F7F") } },
  "Linked Cell": { css: { background: "#fff", color: "#FA7D00", borderBottom: "2px solid #FF8001" } },
  Note: { css: { background: "#FFFFCC", color: "#000", border: box("#B2B2B2") } },
  Output: { css: { background: "#F2F2F2", color: "#3F3F3F", fontWeight: 700, border: box("#3F3F3F") } },
  "Warning Text": { css: { background: "#fff", color: "#FF0000" } },
  "Heading 1": { css: { background: "#fff", color: "#44546A", fontWeight: 700, fontSize: 15, borderBottom: "3px solid #4472C4" } },
  "Heading 2": { css: { background: "#fff", color: "#44546A", fontWeight: 700, fontSize: 13, borderBottom: "3px solid #ACB9CA" } },
  "Heading 3": { css: { background: "#fff", color: "#44546A", fontWeight: 700, borderBottom: "2px solid #8EA9DB" } },
  "Heading 4": { css: { background: "#fff", color: "#44546A", fontWeight: 700 } },
  Title: { css: { background: "#fff", color: "#44546A", fontWeight: 700, fontSize: 17 } },
  Total: { css: { background: "#fff", color: "#000", fontWeight: 700, borderTop: "1px solid #4472C4", borderBottom: "3px double #4472C4" } },
  Comma: { css: { background: "#fff", color: "#000" }, sample: "1 234,00" },
  "Comma [0]": { css: { background: "#fff", color: "#000" }, sample: "1 234" },
  Currency: { css: { background: "#fff", color: "#000" }, sample: "$1,234.00" },
  "Currency [0]": { css: { background: "#fff", color: "#000" }, sample: "$1,234" },
  Percent: { css: { background: "#fff", color: "#000" }, sample: "12%" },
};
const ACC = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47"];
const PALE = ["#B4C6E7", "#F8CBAD", "#DBDBDB", "#FFE699", "#BDD7EE", "#C6E0B4"];
const MID = ["#8EA9DB", "#F4B084", "#C9C9C9", "#FFD966", "#9BC2E6", "#A9D08E"];
ACC.forEach((c, i) => {
  LOOKS[`Accent${i + 1}`] = { css: { background: c, color: "#fff" } };
  LOOKS[`20% - Accent${i + 1}`] = { css: { background: PALE[i], color: "#000" } };
  LOOKS[`40% - Accent${i + 1}`] = { css: { background: MID[i], color: "#000" } };
});

export const CELL_STYLE_GROUPS: [string, string[]][] = [
  ["Good, Bad and Neutral", ["Normal", "Bad", "Good", "Neutral"]],
  ["Data and Model", ["Calculation", "Check Cell", "Explanatory Text", "Input", "Linked Cell", "Note", "Output", "Warning Text"]],
  ["Titles and Headings", ["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Title", "Total"]],
  ["Themed Cell Styles", [...ACC.map((_, i) => `20% - Accent${i + 1}`), ...ACC.map((_, i) => `40% - Accent${i + 1}`), ...ACC.map((_, i) => `Accent${i + 1}`)]],
  ["Number Format", ["Comma", "Comma [0]", "Currency", "Currency [0]", "Percent"]],
];

/** Галерея стилей ячеек: плитки с образцом оформления и названием. */
function Gallery({ cx, close }: { cx: SheetCx; close: () => void }): ReactNode {
  return (
    <div className="sh-csg">
      {CELL_STYLE_GROUPS.map(([h, names]) => (
        <div key={h}>
          <div className="sh-tsg-head">{cx.tw(h)}</div>
          <div className="sh-csg-grid">
            {names.map((n) => {
              const look = LOOKS[n] ?? LOOKS.Normal;
              return (
                <button
                  key={n}
                  type="button"
                  className="sh-csg-tile"
                  title={cx.tw(n)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    cx.run("home.cellStyle", { name: n });
                    close();
                  }}
                >
                  <span className="sh-csg-sample" style={look.css}>
                    {look.sample ?? cx.tw(n)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export const cellStyleGallery: Item<SheetCx> = { render: (cx, close) => <Gallery cx={cx} close={close} /> };
