import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import type { Act, BaseCx, Item } from "@/pages/word/ribbon/types";
import { ICONS } from "@/pages/word/ribbon/icons";
import { getOverlayRoot } from "@/components/overlayHost";

/** Выполнить действие пункта или кнопки. */
export function doAct<C extends BaseCx>(cx: C, act: Act<C> | undefined): void {
  if (!act) return;
  if ("cmd" in act) cx.run(act.cmd, act.p);
  else act.fn(cx);
}

const resolve = <C extends BaseCx>(cx: C, v: Item<C>[] | ((cx: C) => Item<C>[])): Item<C>[] =>
  typeof v === "function" ? v(cx) : v;

/** Положение выпадающего списка у якоря с учётом краёв окна. */
function place(
  anchor: DOMRect,
  size: { w: number; h: number },
  side: "below" | "right",
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = side === "below" ? anchor.left : anchor.right - 2;
  let top = side === "below" ? anchor.bottom + 1 : anchor.top - 4;
  if (left + size.w > vw - 6) left = side === "below" ? vw - size.w - 6 : anchor.left - size.w + 2;
  if (top + size.h > vh - 6) top = Math.max(6, vh - size.h - 6);
  return { left: Math.max(6, left), top: Math.max(6, top) };
}

function Row<C extends BaseCx>({
  item,
  cx,
  close,
  onOpenSub,
  subOpen,
}: {
  item: Item<C>;
  cx: C;
  close: () => void;
  onOpenSub: (el: HTMLElement | null) => void;
  subOpen: boolean;
}) {
  if (item.sep) return <div className="wd-m-sep" role="separator" />;
  if (item.head) return <div className="wd-m-head">{item.raw ? item.head : cx.tw(item.head)}</div>;
  if (item.render) return <div className="wd-m-custom">{item.render(cx, close)}</div>;
  const enabled = item.enabled ? item.enabled(cx) : true;
  const checked = item.check ? item.check(cx) : false;
  const Icon = item.icon ? ICONS[item.icon] : null;
  const text = item.label == null ? "" : item.raw ? item.label : cx.tw(item.label);
  return (
    <button
      type="button"
      role="menuitem"
      className={`wd-m-item${subOpen ? " open" : ""}`}
      disabled={!enabled}
      aria-checked={item.check ? checked : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={(e) => onOpenSub(item.sub ? e.currentTarget : null)}
      onClick={(e) => {
        if (item.sub) {
          onOpenSub(e.currentTarget);
          return;
        }
        doAct(cx, item.act);
        if (!item.keep) close();
      }}
    >
      <span className="wd-m-mark">{checked ? <Check size={13} /> : null}</span>
      {Icon ? <Icon size={15} className="wd-m-icon" /> : null}
      {item.swatch ? <span className="wd-m-swatch" style={{ background: item.swatch }} /> : null}
      <span className="wd-m-label">{text}</span>
      {item.hint ? <span className="wd-m-hint">{item.hint}</span> : null}
      {item.sub ? <ChevronRight size={13} className="wd-m-chev" /> : null}
    </button>
  );
}

function List<C extends BaseCx>({
  items,
  cx,
  anchor,
  side,
  close,
}: {
  items: Item<C>[];
  cx: C;
  anchor: DOMRect;
  side: "below" | "right";
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: 0 });
  const [sub, setSub] = useState<{ idx: number; rect: DOMRect } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(place(anchor, { w: el.offsetWidth, h: el.offsetHeight }, side));
  }, [anchor, side, items]);

  return (
    <>
      <div
        ref={ref}
        className="wd-menu"
        role="menu"
        style={{ left: pos.left, top: pos.top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <Row
            key={i}
            item={it}
            cx={cx}
            close={close}
            subOpen={sub?.idx === i}
            onOpenSub={(el) => setSub(el ? { idx: i, rect: el.getBoundingClientRect() } : null)}
          />
        ))}
      </div>
      {sub && items[sub.idx]?.sub ? (
        <List
          items={resolve(cx, items[sub.idx].sub as Item<C>[] | ((cx: C) => Item<C>[]))}
          cx={cx}
          anchor={sub.rect}
          side="right"
          close={close}
        />
      ) : null}
    </>
  );
}

/** Выпадающее меню у якоря; закрывается кликом вне меню, Escape и прокруткой. */
export function MenuPopup<C extends BaseCx>({
  items,
  cx,
  anchor,
  onClose,
}: {
  items: Item<C>[];
  cx: C;
  anchor: DOMRect;
  onClose: () => void;
}) {
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".wd-menu, .wd-minitb")) return;
      onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <List items={items} cx={cx} anchor={anchor} side="below" close={onClose} />,
    getOverlayRoot() ?? document.body,
  );
}

/** Меню в точке (правая кнопка). */
export function ContextPopup<C extends BaseCx>({
  items,
  cx,
  x,
  y,
  onClose,
}: {
  items: Item<C>[];
  cx: C;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const rect = new DOMRect(x, y, 0, 0);
  return <MenuPopup items={items} cx={cx} anchor={rect} onClose={onClose} />;
}
