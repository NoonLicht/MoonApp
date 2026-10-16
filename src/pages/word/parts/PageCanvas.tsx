import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import type { WordDocs } from "@/pages/word/useWordDocs";
import type { WordState } from "@/api/apiWord";

/** Пункты страницы → CSS-пиксели при масштабе 100 %. */
const PX_PER_PT = 96 / 72;

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

export default function PageCanvas({
  docs,
  docId,
  state,
  zoom,
  focused,
  onFocusChange,
}: {
  docs: WordDocs;
  docId: string;
  state: WordState;
  zoom: number;
  focused: boolean;
  onFocusChange: (f: boolean) => void;
}) {
  const { t } = useI18n();
  const k = PX_PER_PT * zoom;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const renderScale = Math.min(3, Math.max(0.5, k * dpr));
  const input = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef<{ page: number; el: HTMLElement } | null>(null);
  const busyMove = useRef(false);
  const composing = useRef(false);

  const focusInput = useCallback(() => input.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    focusInput();
  }, [docId, focusInput]);

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
    dragging.current = { page, el };
    void docs.click(page, p.x, p.y, e.shiftKey, Math.min(3, e.detail || 1));
    e.preventDefault();
    focusInput();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragging.current;
    if (!d || busyMove.current) return;
    const p = toPt(e, d.el);
    busyMove.current = true;
    void docs.click(d.page, p.x, p.y, true, 1)?.finally(() => {
      busyMove.current = false;
    });
  };

  const endDrag = (): void => {
    dragging.current = null;
  };

  const onKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (composing.current || e.nativeEvent.isComposing || e.key === "Process") return;
    const mod = e.ctrlKey || e.metaKey;
    const lower = e.key.toLowerCase();
    // Буфер обмена идёт через браузер: ядро не видит системный буфер.
    if (mod && !e.altKey && (lower === "c" || lower === "x")) {
      e.preventDefault();
      const text = state.selection.text;
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* буфер недоступен */
        }
        if (lower === "x") void docs.key("Delete");
      }
      return;
    }
    if (mod && !e.altKey && lower === "v") {
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text) await pasteText(text);
      } catch {
        /* нет доступа к буферу */
      }
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
          const t = e.data;
          if (t) void docs.type(t);
          if (input.current) input.current.value = "";
        }}
        onPaste={(e) => {
          e.preventDefault();
          const t = e.clipboardData.getData("text/plain");
          if (t) void pasteText(t);
        }}
      />
      <div className="wd-pages">
        {state.pages.map((p, i) => {
          const w = p.w * k;
          const h = p.h * k;
          const rects = state.selection.rects.filter((r) => r.page === i);
          const caret = state.caret && state.caret.page === i ? state.caret : null;
          return (
            <div
              key={i}
              className="wd-page"
              style={{ width: w, height: h }}
              onPointerDown={(e) => onPointerDown(e, i)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
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
