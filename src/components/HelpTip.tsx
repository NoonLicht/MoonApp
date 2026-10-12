import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getOverlayRoot } from "@/components/overlayHost";

/**
 * Кнопка-подсказка («?» / «i»): описание всплывает по наведению или фокусу.
 *
 * Подсказка рисуется порталом в #overlay-root с position: fixed — иначе её
 * сдвигал бы любой предок с backdrop-filter/transform (стеклянные карточки)
 * и обрезал бы скролл-контейнер панели.
 */
export function HelpTip({
  text,
  className = "up-info-btn",
  children,
}: {
  text: string;
  className?: string;
  children: React.ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    // У края окна подсказку сдвигаем: центр по кнопке вывел бы её за экран.
    const half = 140;
    const x = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half);
    setPos({ x, y: r.bottom + 8 });
  };

  const root = typeof document === "undefined" ? null : (getOverlayRoot() ?? document.body);

  return (
    <>
      <button
        type="button"
        ref={btn}
        className={className}
        aria-label={text}
        onMouseEnter={show}
        onFocus={show}
        onMouseLeave={() => setPos(null)}
        onBlur={() => setPos(null)}
        onClick={() => (pos ? setPos(null) : show())}
      >
        {children}
      </button>
      {pos && root
        ? createPortal(
            <span className="float-tip" role="tooltip" style={{ left: pos.x, top: pos.y }}>
              {text}
            </span>,
            root,
          )
        : null}
    </>
  );
}
