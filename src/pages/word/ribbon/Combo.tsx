import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { getOverlayRoot } from "@/components/overlayHost";

/**
 * Поле с выпадающим списком (шрифт, размер): можно выбрать из списка или ввести своё значение и нажать Enter.
 * Применяется только по выбору/Enter/потере фокуса — набор текста сам ничего не меняет.
 */
export default function Combo({
  value,
  options,
  onCommit,
  width,
  label,
  optionStyle,
  disabled,
}: {
  value: string;
  options: string[];
  onCommit: (v: string) => void;
  width: number;
  label: string;
  optionStyle?: (o: string) => React.CSSProperties;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: 0, w: width });

  useEffect(() => {
    if (!focus) setText(value);
  }, [value, focus]);

  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    const h = list.current?.offsetHeight ?? 240;
    const top = r.bottom + h > window.innerHeight - 8 ? Math.max(8, r.top - h) : r.bottom + 1;
    setPos({ left: r.left, top, w: Math.max(r.width, 130) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || list.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", down, true);
    return () => document.removeEventListener("mousedown", down, true);
  }, [open]);

  // Текущее значение — в видимой части списка.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(".cur")?.scrollIntoView({ block: "center" });
  }, [open, pos.left]);

  const commit = (v: string): void => {
    const t = v.trim();
    if (t && t !== value) onCommit(t);
    setOpen(false);
  };

  return (
    <span ref={wrap} className="wd-combo" style={{ width }}>
      <input
        value={text}
        aria-label={label}
        title={label}
        disabled={disabled}
        spellCheck={false}
        onFocus={(e) => {
          setFocus(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocus(false);
          if (text.trim() && text.trim() !== value) onCommit(text.trim());
          else setText(value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(value);
            setOpen(false);
            e.currentTarget.blur();
          } else if (e.key === "ArrowDown") {
            setOpen(true);
          }
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={11} />
      </button>
      {open
        ? createPortal(
            <div
              ref={list}
              className="wd-menu wd-combo-list"
              style={{ left: pos.left, top: pos.top, minWidth: pos.w }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={`wd-m-item${o === value ? " cur" : ""}`}
                  style={optionStyle?.(o)}
                  onClick={() => {
                    onCommit(o);
                    setText(o);
                    setOpen(false);
                  }}
                >
                  <span className="wd-m-label">{o}</span>
                </button>
              ))}
            </div>,
            getOverlayRoot() ?? document.body,
          )
        : null}
    </span>
  );
}
