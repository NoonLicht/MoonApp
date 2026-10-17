import type { ReactNode } from "react";
import type { WordState } from "@/api/apiWord";
import type { Tw } from "@/pages/word/i18n/useTw";
import type { IconName } from "@/pages/word/ribbon/icons";

export type Params = Record<string, unknown>;

/** Всё, что нужно кнопке ленты: состояние документа и способы действовать. */
export interface Cx {
  s: WordState;
  /** Идентификатор открытого документа (сеанса ядра). */
  docId: string;
  /** Язык интерфейса приложения: от него зависят единицы длины. */
  lang: string;
  tw: Tw;
  /** Выполнить команду ядра. */
  run: (cmd: string, p?: Params) => void;
  /** Открыть диалог по имени (см. dialogs/registry). */
  dialog: (name: string, props?: Params) => void;
  /** Данные от ядра (структура документа, стили…). */
  query: <T = unknown>(method: string, p?: unknown) => Promise<T | undefined>;
  /** Команда ядра с результатом (списки стилей, источников…). */
  call: (cmd: string, p?: Params) => Promise<unknown>;
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

export type Act = { cmd: string; p?: Params } | { fn: (cx: Cx) => void };

/** Пункт выпадающего меню. */
export interface Item {
  /** Английская подпись (она же ключ перевода). */
  label?: string;
  act?: Act;
  check?: (cx: Cx) => boolean;
  enabled?: (cx: Cx) => boolean;
  sub?: Item[] | ((cx: Cx) => Item[]);
  sep?: boolean;
  head?: string;
  /** Цвет-плитка (для палитр). */
  swatch?: string;
  icon?: IconName;
  /** Произвольное содержимое (сетки, выбор цвета). */
  render?: (cx: Cx, close: () => void) => ReactNode;
  /** Не закрывать меню после выбора. */
  keep?: boolean;
  /** Подпись справа (горячие клавиши). */
  hint?: string;
  /** Уже готовый (не английский) текст — не переводить. */
  raw?: boolean;
}

export type Ctl =
  | {
      k: "big" | "small";
      icon: IconName;
      label?: string;
      tip?: string;
      act: Act;
      on?: (cx: Cx) => boolean;
      enabled?: (cx: Cx) => boolean;
    }
  | {
      k: "menu";
      icon: IconName;
      label?: string;
      tip?: string;
      big?: boolean;
      items: Item[] | ((cx: Cx) => Item[]);
      /** Основное действие по нажатию на значок (расщеплённая кнопка); стрелка открывает меню. */
      split?: Act | ((cx: Cx) => Act);
      on?: (cx: Cx) => boolean;
      enabled?: (cx: Cx) => boolean;
      /** Цветная полоска под значком (текущий цвет шрифта и т. п.). */
      swatch?: (cx: Cx) => string | undefined;
    }
  | { k: "stack"; rows: Ctl[] }
  | { k: "row"; items: Ctl[] }
  | { k: "custom"; id: string }
  | {
      k: "check";
      label: string;
      on: (cx: Cx) => boolean;
      act: (cx: Cx, v: boolean) => void;
      enabled?: (cx: Cx) => boolean;
    }
  | { k: "gap" };

export interface Group {
  id: string;
  /** Английское название группы (ключ перевода). */
  label: string;
  /** Кнопка-«уголок» в нижнем правом углу группы. */
  launcher?: Act;
  items: Ctl[];
  show?: (cx: Cx) => boolean;
}

export interface Tab {
  id: string;
  /** Английское название вкладки (ключ перевода). */
  label: string;
  groups: Group[] | ((cx: Cx) => Group[]);
  /** Контекстная вкладка: появляется по выделению и подсвечена. */
  contextual?: boolean;
}
