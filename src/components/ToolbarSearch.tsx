import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { IconBtn } from "@/components/ui";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { NARROW_TOOLBAR_QUERY } from "@/components/toolbarSearchMode";

export interface ToolbarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Enter в поле (например, запустить поиск по TMDB). */
  onSubmit?: () => void;
  /** Подсказка кнопки-триггера в узком режиме (по умолчанию — placeholder). */
  title?: string;
  /** Подпись кнопки очистки; без неё кнопка не показывается. */
  clearTitle?: string;
  /**
   * Не рисовать «пилюлю» вокруг поля: поиск живёт внутри чужой строки-панели
   * (например, url-bar магазина), которая уже сама оформлена.
   */
  bare?: boolean;
}

/**
 * Поиск верхней панели управления.
 *
 * Логика адаптива: пока панели хватает места (≥ 1200px, BREAKPOINTS.md), поле
 * стоит прямо в панели. В узком окне поле убирается под кнопку-иконку, а по
 * нажатию раскрывается поповером чуть ниже панели — тот же приём, что у
 * ToolbarMenu: в самой панели остаются только иконки, иначе на узком окне
 * элементы налезают друг на друга.
 *
 * Порог держим в `./toolbarSearchMode` (чистая функция, покрыта тестом), а не
 * в разметке — так медиазапрос в JS и CSS-правила совпадают.
 */
export default function ToolbarSearch({
  value,
  onChange,
  placeholder,
  onSubmit,
  title,
  clearTitle,
  bare,
}: ToolbarSearchProps) {
  const narrow = useMediaQuery(NARROW_TOOLBAR_QUERY);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Окно снова широкое — поле возвращается в панель, поповер закрываем.
  useEffect(() => {
    if (!narrow) setOpen(false);
  }, [narrow]);

  // Поповер раскрылся — сразу ставим курсор в поле: пользователь нажал «поиск».
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Закрытие по клику вне и по Esc — как в ToolbarMenu.
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter: подтверждаем поиск и убираем поповер, чтобы не закрывать результат
    // (в панели поле и так стоит на виду — там закрывать нечего).
    if (e.key === "Enter" && onSubmit) {
      onSubmit();
      setOpen(false);
    } else if (e.key === "Escape") setOpen(false);
  };

  const clearBtn = (ref: React.RefObject<HTMLInputElement | null>) =>
    clearTitle && value ? (
      <button
        type="button"
        className="tb-search-clear"
        title={clearTitle}
        aria-label={clearTitle}
        onClick={() => {
          onChange("");
          ref.current?.focus();
        }}
      >
        <X size={12} />
      </button>
    ) : null;

  // Широкая панель: поле стоит в ней как обычный контрол страницы.
  if (!narrow) {
    return (
      <div className={`tb-search ${bare ? "is-bare" : ""}`}>
        <Search size={14} />
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {clearBtn(inputRef)}
      </div>
    );
  }

  // Узкая панель: только иконка, поле — в поповере под панелью.
  return (
    <div className="tb-menu" ref={rootRef}>
      <IconBtn
        icon={Search}
        title={title || placeholder}
        aria-label={title || placeholder}
        aria-expanded={open}
        active={open || !!value}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="tb-pop tb-search-pop is-left">
          <div className="tb-search">
            <Search size={14} />
            <input
              ref={inputRef}
              value={value}
              placeholder={placeholder}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {clearBtn(inputRef)}
          </div>
        </div>
      )}
    </div>
  );
}
