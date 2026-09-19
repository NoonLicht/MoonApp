import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Глобальное контекстное меню (правая кнопка мыши).
 *
 * Как это работает:
 *  - <ContextMenuProvider> оборачивает приложение и держит ЕДИНСТВЕННОЕ
 *    меню на весь UI: какой бы элемент ни вызвал open(), рисуется один поповер.
 *  - Страницы берут хук useContextMenu() и на нужных элементах вешают
 *    onContextMenu={(e) => menu.open(e, [...items])}.
 *  - open() отменяет системное меню браузера (preventDefault) и показывает
 *    список пунктов в точке курсора с клампом к границам окна.
 *  - Закрытие: любой клик (в т.ч. по пункту), Escape, resize, blur и любой
 *    scroll (в capture-фазе — меню не «уезжает» от своего элемента).
 *
 * Пункт меню: { label, icon, danger, disabled, onClick } либо
 * { separator: true } для разделителя. Filter(Boolean) позволяет собирать
 * списки условий: [a && {...}, b && {...}].
 */
export interface CtxItem {
  label?: string;
  icon?: React.ElementType;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

interface CtxState {
  x: number;
  y: number;
  items: CtxItem[];
}

const Ctx = createContext<{
  open: (e: React.MouseEvent, items: (CtxItem | false | null | undefined)[]) => void;
}>({
  open: () => {
    /* провайдер не установлен — no-op */
  },
});

/** Хук для страниц: const menu = useContextMenu(); menu.open(e, items). */
export function useContextMenu() {
  return useContext(Ctx);
}

const ITEM_H = 32; // высота пункта (синхронно с CSS .ctx-menu-item)
const PAD = 8; // внутренние отступы меню
const MIN_W = 200; // min-width меню (CSS)

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [st, setSt] = useState<CtxState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const open = useCallback((e: React.MouseEvent, items: (CtxItem | false | null | undefined)[]) => {
    const clean = (items || []).filter(Boolean) as CtxItem[];
    if (!clean.length) return; // нечего показывать — оставляем системное поведение
    e.preventDefault();
    e.stopPropagation();
    // Сначала кламп по «расчётной» высоте, точный доводчик — в useLayoutEffect.
    const estH = clean.length * ITEM_H + PAD * 2;
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - MIN_W - 8));
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - estH - 8));
    setSt({ x, y, items: clean });
  }, []);

  // Глобальные обработчики закрытия — только пока меню открыто.
  //
  // Слушатели вешаются в CAPTURE-фазе: обычный `window.addEventListener("click")`
  // не срабатывал, потому что модалки и карточки страниц активно глушат всплытие
  // (`Glass onClick={(e) => e.stopPropagation()}`), и клик по ним не доходил до
  // window — меню оставалось висеть поверх страницы.
  useEffect(() => {
    if (!st) return;
    const close = () => setSt(null);
    // Клик ВНУТРИ меню закрывать нельзя: пункт сам закроет его в своём onClick,
    // а преждевременное закрытие съело бы действие.
    const outside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && ref.current && ref.current.contains(t)) return;
      setSt(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSt(null);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("click", outside, true);
    window.addEventListener("contextmenu", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("click", outside, true);
      window.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [st !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Пока меню открыто, с верхней панели снимается «регион перетаскивания» окна:
  // Electron перехватывает мышь в drag-полосе (.titlebar-drag), из-за чего клик по
  // верхнему меню не закрывал контекстное меню вообще.
  useEffect(() => {
    if (!st) return undefined;
    document.body.classList.add("ctx-open");
    return () => document.body.classList.remove("ctx-open");
  }, [st !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Точный доводчик позиции: как только меню отрендерилось, знаем реальную
  // высоту — сдвигаем, если вылезает за нижний/правый край.
  useLayoutEffect(() => {
    if (!st || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 4) {
      setSt((p) => (p ? { ...p, y: Math.max(4, window.innerHeight - r.height - 4) } : p));
    }
    if (r.right > window.innerWidth - 4) {
      setSt((p) => (p ? { ...p, x: Math.max(4, window.innerWidth - r.width - 4) } : p));
    }
  }, [st !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {st && (
        <>
          {/* Подложка на весь экран: любой клик вне меню закрывает его (левая,
              правая кнопка, колесо не важно). Она выше остального интерфейса,
              поэтому клик не уходит на элемент под меню — как и у системных меню.
              Нажатие фиксируем уже на mousedown, чтобы закрытие было мгновенным. */}
          <div
            className="ctx-backdrop"
            onMouseDown={() => setSt(null)}
            onClick={() => setSt(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setSt(null);
            }}
          />
          <div ref={ref} className="ctx-menu" style={{ left: st.x, top: st.y }} role="menu">
            {st.items.map((it, i) =>
              it.separator ? (
                <div key={i} className="ctx-sep" />
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  className={`ctx-menu-item${it.danger ? " is-danger" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSt(null);
                    it.onClick?.();
                  }}
                >
                  {it.icon && <it.icon size={14} strokeWidth={1.8} />}
                  <span>{it.label}</span>
                </button>
              ),
            )}
          </div>
        </>
      )}
    </Ctx.Provider>
  );
}

/** Копирование в буфер с фолбэком (для не-secure контекстов). */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* уже ничего не сделать */
    }
    document.body.removeChild(ta);
  }
}
