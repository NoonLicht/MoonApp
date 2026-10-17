import type { SheetCx } from "@/pages/sheet/types";
import { kit } from "@/pages/word/ribbon/kit";

/** Короткие конструкторы для описания вкладок ленты «Таблиц». */
export const {
  cmd,
  fn,
  dlg,
  big,
  small,
  icon,
  menu,
  stack,
  row,
  custom,
  check,
  gap,
  it,
  itd,
  itf,
  sep,
  head,
  group,
  rawItem,
} = kit<SheetCx>();

export type { SheetCx };
