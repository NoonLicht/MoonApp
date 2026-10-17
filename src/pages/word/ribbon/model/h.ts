import type { Act, Ctl, Cx, Group, Item, Params } from "@/pages/word/ribbon/types";
import type { IconName } from "@/pages/word/ribbon/icons";

/** Короткие конструкторы для описания вкладок ленты. */
export const cmd = (c: string, p?: Params): Act => ({ cmd: c, p });
export const fn = (f: (cx: Cx) => void): Act => ({ fn: f });
export const dlg = (name: string, p?: Params): Act => ({ fn: (cx) => cx.dialog(name, p) });

type Extra = {
  tip?: string;
  on?: (cx: Cx) => boolean;
  enabled?: (cx: Cx) => boolean;
};

export const big = (icon: IconName, label: string, act: Act, x: Extra = {}): Ctl => ({
  k: "big",
  icon,
  label,
  act,
  ...x,
});
export const small = (icon: IconName, label: string | undefined, act: Act, x: Extra = {}): Ctl => ({
  k: "small",
  icon,
  label,
  act,
  tip: x.tip ?? label,
  on: x.on,
  enabled: x.enabled,
});
/** Мелкая кнопка без подписи: подсказка обязательна. */
export const icon = (ic: IconName, tip: string, act: Act, x: Extra = {}): Ctl =>
  small(ic, undefined, act, { ...x, tip });

export const menu = (
  ic: IconName,
  label: string | undefined,
  items: Item[] | ((cx: Cx) => Item[]),
  x: {
    big?: boolean;
    tip?: string;
    split?: Act | ((cx: Cx) => Act);
    on?: (cx: Cx) => boolean;
    enabled?: (cx: Cx) => boolean;
    swatch?: (cx: Cx) => string | undefined;
  } = {},
): Ctl => ({ k: "menu", icon: ic, label, items, ...x, tip: x.tip ?? label });

export const stack = (...rows: Ctl[]): Ctl => ({ k: "stack", rows });
export const row = (...items: Ctl[]): Ctl => ({ k: "row", items });
export const custom = (id: string): Ctl => ({ k: "custom", id });
export const check = (
  label: string,
  on: (cx: Cx) => boolean,
  act: (cx: Cx, v: boolean) => void,
  enabled?: (cx: Cx) => boolean,
): Ctl => ({
  k: "check",
  label,
  on,
  act,
  enabled,
});
export const gap = (): Ctl => ({ k: "gap" });

export const it = (label: string, c: string, p?: Params, x: Partial<Item> = {}): Item => ({
  label,
  act: cmd(c, p),
  ...x,
});
export const itd = (label: string, name: string, p?: Params, x: Partial<Item> = {}): Item => ({
  label,
  act: dlg(name, p),
  ...x,
});
export const itf = (label: string, f: (cx: Cx) => void, x: Partial<Item> = {}): Item => ({
  label,
  act: fn(f),
  ...x,
});
export const sep: Item = { sep: true };
export const head = (label: string): Item => ({ head: label });

export const group = (
  id: string,
  label: string,
  items: Ctl[],
  x: { launcher?: Act; show?: (cx: Cx) => boolean } = {},
): Group => ({
  id,
  label,
  items,
  ...x,
});

/** Подпись-«как есть» (не английский ключ): имена шрифтов, числа. */
export const rawItem = (label: string, act: Act, x: Partial<Item> = {}): Item => ({
  label,
  act,
  raw: true,
  ...x,
});
