import { useEffect } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/app/i18n";

/** [клавиши, i18n-ключ подписи]. Клавиши с «k:» — тоже ключ (там есть слова). */
type Row = [keys: string, label: string];
type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "tools",
    rows: [
      ["V", "select"],
      ["k:handSpace", "hand"],
      ["S", "sticky"],
      ["T", "text"],
      ["R", "shape"],
      ["L", "connector"],
      ["F", "frame"],
      ["P", "pen"],
      ["K", "task"],
      ["E", "emoji"],
      ["I", "image"],
    ],
  },
  {
    title: "edit",
    rows: [
      ["Ctrl+Z / Ctrl+⇧Z", "undoRedo"],
      ["Ctrl+A", "selectAll"],
      ["Tab / ⇧Tab", "nextPrev"],
      ["Ctrl+C / X / V", "clipboard"],
      ["Ctrl+D", "duplicate"],
      ["k:altDrag", "altCopy"],
      ["Del", "delete"],
      ["k:enterDbl", "editText"],
      ["Ctrl+B / Ctrl+I", "boldItalic"],
      ["← ↑ → ↓ (⇧ ×10)", "nudge"],
    ],
  },
  {
    title: "arrange",
    rows: [
      ["Ctrl+G / Ctrl+⇧G", "group"],
      ["Ctrl+] / Ctrl+[", "layer"],
      ["Ctrl+⇧] / Ctrl+⇧[", "frontBack"],
      ["Ctrl+⇧L", "lock"],
      ["Ctrl+⇧H", "hide"],
      ["Alt+A / Alt+D", "alignLR"],
      ["Alt+W / Alt+S", "alignTB"],
      ["Alt+H / Alt+V", "center"],
    ],
  },
  {
    title: "view",
    rows: [
      ["k:zoom", "zoom"],
      ["Ctrl+0", "zoom100"],
      ["⇧1 / ⇧2", "fit"],
      ["Ctrl+'", "grid"],
      ["Ctrl+⇧'", "snap"],
      ["? / F1", "help"],
      ["Esc", "escape"],
    ],
  },
];

/** Окно со списком горячих клавиш холста. */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?" || e.key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  const keys = (k: string) => (k.startsWith("k:") ? t(`canvasHelp.keys.${k.slice(2)}`) : k);
  return (
    <div className="hc-help-back" data-ui onPointerDown={onClose}>
      <div className="hc-help hc-float" onPointerDown={(e) => e.stopPropagation()}>
        <div className="hc-help-head">
          <b>{t("canvasHelp.title")}</b>
          <button type="button" className="hc-btn" onClick={onClose} aria-label="close">
            <X size={15} />
          </button>
        </div>
        <div className="hc-help-body">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h4>{t(`canvasHelp.groups.${g.title}`)}</h4>
              {g.rows.map((r) => (
                <div key={r[0]} className="hc-help-row">
                  <span>{t(`canvasHelp.rows.${r[1]}`)}</span>
                  <kbd>{keys(r[0])}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
