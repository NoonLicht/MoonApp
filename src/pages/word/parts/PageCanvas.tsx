import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import type { WordDocs } from "@/pages/word/useWordDocs";
import type { WordState } from "@/api/apiWord";
import type { Cx } from "@/pages/word/ribbon/types";
import { openContext } from "@/pages/word/parts/contextMenu";
import { rgbHex } from "@/pages/word/lib";

/** Пункты страницы → CSS-пиксели при масштабе 100 %. */
export const PX_PER_PT = 96 / 72;

/**
 * Одна страница: PNG от ядра (картинка подменяется, когда догрузилась новая версия — без мигания),
 * поверх — выделение и каретка. Страницы вне видимой области не запрашиваются.
 */
function PageImage({
  docId,
  index,
  rev,
  scale,
  width,
  height,
}: {
  docId: string;
  index: number;
  rev: number;
  scale: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(index < 2);
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => setVisible(e.some((x) => x.isIntersecting)), {
      rootMargin: "900px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    // Небольшая задержка: во время набора ревизия растёт на каждой букве, рисуем последнюю.
    const timer = setTimeout(() => {
      api
        .wordPage(docId, index + 1, scale)
        .then((blob) => {
          if (!alive) return;
          const next = URL.createObjectURL(blob);
          const prev = urlRef.current;
          urlRef.current = next;
          setUrl(next);
          if (prev) setTimeout(() => URL.revokeObjectURL(prev), 500);
        })
        .catch(() => undefined);
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [visible, docId, index, rev, scale]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return (
    <div ref={ref} className="wd-img" style={{ width, height }}>
      {url && <img src={url} alt="" draggable={false} width={width} height={height} />}
    </div>
  );
}

type Handle = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
const HANDLES: Handle[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
];
const CURSORS: Record<string, string> = {
  "-1,-1": "nwse-resize",
  "0,-1": "ns-resize",
  "1,-1": "nesw-resize",
  "1,0": "ew-resize",
  "1,1": "nwse-resize",
  "0,1": "ns-resize",
  "-1,1": "nesw-resize",
  "-1,0": "ew-resize",
};

interface ObjDrag {
  mode: "move" | "resize" | "rotate";
  handle: Handle;
  page: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  w: number;
  h: number;
  deg: number;
  cur: { x: number; y: number; w: number; h: number; deg: number };
}

export default function PageCanvas({
  docs,
  docId,
  state,
  zoom,
  focused,
  onFocusChange,
  cx,
  areaRef,
}: {
  docs: WordDocs;
  docId: string;
  state: WordState;
  zoom: number;
  focused: boolean;
  onFocusChange: (f: boolean) => void;
  cx: Cx;
  areaRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const k = PX_PER_PT * zoom;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const renderScale = Math.min(3, Math.max(0.5, k * dpr));
  const input = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef<{ page: number; el: HTMLElement } | null>(null);
  const busyMove = useRef(false);
  const composing = useRef(false);
  const [objDrag, setObjDrag] = useState<ObjDrag | null>(null);
  const [ink, setInk] = useState<{ page: number; pts: [number, number][] } | null>(null);
  const [band, setBand] = useState<{
    page: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const draw = state.view.draw;
  const drawing = ["pen", "pencil", "highlighter", "eraser", "lasso"].includes(draw.mode);

  const focusInput = useCallback(() => input.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    focusInput();
  }, [docId, focusInput]);

  /** Каретка не должна уходить за край окна: прокручиваем к ней при наборе и навигации. */
  const scrollToCaret = useCallback(
    (force = false) => {
      const area = areaRef.current;
      const c = state.caret;
      if (!area || !c) return;
      const pageEl = area.querySelectorAll<HTMLElement>(".wd-page")[c.page];
      if (!pageEl) return;
      const top = pageEl.offsetTop + c.top * k;
      const bottom = top + c.height * k;
      const margin = 48;
      if (
        force ||
        top < area.scrollTop + margin ||
        bottom > area.scrollTop + area.clientHeight - margin
      ) {
        area.scrollTo({ top: Math.max(0, top - area.clientHeight / 3), behavior: "auto" });
      }
    },
    [areaRef, state.caret, k],
  );
  const lastCaret = useRef("");
  useEffect(() => {
    const c = state.caret;
    const key = c ? `${c.page}:${Math.round(c.x)}:${Math.round(c.top)}` : "";
    if (key && key !== lastCaret.current && !dragging.current) scrollToCaret();
    lastCaret.current = key;
  }, [state.caret, scrollToCaret]);
  useEffect(() => {
    const onPage = (e: Event): void => {
      const i = (e as CustomEvent<number>).detail;
      const el = areaRef.current?.querySelectorAll<HTMLElement>(".wd-page")[i];
      if (el && areaRef.current)
        areaRef.current.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    };
    const onCaret = (): void => scrollToCaret(true);
    window.addEventListener("wd-scroll-page", onPage);
    window.addEventListener("wd-scroll-caret", onCaret);
    return () => {
      window.removeEventListener("wd-scroll-page", onPage);
      window.removeEventListener("wd-scroll-caret", onCaret);
    };
  }, [areaRef, scrollToCaret]);

  const toPt = (
    e: { clientX: number; clientY: number },
    el: HTMLElement,
  ): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, page: number): void => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const p = toPt(e, el);
    el.setPointerCapture(e.pointerId);
    // Режимы таблицы: «Нарисовать таблицу» тянет прямоугольник, «Ластик» стирает границы под указателем.
    if (cx.ui.tool) {
      e.preventDefault();
      dragging.current = { page, el };
      setBand({ page, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      if (cx.ui.tool === "eraseTable") void docs.run("table.eraser", { page, x: p.x, y: p.y });
      return;
    }
    if (drawing) {
      e.preventDefault();
      if (draw.mode === "eraser") {
        void docs.run("draw.erase", { page, x: p.x, y: p.y });
        setInk({ page, pts: [[p.x, p.y]] });
      } else setInk({ page, pts: [[p.x, p.y]] });
      dragging.current = { page, el };
      return;
    }
    // Рамка выбранного плавающего объекта: нажатие внутри неё — перенос.
    const o = state.ctx.object;
    if (
      o?.rect &&
      o.rect.page === page &&
      o.rect.floating &&
      p.x >= o.rect.x &&
      p.x <= o.rect.x + o.rect.w &&
      p.y >= o.rect.y &&
      p.y <= o.rect.y + o.rect.h
    ) {
      e.preventDefault();
      setObjDrag({
        mode: "move",
        handle: { x: 0, y: 0 },
        page,
        startX: p.x,
        startY: p.y,
        x: o.rect.x,
        y: o.rect.y,
        w: o.rect.w,
        h: o.rect.h,
        deg: o.deg,
        cur: { x: o.rect.x, y: o.rect.y, w: o.rect.w, h: o.rect.h, deg: o.deg },
      });
      dragging.current = { page, el };
      focusInput();
      return;
    }
    dragging.current = { page, el };
    void docs.click(page, p.x, p.y, e.shiftKey, Math.min(3, e.detail || 1));
    e.preventDefault();
    focusInput();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragging.current;
    if (!d) return;
    const p = toPt(e, d.el);
    if (band) {
      setBand({ ...band, x1: p.x, y1: p.y });
      if (cx.ui.tool === "eraseTable" && !busyMove.current) {
        busyMove.current = true;
        void docs
          .run("table.eraser", { page: d.page, x: p.x, y: p.y })
          ?.finally(() => (busyMove.current = false));
      }
      return;
    }
    if (ink) {
      if (draw.mode === "eraser") {
        if (!busyMove.current) {
          busyMove.current = true;
          void docs
            .run("draw.erase", { page: d.page, x: p.x, y: p.y })
            ?.finally(() => (busyMove.current = false));
        }
      }
      setInk((s) => (s ? { ...s, pts: [...s.pts, [p.x, p.y]] } : s));
      return;
    }
    if (objDrag) {
      const dx = p.x - objDrag.startX;
      const dy = p.y - objDrag.startY;
      setObjDrag({ ...objDrag, cur: { ...objDrag.cur, x: objDrag.x + dx, y: objDrag.y + dy } });
      return;
    }
    if (busyMove.current) return;
    busyMove.current = true;
    void docs.click(d.page, p.x, p.y, true, 1)?.finally(() => {
      busyMove.current = false;
    });
  };

  const endDrag = (): void => {
    const d = dragging.current;
    dragging.current = null;
    if (band && d) {
      if (
        cx.ui.tool === "drawTable" &&
        Math.abs(band.x1 - band.x0) > 8 &&
        Math.abs(band.y1 - band.y0) > 8
      ) {
        void docs.run("table.draw", {
          page: band.page,
          x0: band.x0,
          y0: band.y0,
          x1: band.x1,
          y1: band.y1,
        });
      }
      setBand(null);
      return;
    }
    if (ink && d) {
      if (draw.mode === "lasso") void docs.run("draw.lasso", { page: d.page, points: ink.pts });
      else if (draw.mode !== "eraser" && ink.pts.length > 1)
        void docs.run("draw.stroke", {
          page: d.page,
          points: ink.pts.slice(0, 5000),
          tool: draw.mode,
        });
      setInk(null);
    }
    if (objDrag) {
      const c = objDrag.cur;
      if (objDrag.mode === "move")
        void docs.run("arrange.bounds", { x: c.x, y: c.y, page: objDrag.page });
      else if (objDrag.mode === "rotate")
        void docs.run("arrange.rotation", { degrees: Math.round(c.deg) });
      else {
        const o = state.ctx.object;
        if (o?.rect?.floating)
          void docs.run("arrange.bounds", {
            x: c.x,
            y: c.y,
            width: c.w,
            height: c.h,
            page: objDrag.page,
          });
        else if (o?.kind === "picture")
          void docs.run("picture.size", { width: c.w, height: c.h, lockAspect: false });
        else void docs.run("arrange.bounds", { width: c.w, height: c.h });
      }
      setObjDrag(null);
    }
  };

  /** Ручка рамки объекта: изменение размера (углы и стороны) или поворот. */
  const beginHandle = (e: React.PointerEvent, page: number, handle: Handle | "rotate"): void => {
    const o = state.ctx.object;
    if (!o?.rect) return;
    e.stopPropagation();
    e.preventDefault();
    const pageEl = (e.currentTarget as HTMLElement).closest<HTMLElement>(".wd-page");
    if (!pageEl) return;
    pageEl.setPointerCapture(e.pointerId);
    const p = toPt(e, pageEl);
    dragging.current = { page, el: pageEl };
    const r = o.rect;
    setObjDrag({
      mode: handle === "rotate" ? "rotate" : "resize",
      handle: handle === "rotate" ? { x: 0, y: 0 } : handle,
      page,
      startX: p.x,
      startY: p.y,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      deg: o.deg,
      cur: { x: r.x, y: r.y, w: r.w, h: r.h, deg: o.deg },
    });
  };

  useEffect(() => {
    if (!objDrag || objDrag.mode === "move") return;
    const move = (e: PointerEvent): void => {
      const pageEl = areaRef.current?.querySelectorAll<HTMLElement>(".wd-page")[objDrag.page];
      if (!pageEl) return;
      const p = toPt(e, pageEl);
      if (objDrag.mode === "rotate") {
        const cxp = objDrag.x + objDrag.w / 2;
        const cyp = objDrag.y + objDrag.h / 2;
        let deg = (Math.atan2(p.y - cyp, p.x - cxp) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        setObjDrag((d) => (d ? { ...d, cur: { ...d.cur, deg } } : d));
        return;
      }
      const dx = p.x - objDrag.startX;
      const dy = p.y - objDrag.startY;
      const { handle } = objDrag;
      let { x, y, w, h } = { x: objDrag.x, y: objDrag.y, w: objDrag.w, h: objDrag.h };
      if (handle.x === 1) w = Math.max(6, objDrag.w + dx);
      if (handle.x === -1) {
        w = Math.max(6, objDrag.w - dx);
        x = objDrag.x + objDrag.w - w;
      }
      if (handle.y === 1) h = Math.max(6, objDrag.h + dy);
      if (handle.y === -1) {
        h = Math.max(6, objDrag.h - dy);
        y = objDrag.y + objDrag.h - h;
      }
      // Углы рисунка сохраняют пропорции, как в Word (без Shift).
      if (handle.x !== 0 && handle.y !== 0 && state.ctx.object?.kind === "picture" && !e.shiftKey) {
        const ratio = objDrag.w / objDrag.h;
        h = w / ratio;
        if (handle.y === -1) y = objDrag.y + objDrag.h - h;
      }
      setObjDrag((d) => (d ? { ...d, cur: { x, y, w, h, deg: d.deg } } : d));
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
    // toPt зависит только от k
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objDrag?.mode, objDrag?.page, objDrag?.startX, objDrag?.startY, k, areaRef]);

  const onKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (composing.current || e.nativeEvent.isComposing || e.key === "Process") return;
    const mod = e.ctrlKey || e.metaKey;
    const lower = e.key.toLowerCase();
    // Буфер обмена идёт через браузер: ядро не видит системный буфер.
    if (mod && !e.altKey && (lower === "c" || lower === "x")) {
      e.preventDefault();
      void docs.copy(lower === "x");
      return;
    }
    if (mod && !e.altKey && lower === "v") {
      e.preventDefault();
      void docs.paste(e.shiftKey ? "text" : "default");
      return;
    }
    if (e.key === "Escape" && cx.ui.tool) {
      e.preventDefault();
      cx.ui.setTool(null);
      return;
    }
    // Печатный символ (в том числе AltGr = Ctrl+Alt) — вводим как текст.
    const printable = e.key.length === 1 && (!mod || (e.ctrlKey && e.altKey));
    if (printable) {
      e.preventDefault();
      void docs.type(e.key);
      return;
    }
    const named = [
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Escape",
      "Insert",
    ];
    if (named.includes(e.key) || (mod && e.key.length === 1) || /^F\d+$/.test(e.key)) {
      e.preventDefault();
      void docs.key(e.key, { ctrl: mod, alt: e.altKey, shift: e.shiftKey });
    }
  };

  const pasteText = async (text: string): Promise<void> => {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await docs.key("Enter");
      if (lines[i]) await docs.type(lines[i]);
    }
  };

  const onContext = async (e: React.MouseEvent, page: number): Promise<void> => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const p = toPt(e, el);
    const { clientX, clientY } = e;
    if (
      state.selection.collapsed ||
      !state.selection.rects.some(
        (r) => r.page === page && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h,
      )
    ) {
      await docs.click(page, p.x, p.y, false, 1);
    }
    openContext(cx, clientX, clientY);
    focusInput();
  };

  const multi = state.view.multiPage || state.view.fit === "multiplePages";
  const o = state.ctx.object;
  return (
    <div className="wd-canvas" onMouseDown={() => focusInput()}>
      <textarea
        ref={input}
        className="wd-input"
        aria-label={t("word.editorLabel")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(e) => void onKeyDown(e)}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        // Текст, пришедший не через keydown (экранная клавиатура, диктовка, автозамена): забираем из поля.
        onInput={(e) => {
          if (composing.current) return;
          const el = e.currentTarget;
          const text = el.value;
          el.value = "";
          if (text) void pasteText(text);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          const txt = e.data;
          if (txt) void docs.type(txt);
          if (input.current) input.current.value = "";
        }}
        onPaste={(e) => {
          e.preventDefault();
          void docs.paste();
        }}
      />
      <div className={`wd-pages${multi ? " multi" : ""}`}>
        {state.pages.map((p, i) => {
          const w = p.w * k;
          const h = p.h * k;
          const rects = state.ctx.object ? [] : state.selection.rects.filter((r) => r.page === i);
          const caret = state.caret && state.caret.page === i ? state.caret : null;
          const frame =
            o?.rect && o.rect.page === i
              ? objDrag && objDrag.page === i
                ? objDrag.cur
                : { x: o.rect.x, y: o.rect.y, w: o.rect.w, h: o.rect.h, deg: o.deg }
              : null;
          const penColor =
            draw.mode === "highlighter"
              ? draw.highlighter
              : draw.mode === "pencil"
                ? draw.pencil
                : draw.pen;
          return (
            <div
              key={i}
              className={`wd-page${drawing || cx.ui.tool ? " draw-mode" : ""}`}
              style={{ width: w, height: h }}
              onPointerDown={(e) => onPointerDown(e, i)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onContextMenu={(e) => void onContext(e, i)}
            >
              <PageImage
                docId={docId}
                index={i}
                rev={state.rev}
                scale={renderScale}
                width={w}
                height={h}
              />
              {rects.map((r, j) => (
                <div
                  key={j}
                  className="wd-sel"
                  style={{ left: r.x * k, top: r.y * k, width: r.w * k, height: r.h * k }}
                />
              ))}
              {caret && state.selection.collapsed && (
                <div
                  className={`wd-caret${focused ? " on" : ""}`}
                  style={{ left: caret.x * k - 0.5, top: caret.top * k, height: caret.height * k }}
                />
              )}
              {frame ? (
                <div
                  className="wd-objframe"
                  style={{
                    left: frame.x * k,
                    top: frame.y * k,
                    width: frame.w * k,
                    height: frame.h * k,
                    transform: frame.deg ? `rotate(${frame.deg}deg)` : undefined,
                  }}
                >
                  {o?.kind !== "chart" && o?.kind !== "smartArt"
                    ? HANDLES.map((hd) => (
                        <i
                          key={`${hd.x},${hd.y}`}
                          className="wd-handle"
                          style={{
                            left: `${(hd.x + 1) * 50}%`,
                            top: `${(hd.y + 1) * 50}%`,
                            cursor: CURSORS[`${hd.x},${hd.y}`],
                          }}
                          onPointerDown={(e) => beginHandle(e, i, hd)}
                        />
                      ))
                    : null}
                  {o?.kind !== "chart" && o?.kind !== "smartArt" ? (
                    <i
                      className="wd-handle rot"
                      style={{ left: "50%", top: -22 }}
                      onPointerDown={(e) => beginHandle(e, i, "rotate")}
                    />
                  ) : null}
                </div>
              ) : null}
              {band && band.page === i && cx.ui.tool === "drawTable" ? (
                <div
                  className="wd-band"
                  style={{
                    left: Math.min(band.x0, band.x1) * k,
                    top: Math.min(band.y0, band.y1) * k,
                    width: Math.abs(band.x1 - band.x0) * k,
                    height: Math.abs(band.y1 - band.y0) * k,
                  }}
                />
              ) : null}
              {ink && ink.page === i ? (
                <svg className="wd-ink" width={w} height={h}>
                  <polyline
                    points={ink.pts.map(([x, y]) => `${x * k},${y * k}`).join(" ")}
                    fill="none"
                    stroke={
                      draw.mode === "lasso"
                        ? "#2f7cf6"
                        : draw.mode === "eraser"
                          ? "#999"
                          : `#${rgbHex(penColor.color)}`
                    }
                    strokeWidth={draw.mode === "lasso" ? 1.5 : Math.max(1, penColor.width * k)}
                    strokeDasharray={draw.mode === "lasso" ? "4 3" : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={draw.mode === "highlighter" ? 0.4 : 1}
                  />
                </svg>
              ) : null}
              <div className="wd-pageno">
                {p.number} / {state.pages.length}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
