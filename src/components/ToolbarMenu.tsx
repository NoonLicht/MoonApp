import React, { useEffect, useRef, useState } from "react";
import { IconBtn } from "./ui";

export interface ToolbarMenuProps {
  /** Иконка кнопки-триггера. */
  icon: React.ElementType;
  /** Подсказка (и она же — единственная «надпись», которую видит пользователь). */
  title?: string;
  /** Куда раскрывать поповер: align="right" для кнопок у правого края. */
  align?: "left" | "right";
  /** Подсветить триггер, даже когда поповер закрыт (например, режим включён). */
  active?: boolean;
  /** Заголовок внутри поповера. */
  label?: string;
  children: React.ReactNode;
}

/**
 * Кнопка-настройка верхнего тулбара с анимированным поповером.
 *
 * В панели разрешены только иконки (иначе на узком окне содержимое
 * накладывалось друг на друга), поэтому селекты/поля страниц живут здесь.
 * Закрывается по клику вне и по Esc.
 */
export default function ToolbarMenu({ icon, title, align = "left", active, label, children }: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tb-menu" ref={rootRef}>
      <IconBtn icon={icon} title={title} active={open || !!active} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div className={`tb-pop is-${align}`}>
          {label && <span className="tb-pop-title">{label}</span>}
          {children}
        </div>
      )}
    </div>
  );
}
