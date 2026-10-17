import { home } from "@/pages/word/ribbon/model/home";
import { insert } from "@/pages/word/ribbon/model/insert";
import { design } from "@/pages/word/ribbon/model/design";
import { layout } from "@/pages/word/ribbon/model/layout";
import { references } from "@/pages/word/ribbon/model/references";
import { mailings } from "@/pages/word/ribbon/model/mailings";
import { review } from "@/pages/word/ribbon/model/review";
import { view } from "@/pages/word/ribbon/model/view";
import { developer, draw, help, hf } from "@/pages/word/ribbon/model/misc";
import {
  chartDesign,
  equationTab,
  outlining,
  pictureFormat,
  shapeFormat,
  smartArtDesign,
  tableDesign,
  tableLayout,
} from "@/pages/word/ribbon/model/context";
import type { Cx, Tab } from "@/pages/word/ribbon/types";

export interface TabPrefs {
  draw: boolean;
  developer: boolean;
}

/** Постоянные вкладки в порядке Word: Draw — после «Вставки», «Разработчик» — после «Вида» (оба по выбору). */
export function baseTabs(prefs: TabPrefs): Tab[] {
  const tabs: Tab[] = [home, insert];
  if (prefs.draw) tabs.push(draw);
  tabs.push(design, layout, references, mailings, review, view);
  if (prefs.developer) tabs.push(developer);
  tabs.push(help);
  return tabs;
}

/** Вкладки, которые появляются по выделению (таблица, рисунок, формула, колонтитул…). */
export function contextTabs(cx: Cx): Tab[] {
  const c = cx.s.ctx;
  const out: Tab[] = [];
  if (cx.s.view.mode === "outline") out.push(outlining);
  if (c.part === "header" || c.part === "footer") out.push(hf);
  if (c.table) out.push(tableDesign, tableLayout);
  const k = c.object?.kind;
  if (k === "picture") out.push(pictureFormat);
  if (k === "shape" || k === "textBox" || k === "group") out.push(shapeFormat);
  if (k === "chart") out.push(chartDesign);
  if (k === "smartArt") out.push(smartArtDesign);
  if (c.equation) out.push(equationTab);
  return out;
}

export const ALL_TABS = [
  home,
  insert,
  draw,
  design,
  layout,
  references,
  mailings,
  review,
  view,
  developer,
  help,
];
