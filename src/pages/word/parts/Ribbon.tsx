import { useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Plus,
  Redo2,
  Strikethrough,
  Subscript,
  Superscript,
  Table2,
  Underline,
  Undo2,
  Image as ImageIcon,
  FileText,
  Hash,
  Calendar,
  Pilcrow,
  SearchCheck,
} from "lucide-react";
import { useI18n } from "@/app/i18n";
import type { WordDocs } from "@/pages/word/useWordDocs";
import type { WordState } from "@/api/apiWord";

type Tab = "home" | "insert" | "layout" | "review" | "view";
const TABS: Tab[] = ["home", "insert", "layout", "review", "view"];

const FONTS = [
  "Arial",
  "Calibri",
  "Cambria",
  "Courier New",
  "Georgia",
  "Liberation Sans",
  "Times New Roman",
  "Verdana",
];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const STYLES = [
  ["Normal", "word.style.normal"],
  ["Title", "word.style.title"],
  ["Heading1", "word.style.h1"],
  ["Heading2", "word.style.h2"],
  ["Heading3", "word.style.h3"],
  ["Quote", "word.style.quote"],
] as const;

/** Кнопка ленты: подсказка и aria-label — из i18n, нажатое состояние — из форматирования под кареткой. */
function B({
  icon: Icon,
  label,
  on,
  disabled,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`wd-btn${on ? " on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon size={15} />
    </button>
  );
}

const Sep = () => <span className="wd-sep" />;

/** Цвет из ответа ядра: "Auto" | [r,g,b] | {Rgb: [r,g,b]} → #rrggbb. */
function colorHex(c: unknown): string {
  const rgb = Array.isArray(c) ? c : (c as { Rgb?: number[] } | null)?.Rgb;
  if (!Array.isArray(rgb) || rgb.length < 3) return "#000000";
  return `#${rgb
    .map((n) =>
      Math.max(0, Math.min(255, Number(n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export default function Ribbon({
  docs,
  state,
  zoom,
  setZoom,
  onFind,
  onPickImage,
}: {
  docs: WordDocs;
  state: WordState;
  zoom: number;
  setZoom: (z: number) => void;
  onFind: () => void;
  onPickImage: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("home");
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const ty = state.typing;
  const para = state.para;
  const run = (c: string, p: Record<string, unknown> = {}): void => void docs.run(c, p);
  const size = Number(ty.size) || 11;
  const align = String(para?.align ?? "left");
  const styleId = String(para?.style ?? "Normal");

  return (
    <div className="wd-ribbon">
      <div className="wd-tabs" role="tablist">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`wd-tab${tab === k ? " active" : ""}`}
            onClick={() => setTab(k)}
          >
            {t(`word.tab.${k}`)}
          </button>
        ))}
      </div>

      <div className="wd-bar">
        {tab === "home" && (
          <>
            <B
              icon={Undo2}
              label={t("word.undo")}
              disabled={!state.canUndo}
              onClick={() => run("edit.undo")}
            />
            <B
              icon={Redo2}
              label={t("word.redo")}
              disabled={!state.canRedo}
              onClick={() => run("edit.redo")}
            />
            <Sep />
            <select
              className="wd-select"
              aria-label={t("word.font")}
              value={String(ty.font ?? "")}
              onChange={(e) => run("format.font", { name: e.target.value })}
            >
              {!FONTS.includes(String(ty.font ?? "")) && (
                <option value={String(ty.font ?? "")}>{String(ty.font || "—")}</option>
              )}
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <B
              icon={Minus}
              label={t("word.fontSmaller")}
              onClick={() => run("format.size", { size: Math.max(1, size - 1) })}
            />
            <select
              className="wd-select wd-size"
              aria-label={t("word.size")}
              value={String(size)}
              onChange={(e) => run("format.size", { size: Number(e.target.value) })}
            >
              {!SIZES.includes(size) && <option value={String(size)}>{size}</option>}
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <B
              icon={Plus}
              label={t("word.fontBigger")}
              onClick={() => run("format.size", { size: size + 1 })}
            />
            <Sep />
            <B
              icon={Bold}
              label={t("word.bold")}
              on={!!ty.bold}
              onClick={() => run("format.bold")}
            />
            <B
              icon={Italic}
              label={t("word.italic")}
              on={!!ty.italic}
              onClick={() => run("format.italic")}
            />
            <B
              icon={Underline}
              label={t("word.underline")}
              on={!!ty.underline && ty.underline !== "none"}
              onClick={() => run("format.underline")}
            />
            <B
              icon={Strikethrough}
              label={t("word.strike")}
              on={!!ty.strike}
              onClick={() => run("format.strikethrough")}
            />
            <B
              icon={Subscript}
              label={t("word.sub")}
              on={ty.vertAlign === "subscript"}
              onClick={() => run("format.subscript")}
            />
            <B
              icon={Superscript}
              label={t("word.sup")}
              on={ty.vertAlign === "superscript"}
              onClick={() => run("format.superscript")}
            />
            <input
              className="wd-color"
              type="color"
              aria-label={t("word.color")}
              title={t("word.color")}
              value={colorHex(ty.color)}
              onChange={(e) => run("format.color", { color: e.target.value.slice(1) })}
            />
            <B
              icon={Highlighter}
              label={t("word.highlight")}
              on={!!ty.highlight && ty.highlight !== "none"}
              onClick={() =>
                run("format.highlight", {
                  color: ty.highlight && ty.highlight !== "none" ? "none" : "yellow",
                })
              }
            />
            <B icon={Eraser} label={t("word.clearFormat")} onClick={() => run("format.clear")} />
            <Sep />
            <B
              icon={AlignLeft}
              label={t("word.alignLeft")}
              on={align === "left"}
              onClick={() => run("para.alignLeft")}
            />
            <B
              icon={AlignCenter}
              label={t("word.alignCenter")}
              on={align === "center"}
              onClick={() => run("para.alignCenter")}
            />
            <B
              icon={AlignRight}
              label={t("word.alignRight")}
              on={align === "right"}
              onClick={() => run("para.alignRight")}
            />
            <B
              icon={AlignJustify}
              label={t("word.justify")}
              on={align === "justify"}
              onClick={() => run("para.justify")}
            />
            <Sep />
            <B icon={List} label={t("word.bullets")} onClick={() => run("para.bullets")} />
            <B
              icon={ListOrdered}
              label={t("word.numbering")}
              onClick={() => run("para.numbering")}
            />
            <B
              icon={IndentDecrease}
              label={t("word.outdent")}
              onClick={() => run("para.outdent")}
            />
            <B icon={IndentIncrease} label={t("word.indent")} onClick={() => run("para.indent")} />
            <Sep />
            <select
              className="wd-select"
              aria-label={t("word.lineSpacing")}
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) run("para.lineSpacing", { value: Number(v) });
                e.target.value = "";
              }}
            >
              <option value="">{t("word.lineSpacing")}</option>
              {[1, 1.15, 1.5, 2, 2.5, 3].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <select
              className="wd-select"
              aria-label={t("word.styles")}
              value={STYLES.some(([id]) => id === styleId) ? styleId : ""}
              onChange={(e) => e.target.value && run("para.style", { style: e.target.value })}
            >
              {!STYLES.some(([id]) => id === styleId) && <option value="">{styleId}</option>}
              {STYLES.map(([id, key]) => (
                <option key={id} value={id}>
                  {t(key)}
                </option>
              ))}
            </select>
          </>
        )}

        {tab === "insert" && (
          <>
            <input
              className="wd-num"
              type="number"
              min={1}
              max={30}
              aria-label={t("word.rows")}
              value={rows}
              onChange={(e) => setRows(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
            />
            <span className="wd-x">×</span>
            <input
              className="wd-num"
              type="number"
              min={1}
              max={12}
              aria-label={t("word.cols")}
              value={cols}
              onChange={(e) => setCols(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
            />
            <B
              icon={Table2}
              label={t("word.insertTable")}
              onClick={() => run("insert.table", { rows, cols })}
            />
            <B icon={ImageIcon} label={t("word.insertPicture")} onClick={onPickImage} />
            <B
              icon={Link2}
              label={t("word.insertLink")}
              onClick={() => {
                const url = window.prompt(t("word.linkPrompt"), "https://");
                if (url) run("insert.link", { url });
              }}
            />
            <Sep />
            <B
              icon={FileText}
              label={t("word.pageBreak")}
              onClick={() => run("insert.pageBreak")}
            />
            <B
              icon={Hash}
              label={t("word.pageNumber")}
              onClick={() => run("insert.pageNumber", { position: "bottom", align: "center" })}
            />
            <B icon={Calendar} label={t("word.dateTime")} onClick={() => run("insert.dateTime")} />
            <Sep />
            <button
              type="button"
              className="wd-text"
              onClick={() => run("insert.header", { preset: "blank" })}
            >
              {t("word.header")}
            </button>
            <button
              type="button"
              className="wd-text"
              onClick={() => run("insert.footer", { preset: "blank" })}
            >
              {t("word.footer")}
            </button>
            {state.typing && (
              <>
                <Sep />
                <button
                  type="button"
                  className="wd-text"
                  onClick={() => run("table.insertRowBelow")}
                >
                  {t("word.rowBelow")}
                </button>
                <button
                  type="button"
                  className="wd-text"
                  onClick={() => run("table.insertColumnRight")}
                >
                  {t("word.colRight")}
                </button>
                <button type="button" className="wd-text" onClick={() => run("table.deleteRow")}>
                  {t("word.delRow")}
                </button>
                <button type="button" className="wd-text" onClick={() => run("table.merge")}>
                  {t("word.merge")}
                </button>
              </>
            )}
          </>
        )}

        {tab === "layout" && (
          <>
            <label className="wd-lbl">
              {t("word.margins")}
              <select
                className="wd-select"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) run("layout.margins", { preset: e.target.value });
                  e.target.value = "";
                }}
              >
                <option value="" />
                {["normal", "narrow", "moderate", "wide", "mirrored"].map((v) => (
                  <option key={v} value={v}>
                    {t(`word.margin.${v}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="wd-lbl">
              {t("word.orientation")}
              <select
                className="wd-select"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) run("layout.orientation", { value: e.target.value });
                  e.target.value = "";
                }}
              >
                <option value="" />
                <option value="portrait">{t("word.portrait")}</option>
                <option value="landscape">{t("word.landscape")}</option>
              </select>
            </label>
            <label className="wd-lbl">
              {t("word.paperSize")}
              <select
                className="wd-select"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) run("layout.size", { name: e.target.value });
                  e.target.value = "";
                }}
              >
                <option value="" />
                {["A4", "A5", "Letter", "Legal"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="wd-lbl">
              {t("word.columns")}
              <select
                className="wd-select"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) run("layout.columns", { count: Number(e.target.value) });
                  e.target.value = "";
                }}
              >
                <option value="" />
                {[1, 2, 3].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <Sep />
            <button
              type="button"
              className="wd-text"
              onClick={() => run("layout.break", { kind: "page" })}
            >
              {t("word.pageBreak")}
            </button>
            <button
              type="button"
              className="wd-text"
              onClick={() => run("layout.break", { kind: "nextPage" })}
            >
              {t("word.sectionBreak")}
            </button>
          </>
        )}

        {tab === "review" && (
          <>
            <button type="button" className="wd-text" onClick={() => run("review.trackChanges")}>
              {t("word.trackChanges")}
            </button>
            <button type="button" className="wd-text" onClick={() => run("review.acceptAll")}>
              {t("word.acceptAll")}
            </button>
            <button type="button" className="wd-text" onClick={() => run("review.rejectAll")}>
              {t("word.rejectAll")}
            </button>
            <button type="button" className="wd-text" onClick={() => run("review.nextChange")}>
              {t("word.nextChange")}
            </button>
            <Sep />
            <B icon={SearchCheck} label={t("word.findReplace")} onClick={onFind} />
          </>
        )}

        {tab === "view" && (
          <>
            <B icon={Pilcrow} label={t("word.marks")} onClick={() => run("view.marks")} />
            <Sep />
            <B
              icon={Minus}
              label={t("word.zoomOut")}
              onClick={() => setZoom(Math.max(0.4, +(zoom - 0.1).toFixed(2)))}
            />
            <span className="wd-zoomval">{Math.round(zoom * 100)}%</span>
            <B
              icon={Plus}
              label={t("word.zoomIn")}
              onClick={() => setZoom(Math.min(2.5, +(zoom + 0.1).toFixed(2)))}
            />
            <button type="button" className="wd-text" onClick={() => setZoom(1)}>
              100%
            </button>
          </>
        )}
      </div>
    </div>
  );
}
