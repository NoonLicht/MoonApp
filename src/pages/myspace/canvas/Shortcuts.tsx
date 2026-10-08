import { useEffect } from "react";
import { X } from "lucide-react";

type Row = [keys: string, ru: string, en: string];
type Group = { ru: string; en: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    ru: "Инструменты",
    en: "Tools",
    rows: [
      ["V", "Выбор", "Select"],
      ["H / Пробел", "Рука (перемещение холста)", "Hand / hold Space to pan"],
      ["S", "Стикер", "Sticky note"],
      ["T", "Текст", "Text"],
      ["R", "Фигура", "Shape"],
      ["L", "Линия-соединитель", "Connector"],
      ["F", "Рамка", "Frame"],
      ["P", "Карандаш", "Pen"],
      ["K", "Задача", "Task card"],
      ["E", "Эмодзи", "Emoji"],
      ["I", "Вставить картинку", "Insert image"],
    ],
  },
  {
    ru: "Правка",
    en: "Edit",
    rows: [
      ["Ctrl+Z / Ctrl+⇧Z", "Отменить / повторить", "Undo / redo"],
      ["Ctrl+A", "Выделить всё", "Select all"],
      ["Tab / ⇧Tab", "Следующий / предыдущий объект", "Next / previous object"],
      ["Ctrl+C / X / V", "Копировать / вырезать / вставить", "Copy / cut / paste"],
      ["Ctrl+D", "Дублировать", "Duplicate"],
      ["Alt + перетаскивание", "Копия при переносе", "Drag with Alt to copy"],
      ["Del", "Удалить", "Delete"],
      ["Enter / двойной клик", "Править текст", "Edit text"],
      ["Ctrl+B / Ctrl+I", "Жирный / курсив", "Bold / italic"],
      ["← ↑ → ↓ (⇧ ×10)", "Сдвинуть на 1 пиксель", "Nudge by 1px"],
    ],
  },
  {
    ru: "Расположение",
    en: "Arrange",
    rows: [
      ["Ctrl+G / Ctrl+⇧G", "Сгруппировать / разгруппировать", "Group / ungroup"],
      ["Ctrl+] / Ctrl+[", "Выше / ниже на слой", "Forward / backward"],
      ["Ctrl+⇧] / Ctrl+⇧[", "На передний / задний план", "To front / to back"],
      ["Ctrl+⇧L", "Закрепить / открепить", "Lock / unlock"],
      ["Ctrl+⇧H", "Скрыть", "Hide"],
      ["Alt+A / Alt+D", "Выровнять по левому / правому краю", "Align left / right"],
      ["Alt+W / Alt+S", "Выровнять по верху / низу", "Align top / bottom"],
      ["Alt+H / Alt+V", "По центру по горизонтали / вертикали", "Center horizontally / vertically"],
    ],
  },
  {
    ru: "Вид",
    en: "View",
    rows: [
      ["+ / −  или  Ctrl+= / Ctrl+−", "Масштаб", "Zoom"],
      ["Ctrl+0", "Масштаб 100%", "Zoom to 100%"],
      ["⇧1 / ⇧2", "Показать всё / выделенное", "Fit all / selection"],
      ["Ctrl+'", "Сетка", "Toggle grid"],
      ["Ctrl+⇧'", "Привязка", "Toggle snapping"],
      ["? / F1", "Это окно", "This window"],
      ["Esc", "Снять выделение / отменить жест", "Deselect / cancel"],
    ],
  },
];

/** Окно со списком горячих клавиш холста. */
export function Shortcuts({ ru, onClose }: { ru: boolean; onClose: () => void }) {
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
  return (
    <div className="hc-help-back" data-ui onPointerDown={onClose}>
      <div className="hc-help hc-float" onPointerDown={(e) => e.stopPropagation()}>
        <div className="hc-help-head">
          <b>{ru ? "Горячие клавиши" : "Keyboard shortcuts"}</b>
          <button type="button" className="hc-btn" onClick={onClose} aria-label="close">
            <X size={15} />
          </button>
        </div>
        <div className="hc-help-body">
          {GROUPS.map((g) => (
            <section key={g.en}>
              <h4>{ru ? g.ru : g.en}</h4>
              {g.rows.map((r) => (
                <div key={r[0]} className="hc-help-row">
                  <span>{ru ? r[1] : r[2]}</span>
                  <kbd>{r[0]}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
