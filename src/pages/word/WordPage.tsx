import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FolderOpen, Pause, Play, Square, X } from "lucide-react";
import { api } from "@/api/client";
import { Glass, Btn, EmptyHint, SectionHead } from "@/components/ui";
import { usePageBusy } from "@/components/Toolbar";
import { useI18n } from "@/app/i18n";
import { useTw } from "@/pages/word/i18n/useTw";
import { useWordDocs } from "@/pages/word/useWordDocs";
import Ribbon from "@/pages/word/ribbon/Ribbon";
import PageCanvas, { PX_PER_PT } from "@/pages/word/parts/PageCanvas";
import { ContextLayer } from "@/pages/word/parts/contextMenu";
import { PaneHost } from "@/pages/word/panes/Panes";
import DialogHost, { type OpenDialog } from "@/pages/word/dialogs/registry";
import Backstage, { type BackstagePage } from "@/pages/word/Backstage";
import Ruler from "@/pages/word/Ruler";
import { StatusBar, TitleBar } from "@/pages/word/chrome";
import { STYLES_CHANGED } from "@/pages/word/ribbon/custom";
import { LANGUAGES } from "@/pages/word/ribbon/model/review";
import { fileToBase64 } from "@/pages/word/lib";
import { baseTabs, contextTabs, type TabPrefs } from "@/pages/word/ribbon/model";
import type { Cx, PaneName, Params } from "@/pages/word/ribbon/types";
import type { WordRequest } from "@/api/apiWord";

const TEMPLATES = ["blank", "letter", "resume", "report", "sample"] as const;
const OPEN_ACCEPT = ".docx,.doc,.odt,.rtf,.html,.htm,.md,.txt,.tex,.dotx,.docm";
const PREFS_KEY = "moonapp.word.tabs";
const LEFT_PANES: PaneName[] = ["navigation", "find", "reviewing", "clipboard"];
const REGIONS: Record<string, string> = {
  ru: "ru-RU",
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  zh: "zh-CN",
  ar: "ar-SA",
};
const FIT_PAD = 44;

let FONT_CACHE: string[] | null = null;

function loadPrefs(): TabPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<TabPrefs>;
    return { draw: !!p.draw, developer: !!p.developer };
  } catch {
    return { draw: false, developer: false };
  }
}

