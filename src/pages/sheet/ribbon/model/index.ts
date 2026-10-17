import type { Tab } from "@/pages/word/ribbon/types";
import type { SheetCx } from "@/pages/sheet/types";
import { home } from "@/pages/sheet/ribbon/model/home";

export interface TabPrefs {
  draw: boolean;
}

/** Постоянные вкладки в порядке Excel. */
export function baseTabs(_prefs: TabPrefs): Tab<SheetCx>[] {
  return [home];
}

/** Вкладки, которые появляются по выделению (таблица, диаграмма, рисунок, сводная таблица…). */
export function contextTabs(_cx: SheetCx): Tab<SheetCx>[] {
  return [];
}
