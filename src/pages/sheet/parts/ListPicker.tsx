import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getOverlayRoot } from "@/components/overlayHost";
import type { SheetCx } from "@/pages/sheet/types";
import { a1 } from "@/pages/sheet/grid/geometry";

/** Раскрывающийся список проверки данных у активной ячейки. */
export default function ListPicker({
  cx,
  anchor,
  onClose,
}: {
  cx: SheetCx;
  anchor: { r: number; c: number; rect: DOMRect };
  onClose: () => void;
}) {
  const items = cx.s.ctx.validation?.items ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.rect.left, top: anchor.rect.bottom });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      left: Math.max(6, Math.min(anchor.rect.left, window.innerWidth - el.offsetWidth - 6)),
      top: Math.min(anchor.rect.bottom + 1, window.innerHeight - el.offsetHeight - 6),
    });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      className="wd-menu sh-listpick"
      style={{ left: pos.left, top: pos.top, minWidth: Math.max(120, anchor.rect.width) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.length ? (
        items.map((v) => (
          <button
            key={v}
            type="button"
            className="wd-m-item"
            onClick={() => {
              cx.run("cell.set", { cell: a1(anchor.r, anchor.c), input: v });
              onClose();
            }}
          >
            <span className="wd-m-label">{v}</span>
          </button>
        ))
      ) : (
        <div className="wd-muted" style={{ padding: 8 }}>
          {cx.tw("(empty list)")}
        </div>
      )}
    </div>,
    getOverlayRoot() ?? document.body,
  );
}