/** Озвучка документа средствами браузера: плеер с паузой, остановкой и скоростью. */
function ReadAloudBar({
  text,
  tw,
  onClose,
}: {
  text: () => Promise<string>;
  tw: (s: string) => string;
  onClose: () => void;
}) {
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const started = useRef(false);
  const start = useCallback(
    async (r: number) => {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const t = await text();
      if (!t.trim()) return;
      const u = new SpeechSynthesisUtterance(t);
      u.rate = r;
      u.onend = () => setPlaying(false);
      synth.speak(u);
      setPlaying(true);
    },
    [text],
  );
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start(1);
    return () => window.speechSynthesis?.cancel();
  }, [start]);
  return (
    <div
      className="wd-readbar"
      style={{ position: "absolute", right: 24, bottom: 44, zIndex: 8, margin: 0 }}
    >
      <Btn
        icon={playing ? Pause : Play}
        onClick={() => {
          const s = window.speechSynthesis;
          if (playing) s.pause();
          else if (s.paused) s.resume();
          else void start(rate);
          setPlaying(!playing);
        }}
      >
        {tw(playing ? "Pause" : "Play")}
      </Btn>
      <Btn
        icon={Square}
        onClick={() => {
          window.speechSynthesis?.cancel();
          onClose();
        }}
      >
        {tw("Stop Reading")}
      </Btn>
      <select
        value={rate}
        onChange={(e) => {
          const r = Number(e.target.value);
          setRate(r);
          void start(r);
        }}
        aria-label={tw("Reading Speed")}
      >
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * «Документы»: текстовый редактор. Движок документа — ядро WordCraft (сайдкар), интерфейс — наш:
 * лента как в Word, страницы с кареткой и выделением, панели, диалоги, меню «Файл».
 */
export default function WordPage() {
  const { t, lang } = useI18n();
  const tw = useTw();
  const docs = useWordDocs();
  const { active, status } = docs;
  // Функции хука с постоянной ссылкой (меняются только со сменой документа): от них зависят эффекты панелей.
  const {
    run: docsRun,
    query: docsQuery,
    copy: docsCopy,
    paste: docsPaste,
    setError: setDocsError,
  } = docs;
  const [zoom, setZoomState] = useState(1);
  const [focused, setFocused] = useState(false);
  const [tab, setTab] = useState("Home");
  const [collapsed, setCollapsed] = useState(false);
  const [prefs, setPrefsState] = useState<TabPrefs>(loadPrefs);
  const [pane, setPane] = useState<PaneName | null>(null);
  const [searchFocus, setSearchFocus] = useState(0);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [backstage, setBackstage] = useState<BackstagePage | null>(null);
  const [reading, setReading] = useState(false);
  const [tool, setTool] = useState<"drawTable" | "eraseTable" | null>(null);
  const [fonts, setFonts] = useState<string[]>(FONT_CACHE ?? []);
  const [areaEl, setAreaEl] = useState<HTMLDivElement | null>(null);
  const [areaSize, setAreaSize] = useState({ w: 0, h: 0 });
  const openRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<{ cmd: string; extra: Params } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileThen = useRef<((f: File) => void) | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const localZoomAt = useRef(0);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  usePageBusy(docs.busy);

  const setArea = useCallback((el: HTMLDivElement | null) => {
    areaRef.current = el;
    setAreaEl(el);
  }, []);

  const setPrefs = (p: TabPrefs): void => {
    setPrefsState(p);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* без сохранения */
    }
  };

  const state = active?.state;

  /* ---- масштаб: источник правды — ядро; режимы «по ширине» и т. п. считаем по размеру окна ---- */
  const setZoom = useCallback(
    (z: number): void => {
      const v = Math.min(5, Math.max(0.1, z));
      localZoomAt.current = Date.now();
      setZoomState(v);
      clearTimeout(zoomTimer.current);
      zoomTimer.current = setTimeout(
        () => void docsRun("view.zoom", { value: Math.round(v * 100) }),
        200,
      );
    },
    [docsRun],
  );

  useEffect(() => {
    if (!areaEl) return;
    const ro = new ResizeObserver(() =>
      setAreaSize({ w: areaEl.clientWidth, h: areaEl.clientHeight }),
    );
    ro.observe(areaEl);
    setAreaSize({ w: areaEl.clientWidth, h: areaEl.clientHeight });
    return () => ro.disconnect();
  }, [areaEl]);

  const fit = state?.view.fit ?? "";
  const viewZoom = state?.view.zoom ?? 1;
  const pageW = state?.pages[0]?.w ?? 612;
  const pageH = state?.pages[0]?.h ?? 792;
  const nPages = state?.pages.length ?? 1;
  useEffect(() => {
    if (!state) return;
    const aw = Math.max(100, areaSize.w - FIT_PAD);
    const ah = Math.max(100, areaSize.h - FIT_PAD);
    if (fit === "pageWidth") setZoomState(aw / (pageW * PX_PER_PT));
    else if (fit === "onePage")
      setZoomState(Math.min(aw / (pageW * PX_PER_PT), ah / (pageH * PX_PER_PT)));
    else if (fit === "multiplePages") {
      const per = Math.min(3, Math.max(2, nPages));
      setZoomState(Math.min(aw / ((pageW * per + 12 * per) * PX_PER_PT), ah / (pageH * PX_PER_PT)));
    } else if (Date.now() - localZoomAt.current > 800) setZoomState(viewZoom);
  }, [fit, viewZoom, areaSize.w, areaSize.h, pageW, pageH, nPages, state]);

  // Масштаб колёсиком с Ctrl, как в офисных редакторах.
  useEffect(() => {
    const el = areaEl;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [areaEl, zoom, setZoom]);

  /* ---- шрифты ядра (один раз) ---- */
  useEffect(() => {
    if (FONT_CACHE || !active) return;
    void docsRun("font.list", { all: true }, true).then((r) => {
      const fam = (r as { families?: string[] } | undefined)?.families;
      if (fam?.length) {
        FONT_CACHE = fam;
        setFonts(fam);
      }
    });
    // один раз после появления первого документа
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  /* ---- панели ---- */
  const togglePane = useCallback((name: PaneName, on?: boolean): void => {
    setPane((cur) => {
      const next =
        on === undefined ? (cur === name ? null : name) : on ? name : cur === name ? null : cur;
      return next;
    });
    if (name === "find" || (name === "navigation" && on)) setSearchFocus((n) => n + 1);
  }, []);

  // Флаги вида ядра (View ▸ Navigation Pane, Review ▸ Show Comments…) открывают наши панели.
  const flags = state
    ? [
        state.view.navPane,
        state.view.commentsPane,
        state.view.stylesPane,
        state.view.accessibilityPane,
        state.view.altTextPane,
        state.view.clipboardPane,
        state.view.smartArtPane,
        state.view.trackChangesPane,
      ]
    : [];
  const prevFlags = useRef<boolean[]>([]);
  const flagsDoc = useRef("");
  useEffect(() => {
    // Другой документ: его флаги берём как есть, не открывая панели сами.
    if (flagsDoc.current !== (active?.id ?? "")) {
      flagsDoc.current = active?.id ?? "";
      prevFlags.current = flags;
      return;
    }
    const names: PaneName[] = [
      "navigation",
      "comments",
      "styles",
      "accessibility",
      "altText",
      "clipboard",
      "smartArt",
      "reviewing",
    ];
    flags.forEach((v, i) => {
      if (v && !prevFlags.current[i]) setPane(names[i]);
      if (!v && prevFlags.current[i]) setPane((cur) => (cur === names[i] ? null : cur));
    });
    prevFlags.current = flags;
    // flags пересоздаётся каждый рендер: зависим от значений
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flags.join(",")]);

  const closePane = (): void => {
    const cur = pane;
    setPane(null);
    // Синхронизируем флаг ядра, чтобы переключатели «Вид» не расходились с панелью.
    if (cur === "navigation" && state?.view.navPane)
      void docs.run("view.navigationPane", { value: false });
    if (cur === "comments" && state?.view.commentsPane)
      void docs.run("view.commentsPane", { value: false });
    if (cur === "accessibility" && state?.view.accessibilityPane)
      void docs.run("view.accessibilityPane", { value: false });
    if (cur === "altText" && state?.view.altTextPane)
      void docs.run("view.altTextPane", { value: false });
    if (cur === "clipboard" && state?.view.clipboardPane)
      void docs.run("edit.clipboardPane", { value: false });
    if (cur === "styles" && state?.view.stylesPane) void docs.run("view.stylesPane", {});
    if (cur === "smartArt" && state?.view.smartArtPane) void docs.run("smartArt.textPane", {});
    if (cur === "reviewing" && state?.view.trackChangesPane) void docs.run("review.changes", {});
  };

  /* ---- создание/открытие/сохранение ---- */
  const create = useCallback(
    (template: string): void => {
      void docs.create(
        template,
        tw(template === "blank" ? "Blank" : template[0].toUpperCase() + template.slice(1)),
        { region: REGIONS[lang], lang: lang === "ru" ? "ru-RU" : undefined },
      );
    },
    [docs, lang, tw],
  );

  const exportAs = useCallback(
    (format: string, name?: string): void => {
      if (!active) return;
      void docs.exportAs(format, name);
    },
    [active, docs],
  );

  const print = useCallback(async (): Promise<void> => {
    if (!active) return;
    const blob = await api.wordExport(active.id, "pdf", active.name).catch(() => null);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.src = url;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        window.open(url, "_blank");
      }
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    };
    document.body.appendChild(frame);
  }, [active]);

  /* ---- запросы ядра к интерфейсу (диалоги, прокрутка…) ---- */
  const openDialog = useCallback(
    (name: string, props: Params = {}): void => setDialog({ name, props }),
    [],
  );
  useEffect(() => {
    docs.onRequests.current = (reqs: WordRequest[]) => {
      for (const r of reqs) {
        const open = r.open;
        if (open) {
          if (open === "find") togglePane("find", true);
          else if (open === "options") setBackstage("options");
          else if (open === "print") void print();
          else if (open === "saveAs") exportAs("docx");
          else if (open === "openFile") openRef.current?.click();
          else if (open === "insertPicture") {
            pickRef.current = { cmd: "insert.picture", extra: {} };
            imgRef.current?.click();
          } else if (open === "manageStyles") togglePane("styles", true);
          else if (open === "customizeKeyboard" || open === "customizeRibbon")
            setBackstage("options");
          else if (open === "replace" || open === "goto" || open === "findReplace")
            openDialog(open === "findReplace" ? "replace" : open);
          else if (open !== "newWindow") openDialog(open);
        }
        if (r.focus === "navSearch") togglePane("find", true);
        if (r.scrollTo === "caret") window.dispatchEvent(new CustomEvent("wd-scroll-caret"));
        if (r.close) if (active) void docs.close(active.id);
      }
    };
  }, [docs, togglePane, print, exportAs, openDialog, active]);

  useEffect(() => {
    const on = (): void => setReading((v) => !v);
    window.addEventListener("wd-read-aloud", on);
    return () => window.removeEventListener("wd-read-aloud", on);
  }, []);

  // Полный экран по флагу ядра.
  const fullScreen = !!state?.view.fullScreen;
  useEffect(() => {
    if (fullScreen && !document.fullscreenElement)
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    if (!fullScreen && document.fullscreenElement)
      void document.exitFullscreen?.().catch(() => undefined);
  }, [fullScreen]);

  /* ---- контекстные вкладки, которые открываются сами (формула, структура, колонтитул) ---- */
  const ctxTab = state
    ? state.view.mode === "outline"
      ? "Outlining"
      : state.ctx.equation
        ? "Equation"
        : state.ctx.part === "header" || state.ctx.part === "footer"
          ? "Header & Footer"
          : ""
    : "";
  const prevCtxTab = useRef({ ctx: "", tab: "Home" });
  useEffect(() => {
    const p = prevCtxTab.current;
    if (ctxTab && ctxTab !== p.ctx) {
      prevCtxTab.current = { ctx: ctxTab, tab: tab === ctxTab ? p.tab : tab };
      setTab(ctxTab);
    } else if (!ctxTab && p.ctx) {
      if (tab === p.ctx) setTab(p.tab);
      prevCtxTab.current = { ctx: "", tab: p.tab };
    }
    // реагируем только на смену контекста
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxTab]);

  /* ---- Cx: всё, что нужно ленте, меню и диалогам ---- */
  const run = useCallback(
    (cmd: string, p: Params = {}): void => {
      void docsRun(cmd, p).then(() => {
        if (
          cmd.startsWith("styles.") ||
          cmd.startsWith("design.") ||
          cmd === "para.style" ||
          cmd === "format.charStyle"
        )
          window.dispatchEvent(new CustomEvent(STYLES_CHANGED));
      });
    },
    [docsRun],
  );
  const call = useCallback(
    (cmd: string, p: Params = {}): Promise<unknown> => docsRun(cmd, p, true) as Promise<unknown>,
    [docsRun],
  );
  const query = useCallback(
    <T,>(method: string, p?: unknown): Promise<T | undefined> => docsQuery<T>(method, p),
    [docsQuery],
  );

  const cx: Cx | null = useMemo(() => {
    if (!active || !state) return null;
    return {
      s: state,
      docId: active.id,
      themeColors: state.settings.themeColors,
      lang,
      tw,
      run,
      dialog: openDialog,
      query,
      call,
      ui: {
        zoom,
        setZoom,
        togglePane,
        pane,
        backstage: (page?: string) => setBackstage((page as BackstagePage) ?? "info"),
        pickImage: (cmd: string, extra: Params = {}) => {
          pickRef.current = { cmd, extra };
          imgRef.current?.click();
        },
        pickFile: (accept: string, then: (f: File) => void) => {
          if (!fileRef.current) return;
          fileRef.current.accept = accept;
          fileThen.current = then;
          fileRef.current.click();
        },
        copy: (cut?: boolean) => void docsCopy(!!cut),
        paste: (as?: "default" | "text" | "merge") => void docsPaste(as ?? "default"),
        fonts,
        status: (msg: string) => setDocsError(msg),
        upload: async (f: File) => {
          try {
            return (await api.wordUpload(f)).path;
          } catch (e) {
            setDocsError(String((e as Error).message));
            return undefined;
          }
        },
        exportAs,
        docName: active.name,
        tool,
        setTool,
      },
    };
  }, [
    active,
    state,
    lang,
    tw,
    run,
    openDialog,
    query,
    call,
    zoom,
    setZoom,
    togglePane,
    pane,
    docsCopy,
    docsPaste,
    setDocsError,
    fonts,
    exportAs,
    tool,
  ]);

  if (status && !status.available) {
    return (
      <div className="page wd-page-root">
        <SectionHead eyebrow={t("word.eyebrow")} title={t("word.title")} />
        <Glass className="wd-missing">
          <b>{t("word.coreMissing")}</b>
          <span className="muted-sm">{t("word.coreMissingHint")}</span>
          <code>npm run build:wordcore</code>
          {status.searched.length > 0 && <pre className="ph-log">{status.searched.join("\n")}</pre>}
        </Glass>
      </div>
    );
  }

  const hiddenInputs = (
    <>
      <input
        ref={openRef}
        type="file"
        hidden
        accept={OPEN_ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void docs.openFile(f);
          e.target.value = "";
        }}
      />
      <input
        ref={imgRef}
        type="file"
        hidden
        accept="image/*"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          const pick = pickRef.current;
          if (f && pick)
            void docs.run(pick.cmd, {
              data: await fileToBase64(f),
              width: 300,
              alt: f.name,
              ...pick.extra,
            });
        }}
      />
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) fileThen.current?.(f);
        }}
      />
    </>
  );

  if (!active || !state || !cx) {
    return (
      <div className="page wd-page-root">
        <SectionHead eyebrow={t("word.eyebrow")} title={t("word.title")} />
        {docs.error && (
          <div className="ph-error wd-error" role="alert">
            {docs.error}
          </div>
        )}
        <Glass className="wd-empty">
          <EmptyHint icon={FilePlus2} text={t("word.emptyHint")} />
          <div className="wd-bs-tiles" style={{ width: "100%" }}>
            {TEMPLATES.map((k) => (
              <button
                key={k}
                type="button"
                className="wd-bs-tile"
                disabled={docs.busy}
                onClick={() => create(k)}
              >
                <FilePlus2 size={30} />
                <span>{tw(k === "blank" ? "Blank" : k[0].toUpperCase() + k.slice(1))}</span>
              </button>
            ))}
            <button
              type="button"
              className="wd-bs-tile"
              disabled={docs.busy}
              onClick={() => openRef.current?.click()}
            >
              <FolderOpen size={30} />
              <span>{tw("Open")}</span>
            </button>
          </div>
        </Glass>
        {hiddenInputs}
      </div>
    );
  }

  const k = PX_PER_PT * zoom;
  const langTag = String(state.format.lang || "en-US");
  const langName = tw(
    LANGUAGES.find(
      ([tag]) =>
        tag.toLowerCase() === langTag.toLowerCase() ||
        tag.slice(0, 2).toLowerCase() === langTag.slice(0, 2).toLowerCase(),
    )?.[1] ?? langTag,
  );
  const readMode = state.view.readMode || state.view.mode === "read";
  const focusMode = state.view.focusMode;
  const leftPane = pane && LEFT_PANES.includes(pane) ? pane : null;
  const rightPane = pane && !LEFT_PANES.includes(pane) ? pane : null;

  return (
    <div className="page wd-page-root">
      {!focusMode ? <TitleBar cx={cx} name={active.name} /> : null}

      {!focusMode && docs.docs.length > 0 ? (
        <div className="wd-doctabs">
          {docs.docs.map((d) => (
            <div key={d.id} className={`wd-doctab${d.id === docs.activeId ? " active" : ""}`}>
              <button type="button" onClick={() => docs.setActiveId(d.id)}>
                {d.name}
                {d.state.dirty ? " •" : ""}
              </button>
              <button
                type="button"
                className="wd-x-btn"
                aria-label={t("word.close")}
                title={t("word.close")}
                onClick={() => void docs.close(d.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="wd-doctab"
            style={{ cursor: "pointer", background: "none", paddingRight: 10 }}
            onClick={() => create("blank")}
            title={tw("New")}
          >
            +
          </button>
        </div>
      ) : null}

      {docs.error && (
        <div className="ph-error wd-error" role="alert">
          {docs.error}
          <button
            type="button"
            className="wd-x-btn"
            aria-label={t("word.close")}
            onClick={() => docs.setError("")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!readMode && !focusMode ? (
        <Ribbon
          cx={cx}
          base={baseTabs(prefs)}
          context={contextTabs(cx)}
          tab={tab}
          setTab={setTab}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
        />
      ) : null}
      {readMode ? (
        <div className="wd-readbar">
          <b>{tw("Reading Mode")}</b>
          <select
            aria-label={tw("Column width")}
            defaultValue="auto"
            onChange={(e) => run("view.readColumnWidth", { value: e.target.value })}
          >
            {["auto", "narrow", "medium", "wide", "page"].map((v) => (
              <option key={v} value={v}>
                {tw("Column width")}: {tw(v[0].toUpperCase() + v.slice(1))}
              </option>
            ))}
          </select>
          <select
            aria-label={tw("Text size")}
            defaultValue="100"
            onChange={(e) => run("view.readTextSize", { value: Number(e.target.value) })}
          >
            {[75, 90, 100, 110, 125, 150].map((v) => (
              <option key={v} value={v}>
                {tw("Text size")}: {v}%
              </option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          <Btn onClick={() => run("view.printLayout")}>{tw("Edit Document")}</Btn>
        </div>
      ) : null}
      {focusMode ? (
        <div className="wd-readbar">
          <b>{tw("Focus")}</b>
          <span style={{ flex: 1 }} />
          <Btn onClick={() => run("view.focus")}>{tw("Close")}</Btn>
        </div>
      ) : null}

      <div className="wd-main">
        {leftPane ? (
          <PaneHost name={leftPane} cx={cx} onClose={closePane} focusSearch={searchFocus > 0} />
        ) : null}
        <div className="wd-center">
          {state.view.ruler && !readMode && !focusMode ? (
            <Ruler cx={cx} k={k} area={areaEl} />
          ) : null}
          <div className="wd-area" ref={setArea}>
            <PageCanvas
              docs={docs}
              docId={active.id}
              state={state}
              zoom={zoom}
              focused={focused}
              onFocusChange={setFocused}
              cx={cx}
              areaRef={areaRef}
            />
          </div>
        </div>
        {rightPane ? (
          <PaneHost name={rightPane} cx={cx} onClose={closePane} focusSearch={false} />
        ) : null}
      </div>

      {!focusMode ? <StatusBar cx={cx} langName={langName} /> : null}

      {backstage ? (
        <Backstage
          cx={cx}
          page={backstage}
          setPage={setBackstage}
          onClose={() => setBackstage(null)}
          create={create}
          openFile={() => openRef.current?.click()}
          prefs={prefs}
          setPrefs={setPrefs}
          print={() => void print()}
        />
      ) : null}
      <DialogHost dialog={dialog} cx={cx} onClose={() => setDialog(null)} />
      <ContextLayer cx={cx} />
      {reading ? (
        <ReadAloudBar
          tw={tw}
          text={async () =>
            String(((await docs.query<{ text?: string }>("document.text")) ?? {}).text ?? "")
          }
          onClose={() => setReading(false)}
        />
      ) : null}
      {hiddenInputs}
    </div>
  );
}
