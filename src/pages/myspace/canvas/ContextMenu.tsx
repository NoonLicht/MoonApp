import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
  /** ряд цветов вместо пункта */
  swatches?: { colors: string[]; onPick: (c: string) => void };
}

/** Контекстное меню по правой кнопке. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [onClose]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }, [x, y, items.length]);
  return (
    <div
      ref={ref}
      className="hc-ctx hc-float"
      data-ui
      style={{ left: x, top: y, position: "fixed" }}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="hc-drop-sep" />
        ) : it.swatches ? (
          <div key={i} style={{ display: "flex", gap: 6, padding: "6px 10px", flexWrap: "wrap" }}>
            {it.swatches.colors.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => {
                  onClose();
                  it.swatches?.onPick(c);
                }}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: c,
                  border: "1px solid rgba(128,128,128,0.45)",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            className={`hc-drop-main${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span style={{ flex: 1, textAlign: "left" }}>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
