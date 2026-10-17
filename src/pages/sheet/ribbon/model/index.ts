import type { Tab } from "@/pages/word/ribbon/types";
import type { SheetCx } from "@/pages/sheet/types";
import { home } from "@/pages/sheet/ribbon/model/home";
import { insert } from "@/pages/sheet/ribbon/model/insert";
import { pageLayout } from "@/pages/sheet/ribbon/model/layout";
import { formulas } from "@/pages/sheet/ribbon/model/formulas";
import { data } from "@/pages/sheet/ribbon/model/data";
import { review } from "@/pages/sheet/ribbon/model/review";
import { view } from "@/pages/sheet/ribbon/model/view";
import { automate, draw, help } from "@/pages/sheet/ribbon/model/misc";
import {
  chartDesign,
  chartFormat,
  pictureFormat,
  pivotAnalyze,
  pivotDesign,
  shapeFormat,
  slicerTab,
  tableDesign,
} from "@/pages/sheet/ribbon/model/context";

export interface TabPrefs {
  draw: boolean;
}

/** Все постоянные вкладки в порядке Excel (для проверок). */
export const ALL_TABS: Tab<SheetCx>[] = [home, insert, draw, pageLayout, formulas, data, review, view, automate, help];

/** Постоянные вкладки в порядке Excel: «Рисование» — по выбору в параметрах. */
export function baseTabs(prefs: TabPrefs): Tab<SheetCx>[] {
  const tabs: Tab<SheetCx>[] = [home, insert];
  if (prefs.draw) tabs.push(draw);
  tabs.push(pageLayout, formulas, data, review, view, automate, help);
  return tabs;
}

/** Вкладки, которые появляются по выделению (таблица, диаграмма, рисунок, фигура, срез, сводная таблица). */
export function contextTabs(cx: SheetCx): Tab<SheetCx>[] {
  const out: Tab<SheetCx>[] = [];
  const o = cx.ui.selObj;
  if (o?.kind === "chart") out.push(chartDesign, chartFormat);
  else if (o?.kind === "image") out.push(pictureFormat);
  else if (o?.kind === "shape") out.push(shapeFormat);
  else if (o?.kind === "slicer") out.push(slicerTab);
  else {
    if (cx.s.ctx.pivot) out.push(pivotAnalyze, pivotDesign);
    if (cx.s.ctx.table) out.push(tableDesign);
  }
  return out;
}
