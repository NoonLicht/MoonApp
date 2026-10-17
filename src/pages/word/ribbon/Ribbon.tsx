import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { Control } from "@/pages/word/ribbon/controls";
import { doAct } from "@/pages/word/ribbon/Menu";
import { baseTabs, contextTabs, type TabPrefs } from "@/pages/word/ribbon/model";
import type { Cx, Group, Tab } from "@/pages/word/ribbon/types";

function GroupView({ g, cx }: { g: Group; cx: Cx }) {
  return (
    <div className="wd-group" data-group={g.id}>
      <div className="wd-group-body">
        {g.items.map((c, i) => (
          <Control key={i} c={c} cx={cx} />
        ))}
      </div>
      <div className="wd-group-name">
        <span>{cx.tw(g.label)}</span>
        {g.launcher ? (
          <button
            type="button"
            className="wd-launcher"
            aria-label={cx.tw(g.label)}
            title={cx.tw(g.label)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => doAct(cx, g.launcher)}
          >
            <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
              <path
                d="M1 1H5M1 1V5M8 8L3.5 3.5M8 8H5M8 8V5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Лента: вкладки (постоянные + контекстные по выделению) и группы выбранной вкладки.
 * Содержимое задаёт модель в ribbon/model; здесь только раскладка.
 */
export default function Ribbon({
  cx,
  prefs,
  tab,
  setTab,
  collapsed,
  setCollapsed,
}: {
  cx: Cx;
  prefs: TabPrefs;
  tab: string;
  setTab: (t: string) => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
}) {
  const base = baseTabs(prefs);
  const ctxTabs = contextTabs(cx);
  const all: Tab[] = [...base, ...ctxTabs];
  const current = all.find((t) => t.id === tab) ?? base[0];
  const [peek, setPeek] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const showBodyFlag = !collapsed || peek;
  const bar = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  // Лента шире окна: стрелки по краям и прокрутка колёсиком, как в Word при узком окне.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const calc = (): void => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdge((p) => (p.left === left && p.right === right ? p : { left, right }));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    el.addEventListener("scroll", calc);
    const wheel = (e: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaX || e.deltaY;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", calc);
      el.removeEventListener("wheel", wheel);
    };
    // перенавешиваем при смене вкладки/содержимого
  }, [showBodyFlag, current.id, cx.lang]);

  // Свёрнутая лента показывается поверх по клику на вкладку и прячется по клику вне её.
  useEffect(() => {
    if (!peek) return;
    const down = (e: MouseEvent): void => {
      if (
        root.current?.contains(e.target as Node) ||
        (e.target as HTMLElement).closest?.(".wd-menu")
      )
        return;
      setPeek(false);
    };
    document.addEventListener("mousedown", down, true);
    return () => document.removeEventListener("mousedown", down, true);
  }, [peek]);

  const groups = (
    typeof current.groups === "function" ? current.groups(cx) : current.groups
  ).filter((g) => (g.show ? g.show(cx) : true));
  const showBody = !collapsed || peek;

  return (
    <div className={`wd-ribbon${collapsed ? " collapsed" : ""}`} ref={root}>
      <div className="wd-tabs" role="tablist">
        <button type="button" className="wd-tab wd-file" onClick={() => cx.ui.backstage()}>
          {cx.tw("File")}
        </button>
        {all.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={current.id === t.id}
            className={`wd-tab${current.id === t.id ? " active" : ""}${t.contextual ? " contextual" : ""}`}
            onClick={() => {
              setTab(t.id);
              if (collapsed) setPeek(true);
            }}
            onDoubleClick={() => {
              setCollapsed(!collapsed);
              setPeek(false);
            }}
          >
            {cx.tw(t.label)}
          </button>
        ))}
        <span className="wd-tabs-fill" />
        <button
          type="button"
          className="wd-collapse"
          title={cx.tw("Collapse the Ribbon")}
          aria-label={cx.tw("Collapse the Ribbon")}
          onClick={() => {
            setCollapsed(!collapsed);
            setPeek(false);
          }}
        >
          <ChevronUp size={14} style={{ transform: collapsed ? "rotate(180deg)" : undefined }} />
        </button>
      </div>
      {showBody ? (
        <div className={`wd-bar-wrap${collapsed ? " peek" : ""}`}>
          <div className="wd-bar2" role="toolbar" ref={bar}>
            {groups.map((g) => (
              <GroupView key={g.id} g={g} cx={cx} />
            ))}
          </div>
          {edge.left ? (
            <button
              type="button"
              className="wd-edge left"
              aria-label="‹"
              onClick={() => bar.current?.scrollBy({ left: -320, behavior: "smooth" })}
            >
              <ChevronLeft size={14} />
            </button>
          ) : null}
          {edge.right ? (
            <button
              type="button"
              className="wd-edge right"
              aria-label="›"
              onClick={() => bar.current?.scrollBy({ left: 320, behavior: "smooth" })}
            >
              <ChevronRight size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
