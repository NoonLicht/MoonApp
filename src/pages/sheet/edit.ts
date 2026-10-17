/** Правка ячейки: текст общий для ячейки и строки формул. */
export interface EditState {
  r: number;
  c: number;
  text: string;
  /** enter — набор поверх ячейки (стрелки завершают ввод), edit — правка (стрелки двигают курсор). */
  mode: "enter" | "edit";
  /** Где сейчас фокус ввода: в самой ячейке или в строке формул. */
  origin: "cell" | "bar";
  /** Положение курсора после программной вставки (ссылка из формулы). */
  caret?: number;
}

export type MoveDir = "down" | "right" | "up" | "left" | "none";

export interface EditApi {
  /** Положение курсора в редакторе (обновляют сами редакторы): нужно, чтобы вставить ссылку при указании мышью. */
  caret: { current: number };
  /** Начать правку активной ячейки; `text` — с чего начать (null — текущее содержимое). */
  begin: (text?: string | null, origin?: "cell" | "bar", mode?: "enter" | "edit") => void;
  set: (text: string, caret?: number) => void;
  /** Завершить правку и перейти по направлению. */
  commit: (dir?: MoveDir, opts?: { fill?: boolean; array?: boolean }) => Promise<void>;
  cancel: () => void;
}

/** Выбранный плавающий объект листа. */
export interface ObjSel {
  kind: "chart" | "image" | "shape" | "slicer";
  id: number;
}
