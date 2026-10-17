import type { SheetState } from "@/api/apiSheet";
import type { BaseCx, Params } from "@/pages/word/ribbon/types";
import type { EditApi, ObjSel } from "@/pages/sheet/edit";

export type { Params };

export type SheetPane = "pivotFields" | "formatChart" | "comments" | "selection" | "watch" | "names" | "find";

/** Всё, что нужно кнопке ленты «Таблиц»: состояние книги и способы действовать. */
export interface SheetCx extends BaseCx {
  s: SheetState;
  ui: {
    backstage: (page?: string) => void;
    pane: SheetPane | null;
    togglePane: (name: SheetPane, on?: boolean) => void;
    /** Вставить из системного буфера. */
    paste: (what?: string, op?: string) => void;
    copy: (cut?: boolean) => void;
    status: (msg: string) => void;
    /** Выбрать файл на диске и передать его. */
    pickFile: (accept: string, then: (f: File) => void) => void;
    /** Загрузить файл на сервер → путь для команд ядра. */
    upload: (file: File) => Promise<string | undefined>;
    /** Скачать книгу в формате (xlsx, csv, tsv, json, html, pdf) под своим именем. */
    exportAs: (format: string, name?: string, sheets?: "active" | "all") => void;
    docName: string;
    edit: EditApi;
    selObj: ObjSel | null;
    focusGrid: () => void;
    /** Список шрифтов системы. */
    fonts: string[];
    /** Имена листов для выпадающих списков. */
    sheets: string[];
  };
}
