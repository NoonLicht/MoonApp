import Combo from "@/pages/word/ribbon/Combo";
import type { CustomMap } from "@/pages/word/ribbon/controls";
import type { SheetCx } from "@/pages/sheet/types";

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** Шрифты, которые предлагаем всегда (системный список браузер не отдаёт без разрешения). */
export const FONTS = [
  "Calibri",
  "Aptos",
  "Arial",
  "Arial Narrow",
  "Bahnschrift",
  "Cambria",
  "Candara",
  "Comic Sans MS",
  "Consolas",
  "Constantia",
  "Corbel",
  "Courier New",
  "Franklin Gothic Medium",
  "Garamond",
  "Georgia",
  "Impact",
  "Lucida Console",
  "Palatino Linotype",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

function FontName({ cx }: { cx: SheetCx }) {
  const cur = cx.s.format.font;
  const fonts = [...new Set([cur, ...(cx.ui.fonts.length ? cx.ui.fonts : FONTS)].filter(Boolean))];
  return (
    <Combo
      value={cur}
      options={fonts}
      width={140}
      label={cx.tw("Font")}
      optionStyle={(o) => ({ fontFamily: `"${o}", sans-serif` })}
      onCommit={(v) => {
        cx.run("home.fontName", { name: v });
        cx.ui.focusGrid();
      }}
    />
  );
}

function FontSize({ cx }: { cx: SheetCx }) {
  const cur = cx.s.format.size;
  return (
    <Combo
      value={cur ? String(cur) : ""}
      options={SIZES.map(String)}
      width={54}
      label={cx.tw("Font Size")}
      onCommit={(v) => {
        const n = parseFloat(v.replace(",", "."));
        if (Number.isFinite(n) && n > 0) cx.run("home.fontSize", { size: n });
        cx.ui.focusGrid();
      }}
    />
  );
}

export const NUMBER_FORMATS: [string, string][] = [
  ["General", "General"],
  ["Number", "0.00"],
  ["Currency", "$#,##0.00"],
  ["Accounting", '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'],
  ["Short Date", "m/d/yyyy"],
  ["Long Date", "dddd, mmmm d, yyyy"],
  ["Time", "h:mm:ss AM/PM"],
  ["Percentage", "0.00%"],
  ["Fraction", "# ?/?"],
  ["Scientific", "0.00E+00"],
  ["Text", "@"],
];

/** Название формата по его коду (то, что показывает выпадающий список на ленте). */
export function formatName(code: string): string {
  const hit = NUMBER_FORMATS.find(([, c]) => c === code);
  if (hit) return hit[0];
  if (/^0(\.0+)?$/.test(code) || /^#,##0(\.0+)?$/.test(code)) return "Number";
  if (/%/.test(code)) return "Percentage";
  if (/E[+-]0/i.test(code)) return "Scientific";
  if (/[dmy]/i.test(code) && /y/i.test(code)) return /dddd|mmmm/i.test(code) ? "Long Date" : "Short Date";
  if (/h/i.test(code) && /:/.test(code)) return "Time";
  if (/[$€£¥]/.test(code)) return "Currency";
  if (/\?\/\?/.test(code)) return "Fraction";
  return "Custom";
}

function NumFmt({ cx }: { cx: SheetCx }) {
  const cur = formatName(cx.s.format.numFmt);
  return (
    <select
      className="sh-numfmt"
      aria-label={cx.tw("Number Format")}
      title={cx.tw("Number Format")}
      value={cur}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "More") cx.dialog("formatCells", { tab: "Number" });
        else cx.run("home.numberFormat", { format: v });
        cx.ui.focusGrid();
      }}
    >
      {NUMBER_FORMATS.map(([n]) => (
        <option key={n} value={n}>
          {cx.tw(n)}
        </option>
      ))}
      {cur === "Custom" ? <option value="Custom">{cx.tw("Custom")}</option> : null}
      <option value="More">{cx.tw("More Number Formats…")}</option>
    </select>
  );
}

export const SHEET_CUSTOM: CustomMap = {
  fontName: FontName,
  fontSize: FontSize,
  numFmt: NumFmt,
};
