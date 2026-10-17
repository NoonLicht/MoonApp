import type { ReactNode } from "react";
import type { WordState } from "@/api/apiWord";
import type { Tw } from "@/pages/word/i18n/useTw";
import type { IconName } from "@/pages/word/ribbon/icons";

export type Params = Record<string, unknown>;

/**
 * Минимум, который нужен общему каркасу ленты (кнопки, меню, палитры): им пользуются
 * и «Документы», и «Таблицы», у каждой страницы своё состояние `s` и свой набор действий `ui`.
 */
export interface BaseCx {
  /** Идентификатор открытого документа (сеанса ядра). */
  docId: string;
  /** Язык интерфейса приложения: от него зависят единицы длины. */
  lang: string;
  tw: Tw;
  /** Выполнить команду ядра. */
  run: (cmd: string, p?: Params) => void;
  /** Открыть диалог по имени. */
  dialog: (name: string, props?: Params) => void;
  /** Данные от ядра (структура документа, стили…). */
  query: <T = unknown>(method: string, p?: unknown) => Promise<T | undefined>;
  /** Команда ядра с результатом (списки стилей, источников…). */
  call: (cmd: string, p?: Params) => Promise<unknown>;
  /** Цвета темы документа (RRGGBB без «#»): светлый 1, тёмный 1, светлый 2, тёмный 2, акценты 1–6, ссылки. */
  themeColors: string[];
  ui: { backstage: (page?: string) => void };
}

/** Всё, что нужно кнопке ленты Word: состояние документа и способы действовать. */
export interface Cx extends BaseCx {
  s: WordState;
  /** Интерфейс страницы: масштаб, панели, меню «Файл», вставка картинки. */
  ui: {
    zoom: number;
    setZoom: (z: number) => void;
    togglePane: (name: PaneName, on?: boolean) => void;
    pane: PaneName | null;
    backstage: (page?: string) => void;
    pickImage: (cmd: string, extra?: Params) => void;
    pickFile: (accept: string, then: (f: File) => void) => void;
    copy: (cut?: boolean) => void;
    paste: (as?: "default" | "text" | "merge") => void;
    fonts: string[];
    status: (msg: string) => void;
    /** Загрузить файл на сервер → путь для команд ядра. */
    upload: (file: File) => Promise<string | undefined>;
    /** Скачать документ в формате (docx, pdf, odt, rtf, html, md, txt) под своим именем. */
    exportAs: (format: string, name?: string) => void;
    /** Название открытого документа. */
    docName: string;
    /** Режим мыши на странице (рисование таблицы, ластик таблицы); null — обычный ввод. */
    tool: "drawTable" | "eraseTable" | null;
    setTool: (t: "drawTable" | "eraseTable" | null) => void;
  };
}

export type PaneName =
  | "navigation"
  | "comments"
  | "styles"
  | "reviewing"
  | "accessibility"
  | "altText"
  | "clipboard"
  | "selection"
  | "smartArt"
  | "find"
  | "proofing";

export type Act<C extends BaseCx = Cx> = { cmd: string; p?: Params } | { fn: (cx: C) => void };

/** Пункт выпадающего меню. */
export interface Item<C extends BaseCx = Cx> {
  /** Английская подпись (она же ключ перевода). */
  label?: string;
  act?: Act<C>;
  check?: (cx: C) => boolean;
  enabled?: (cx: C) => boolean;
  sub?: Item<C>[] | ((cx: C) => Item<C>[]);
  sep?: boolean;
  head?: string;
  /** Цвет-плитка (для палитр). */
  swatch?: string;
  icon?: IconName;
  /** Произвольное содержимое (сетки, выбор цвета). */
  render?: (cx: C, close: () => void) => ReactNode;
  /** Не закрывать меню после выбора. */
  keep?: boolean;
  /** Подпись справа (горячие клавиши). */
  hint?: string;
  /** Уже готовый (не английский) текст — не переводить. */
  raw?: boolean;
}

export type Ctl<C extends BaseCx = Cx> =
  | {
      k: "big" | "small";
      icon: IconName;
      label?: string;
      tip?: string;
      act: Act<C>;
      on?: (cx: C) => boolean;
      enabled?: (cx: C) => boolean;
    }
  | {
      k: "menu";
      icon: IconName;
      label?: string;
      tip?: string;
      big?: boolean;
      items: Item<C>[] | ((cx: C) => Item<C>[]);
      /** Основное действие по нажатию на значок (расщеплённая кнопка); стрелка открывает меню. */
      split?: Act<C> | ((cx: C) => Act<C>);
      on?: (cx: C) => boolean;
      enabled?: (cx: C) => boolean;
      /** Цветная полоска под значком (текущий цвет шрифта и т. п.). */
      swatch?: (cx: C) => string | undefined;
    }
  | { k: "stack"; rows: Ctl<C>[] }
  | { k: "row"; items: Ctl<C>[] }
  | { k: "custom"; id: string }
  | {
      k: "check";
      label: string;
      on: (cx: C) => boolean;
      act: (cx: C, v: boolean) => void;
      enabled?: (cx: C) => boolean;
    }
  | { k: "gap" };

export interface Group<C extends BaseCx = Cx> {
  id: string;
  /** Английское название группы (ключ перевода). */
  label: string;
  /** Кнопка-«уголок» в нижнем правом углу группы. */
  launcher?: Act<C>;
  items: Ctl<C>[];
  show?: (cx: C) => boolean;
}

export interface Tab<C extends BaseCx = Cx> {
  id: string;
  /** Английское название вкладки (ключ перевода). */
  label: string;
  groups: Group<C>[] | ((cx: C) => Group<C>[]);
  /** Контекстная вкладка: появляется по выделению и подсвечена. */
  contextual?: boolean;
}
