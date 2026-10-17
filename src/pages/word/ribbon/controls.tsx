import { createContext, useContext, useState, type ComponentType } from "react";
import { ChevronDown } from "lucide-react";
import { ICONS } from "@/pages/word/ribbon/icons";
import { MenuPopup, doAct } from "@/pages/word/ribbon/Menu";
import { CUSTOM } from "@/pages/word/ribbon/custom";
import type { BaseCx, Ctl, Item } from "@/pages/word/ribbon/types";

/**
 * Собственные (нестандартные) элементы ленты по идентификатору: у каждой страницы свои.
 * По умолчанию — элементы «Документов»; «Таблицы» подставляют свои через провайдер.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CustomMap = Record<string, ComponentType<{ cx: any }>>;
export const CustomCtx = createContext<CustomMap>(CUSTOM);

/** Подпись: английский ключ → перевод; «\n» делит на две строки под значком. */
function Label({ text, cx }: { text: string; cx: BaseCx }) {
  const lines = cx.tw(text).split("\n");
  return (
    <span className="wd-lbl2">
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </span>
  );
}

function Btn<C extends BaseCx>({ c, cx }: { c: Extract<Ctl<C>, { k: "big" | "small" }>; cx: C }) {
  const Icon = ICONS[c.icon];
  const on = c.on?.(cx) ?? false;
  const enabled = c.enabled ? c.enabled(cx) : true;
  const title = cx.tw(c.tip ?? c.label ?? "").replace(/\n/g, " ");
  const big = c.k === "big";
  return (
    <button
      type="button"
      className={`wd-ctl ${big ? "wd-big" : "wd-small"}${on ? " on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={c.on ? on : undefined}
      disabled={!enabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => doAct(cx, c.act)}
    >
      <Icon size={big ? 26 : 15} strokeWidth={big ? 1.6 : 1.9} />
      {c.label && (big || c.label !== "") ? <Label text={c.label} cx={cx} /> : null}
    </button>
  );
}

function MenuBtn<C extends BaseCx>({ c, cx }: { c: Extract<Ctl<C>, { k: "menu" }>; cx: C }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const Icon = ICONS[c.icon];
  const on = c.on?.(cx) ?? false;
  const enabled = c.enabled ? c.enabled(cx) : true;
  const title = cx.tw(c.tip ?? c.label ?? "").replace(/\n/g, " ");
  const items: Item<C>[] = typeof c.items === "function" ? c.items(cx) : c.items;
  const swatch = c.swatch?.(cx);
  const split = typeof c.split === "function" ? c.split(cx) : c.split;
  const big = !!c.big;
  const open = (el: HTMLElement): void => setAnchor(el.getBoundingClientRect());
  const icon = (
    <span className="wd-ic">
      <Icon size={big ? 26 : 15} strokeWidth={big ? 1.6 : 1.9} />
      {swatch ? <i className="wd-bar" style={{ background: swatch }} /> : null}
    </span>
  );
  return (
    <>
      <span
        className={`wd-ctl-wrap ${big ? "wd-big-wrap" : "wd-small-wrap"}${split ? " split" : ""}`}
      >
        {split ? (
          <>
            <button
              type="button"
              className={`wd-ctl ${big ? "wd-big" : "wd-small"} wd-main${on ? " on" : ""}`}
              title={title}
              aria-label={title}
              disabled={!enabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => doAct(cx, split)}
            >
              {icon}
              {big && c.label ? <Label text={c.label} cx={cx} /> : null}
            </button>
            <button
              type="button"
              className="wd-ctl wd-arrow"
              title={title}
              aria-label={title}
              aria-haspopup="menu"
              aria-expanded={!!anchor}
              disabled={!enabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) =>
                anchor ? setAnchor(null) : open(e.currentTarget.parentElement ?? e.currentTarget)
              }
            >
              <ChevronDown size={10} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`wd-ctl ${big ? "wd-big" : "wd-small wd-menu-btn"}${on ? " on" : ""}`}
            title={title}
            aria-label={title}
            aria-haspopup="menu"
            aria-expanded={!!anchor}
            disabled={!enabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => (anchor ? setAnchor(null) : open(e.currentTarget))}
          >
            {icon}
            {c.label ? <Label text={c.label} cx={cx} /> : null}
            {big ? (
              <ChevronDown size={9} className="wd-big-chev" />
            ) : (
              <ChevronDown size={9} className="wd-chev" />
            )}
          </button>
        )}
      </span>
      {anchor ? (
        <MenuPopup items={items} cx={cx} anchor={anchor} onClose={() => setAnchor(null)} />
      ) : null}
    </>
  );
}

export function Control<C extends BaseCx>({ c, cx }: { c: Ctl<C>; cx: C }) {
  const customs = useContext(CustomCtx);
  switch (c.k) {
    case "big":
    case "small":
      return <Btn c={c} cx={cx} />;
    case "menu":
      return <MenuBtn c={c} cx={cx} />;
    case "stack":
      return (
        <div className="wd-stack">
          {c.rows.map((r, i) => (
            <Control key={i} c={r} cx={cx} />
          ))}
        </div>
      );
    case "row":
      return (
        <div className="wd-rowc">
          {c.items.map((r, i) => (
            <Control key={i} c={r} cx={cx} />
          ))}
        </div>
      );
    case "check": {
      const on = c.on(cx);
      const enabled = c.enabled ? c.enabled(cx) : true;
      return (
        <label className={`wd-check${enabled ? "" : " off"}`}>
          <input
            type="checkbox"
            checked={on}
            disabled={!enabled}
            onChange={(e) => c.act(cx, e.target.checked)}
          />
          <span>{cx.tw(c.label)}</span>
        </label>
      );
    }
    case "custom": {
      const Cmp = customs[c.id];
      return Cmp ? <Cmp cx={cx} /> : null;
    }
    case "gap":
      return <span className="wd-gap" />;
  }
}
