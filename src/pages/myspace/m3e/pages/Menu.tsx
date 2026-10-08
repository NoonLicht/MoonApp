import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { getOverlayRoot } from "@/components/overlayHost";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** строка-разделитель перед пунктом */
  sep?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPick?: () => void;
  /** произвольное содержимое вместо обычной строки (например, ряд цветов) */
  custom?: ReactNode;
}

/** Всплывающее меню у точки экрана. Закрывается кликом мимо, Esc, прокруткой и сменой размера окна. */
export function PopMenu({
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
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const host = getOverlayRoot() ?? document.body;
  return createPortal(
    <div
      ref={ref}
      className="m3p-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) =>
        it.custom ? (
          <div key={it.key} className={`m3p-menu-custom${it.sep ? " sep" : ""}`}>
            {it.custom}
          </div>
        ) : (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            className={`m3p-menu-item${it.sep ? " sep" : ""}${it.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              it.onPick?.();
            }}
          >
            <span className="m3p-menu-ic">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>,
    host,
  );
}
