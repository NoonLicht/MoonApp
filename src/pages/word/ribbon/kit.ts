import type { Act, BaseCx, Ctl, Group, Item, Params } from "@/pages/word/ribbon/types";
import type { IconName } from "@/pages/word/ribbon/icons";

/**
 * Короткие конструкторы для описания вкладок ленты, привязанные к контексту страницы:
 * `kit<Cx>()` для «Документов», `kit<SheetCx>()` для «Таблиц».
 */
export function kit<C extends BaseCx>() {
  type Extra = {
    tip?: string;
    on?: (cx: C) => boolean;
    enabled?: (cx: C) => boolean;
  };

  const cmd = (c: string, p?: Params): Act<C> => ({ cmd: c, p });
  const fn = (f: (cx: C) => void): Act<C> => ({ fn: f });
  const dlg = (name: string, p?: Params): Act<C> => ({ fn: (cx) => cx.dialog(name, p) });

  const big = (icon: IconName, label: string, act: Act<C>, x: Extra = {}): Ctl<C> => ({
    k: "big",
    icon,
    label,
    act,
    ...x,
  });
  const small = (icon: IconName, label: string | undefined, act: Act<C>, x: Extra = {}): Ctl<C> => ({
    k: "small",
    icon,
    label,
    act,
    tip: x.tip ?? label,
    on: x.on,
    enabled: x.enabled,
  });
  /** Мелкая кнопка без подписи: подсказка обязательна. */
  const icon = (ic: IconName, tip: string, act: Act<C>, x: Extra = {}): Ctl<C> =>
    small(ic, undefined, act, { ...x, tip });

  const menu = (
    ic: IconName,
    label: string | undefined,
    items: Item<C>[] | ((cx: C) => Item<C>[]),
    x: {
      big?: boolean;
      tip?: string;
      split?: Act<C> | ((cx: C) => Act<C>);
      on?: (cx: C) => boolean;
      enabled?: (cx: C) => boolean;
      swatch?: (cx: C) => string | undefined;
    } = {},
  ): Ctl<C> => ({ k: "menu", icon: ic, label, items, ...x, tip: x.tip ?? label });

  const stack = (...rows: Ctl<C>[]): Ctl<C> => ({ k: "stack", rows });
  const row = (...items: Ctl<C>[]): Ctl<C> => ({ k: "row", items });
  const custom = (id: string): Ctl<C> => ({ k: "custom", id });
  const check = (
    label: string,
    on: (cx: C) => boolean,
    act: (cx: C, v: boolean) => void,
    enabled?: (cx: C) => boolean,
  ): Ctl<C> => ({ k: "check", label, on, act, enabled });
  const gap = (): Ctl<C> => ({ k: "gap" });

  const it = (label: string, c: string, p?: Params, x: Partial<Item<C>> = {}): Item<C> => ({
    label,
    act: cmd(c, p),
    ...x,
  });
  const itd = (label: string, name: string, p?: Params, x: Partial<Item<C>> = {}): Item<C> => ({
    label,
    act: dlg(name, p),
    ...x,
  });
  const itf = (label: string, f: (cx: C) => void, x: Partial<Item<C>> = {}): Item<C> => ({
    label,
    act: fn(f),
    ...x,
  });
  const sep: Item<C> = { sep: true };
  const head = (label: string): Item<C> => ({ head: label });

  const group = (
    id: string,
    label: string,
    items: Ctl<C>[],
    x: { launcher?: Act<C>; show?: (cx: C) => boolean } = {},
  ): Group<C> => ({ id, label, items, ...x });

  /** Подпись-«как есть» (не английский ключ): имена шрифтов, числа. */
  const rawItem = (label: string, act: Act<C>, x: Partial<Item<C>> = {}): Item<C> => ({
    label,
    act,
    raw: true,
    ...x,
  });

  return { cmd, fn, dlg, big, small, icon, menu, stack, row, custom, check, gap, it, itd, itf, sep, head, group, rawItem };
}
