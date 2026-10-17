import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { lenUnit } from "@/pages/word/lib";
import type { Cx } from "@/pages/word/ribbon/types";

type Drag = {
  kind: "first" | "hang" | "right";
  startX: number;
  left: number;
  first: number;
  right: number;
} | null;

const TAB_GLYPH: Record<string, string> = {
  left: "L",
  center: "⊥",
  right: "⅃",
  decimal: "⊥.",
  bar: "|",
};

/**
 * Горизонтальная линейка над страницами: поля, деления, отступы абзаца и позиции табуляции.
 * Маркеры тянутся мышью; результат применяется командами para.indents / para.tabs.
 */
export default function Ruler({ cx, k, area }: { cx: Cx; k: number; area: HTMLDivElement | null }) {
  const root = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<{ left: number; width: number } | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [live, setLive] = useState<{ left: number; first: number; right: number } | null>(null);
  const s = cx.s;
  const pageIdx = Math.min(s.caret?.page ?? 0, s.pages.length - 1);
  const page = s.pages[pageIdx];
  const para = s.paraResolved;
  const u = lenUnit(cx.lang);

  // Горизонтальное положение страницы в окне прокрутки: линейка выровнена по ней.
  useLayoutEffect(() => {
    const calc = (): void => {
      const el = area?.querySelectorAll<HTMLElement>(".wd-page")[pageIdx];
      const r0 = root.current?.getBoundingClientRect();
      if (!el || !r0) return setGeo(null);
      const r = el.getBoundingClientRect();
      setGeo({ left: r.left - r0.left, width: r.width });
    };
    calc();
    const ro = new ResizeObserver(calc);
    if (area) ro.observe(area);
    area?.addEventListener("scroll", calc);
    window.addEventListener("resize", calc);
    return () => {
      ro.disconnect();
      area?.removeEventListener("scroll", calc);
      window.removeEventListener("resize", calc);
    };
  }, [area, pageIdx, k, s.pages.length, page?.w]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent): void => {
      const dpt = (e.clientX - drag.startX) / k;
      let { left, first, right } = drag;
      if (drag.kind === "first") first = Math.round(drag.first + dpt);
      else if (drag.kind === "hang") {
        const abs = drag.left + drag.first;
        left = Math.max(0, Math.round(drag.left + dpt));
        first = abs - left;
      } else right = Math.max(0, Math.round(drag.right - dpt));
      setLive({ left, first, right });
    };
    const up = (): void => {
      if (live)
        cx.run("para.indents", { left: live.left, right: live.right, firstLine: live.first });
      setDrag(null);
      setLive(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, live, k, cx]);

  if (!geo || !page) return <div className="wd-ruler" ref={root} />;
  const x0 = geo.left + page.body.x * k;
  const bodyW = page.body.w * k;
  const L = live?.left ?? para?.indentLeft ?? 0;
  const F = live?.first ?? para?.indentFirst ?? 0;
  const R = live?.right ?? para?.indentRight ?? 0;
  const tickPt = u.ptPer / 2;
  const ticks: { x: number; n: number; big: boolean }[] = [];
  for (
    let i = -Math.floor(page.body.x / tickPt);
    x0 + i * tickPt * k <= geo.left + geo.width + 1;
    i++
  ) {
    if (x0 + i * tickPt * k < geo.left - 1) continue;
    ticks.push({ x: x0 + i * tickPt * k, n: i / 2, big: i % 2 === 0 });
  }
  const at = (pt: number): number => x0 + pt * k;
  const begin = (kind: "first" | "hang" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    setDrag({
      kind,
      startX: e.clientX,
      left: para?.indentLeft ?? 0,
      first: para?.indentFirst ?? 0,
      right: para?.indentRight ?? 0,
    });
  };
  return (
    <div
      className="wd-ruler"
      ref={root}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".wd-r-ind, .wd-r-tab")) return;
        cx.dialog("paragraph");
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".wd-r-ind, .wd-r-tab")) return;
        const rr = root.current?.getBoundingClientRect();
        if (!rr) return;
        const pt = (e.clientX - rr.left - x0) / k;
        if (pt > 0 && pt < page.body.w)
          cx.run("para.tabs", { set: [{ pos: Math.round(pt), align: "left" }] });
      }}
    >
      <div className="wd-r-page" style={{ left: geo.left, width: geo.width }} />
      <div className="wd-r-margin" style={{ left: geo.left, width: page.body.x * k }} />
      <div
        className="wd-r-margin"
        style={{ left: x0 + bodyW, width: geo.width - page.body.x * k - bodyW }}
      />
      {ticks.map((t, i) => (
        <span key={i}>
          <i className={`wd-r-tick${t.big ? " big" : ""}`} style={{ left: t.x }} />
          {t.big && t.n !== 0 ? (
            <span className="wd-r-num" style={{ left: t.x }}>
              {Math.abs(t.n)}
            </span>
          ) : null}
        </span>
      ))}
      {(para?.tabs ?? []).map((t, i) => (
        <span
          key={i}
          className="wd-r-tab"
          title={cx.tw("Tabs")}
          style={{ left: at(t.pos) }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            cx.run("para.tabs", { clear: [t.pos] });
          }}
        >
          {TAB_GLYPH[t.align ?? "left"] ?? "L"}
        </span>
      ))}
      <i
        className="wd-r-ind first"
        title={cx.tw("First line")}
        style={{ left: at(L + F) - 5 }}
        onPointerDown={begin("first")}
      />
      <i
        className="wd-r-ind hang"
        title={cx.tw("Hanging")}
        style={{ left: at(L) - 5 }}
        onPointerDown={begin("hang")}
      />
      <i
        className="wd-r-ind hang"
        title={cx.tw("Right:")}
        style={{ left: x0 + bodyW - R * k - 5 }}
        onPointerDown={begin("right")}
      />
    </div>
  );
}
