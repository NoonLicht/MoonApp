import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FolderOpen, X } from "lucide-react";
import { api } from "@/api/client";
import { Glass, EmptyHint } from "@/components/ui";
import { RecoverList } from "@/components/DocAutosaveUi";
import { useDocAutosave } from "@/lib/docAutosave";
import { useI18n } from "@/app/i18n";
import { saveBlob } from "@/lib/download";
import { useTw } from "@/pages/sheet/i18n/useTw";
import { useSheetDocs } from "@/pages/sheet/useSheetDocs";
import Ribbon from "@/pages/word/ribbon/Ribbon";
import { CustomCtx } from "@/pages/word/ribbon/controls";
import { baseTabs, contextTabs } from "@/pages/sheet/ribbon/model";
import { SHEET_CUSTOM, FONTS } from "@/pages/sheet/ribbon/custom";
import GridView, { type Hit } from "@/pages/sheet/grid/GridView";
import { FormulaBar, SheetTabs, StatusBar, TitleBar } from "@/pages/sheet/chrome";
import { a1, colName } from "@/pages/sheet/grid/geometry";
import { findRefs, REF_COLORS } from "@/pages/sheet/functions";
import type { EditApi, EditState, MoveDir, ObjSel } from "@/pages/sheet/edit";
import type { SheetCx, SheetPane } from "@/pages/sheet/types";
import type { SheetCommand, SheetRange, SheetRequest, SheetState } from "@/api/apiSheet";
import Backstage, { type BackstagePage } from "@/pages/sheet/Backstage";
import DialogHost, { type OpenDialog } from "@/pages/sheet/dialogs/registry";
import ContextLayer, { type ContextState } from "@/pages/sheet/parts/contextMenu";
import { PaneHost } from "@/pages/sheet/panes/Panes";
import FilterMenu from "@/pages/sheet/parts/FilterMenu";
import ListPicker from "@/pages/sheet/parts/ListPicker";

const SAMPLES = ["blank", "budget", "sales", "grades"] as const;
const OPEN_ACCEPT = ".xlsx,.xlsm,.xltx,.xls,.xlsb,.ods,.csv,.tsv,.txt,.json";

/** Нормальная форма сочетания: Ctrl и Cmd — одно и то же, порядок Cmd, Alt, Shift, клавиша. */
function normShortcut(s: string): string | null {
  const parts = s.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const has = (n: string): boolean => parts.includes(n);
  if (has("Ctrl") && has("Cmd")) return null;
  const mods = [has("Ctrl") || has("Cmd") ? "Cmd" : "", has("Alt") ? "Alt" : "", has("Shift") ? "Shift" : ""].filter(Boolean);
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

export default function SheetPage() {
  const { t, lang } = useI18n();
  const tw = useTw();
  const docs = useSheetDocs();
  const { active } = docs;
  const state = active?.state ?? null;
  const auto = useDocAutosave({
    kind: "sheet",
    ext: "xlsx",
    items: docs.docs.map((d) => ({ id: d.id, name: d.name, dirty: d.state.doc.dirty, version: d.state })),
    exportBlob: (id, name) => api.sheetExport(id, "xlsx", name),
    openFile: (f) => docs.openFile(f),
  });

  const [tab, setTab] = useState("home");
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [pane, setPane] = useState<SheetPane | null>(null);
  const [backstage, setBackstage] = useState<BackstagePage | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [selObj, setSelObj] = useState<ObjSel | null>(null);
  const [commands, setCommands] = useState<SheetCommand[]>([]);
  const [ctxMenu, setCtxMenu] = useState<ContextState | null>(null);
  const [filter, setFilter] = useState<{ r: number; c: number; rect: DOMRect } | null>(null);
  const [list, setList] = useState<{ r: number; c: number; rect: DOMRect } | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const editRef = useRef<EditState | null>(null);
  editRef.current = edit;
  const caret = useRef(0);
  const pointRef = useRef<{ start: number; end: number; anchor: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const pickThen = useRef<((f: File) => void) | null>(null);
  const ownClip = useRef("");

  const docsRun = docs.run;
  const docsQuery = docs.query;
  const docsOpenFile = docs.openFile;
  const stateRef = useRef(state);
  stateRef.current = state;

  // Команды ядра: список для поиска на ленте и карта горячих клавиш.
  const docId = active?.id ?? "";
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    void api
      .sheetCommands(docId)
      .then((c) => alive && setCommands(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [docId]);
  const shortcuts = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of commands) {
      if (!c.shortcut) continue;
      const k = normShortcut(c.shortcut);
      if (k && !m.has(k)) m.set(k, c.id);
    }
    return m;
  }, [commands]);

  const focusGrid = useCallback(() => setFocusKey((n) => n + 1), []);

  /* ---------------- правка ячейки ---------------- */
  const docIdRef = useRef("");
  docIdRef.current = active?.id ?? "";
  const getState = docs.getState;
  const idle = docs.idle;
  const begin = useCallback(
    (text?: string | null, origin: "cell" | "bar" = "cell", mode: "enter" | "edit" = "edit") => {
      const st = getState(docIdRef.current) ?? stateRef.current;
      if (!st) return;
      pointRef.current = null;
      const base = text === undefined || text === null ? st.bar.text : text;
      const next: EditState = { r: st.sel.active.r, c: st.sel.active.c, text: base, mode, origin };
      editRef.current = next; // сразу: следующий символ должен увидеть открытую правку, не дожидаясь отрисовки
      setEdit(next);
    },
    [getState],
  );
  // Символы, набранные пока ядро ещё отвечает на клик/стрелку: копим и начинаем правку с актуальной ячейки.
  // Завершающая клавиша (Enter, Tab), нажатая сразу за ними, тоже ждёт своей очереди.
  const typing = useRef<{ text: string; end: MoveDir | null }[]>([]);
  const flushing = useRef(false);
  const afterMove = useCallback(
    async (dir: MoveDir, st: SheetState): Promise<void> => {
      if (dir === "none") return;
      const single = st.sel.ranges.length === 1 && !st.sel.ranges[0].a1.includes(":");
      if (!single) {
        await docsRun("selection.next", { forward: dir === "down" || dir === "right", byRow: dir === "right" || dir === "left" });
        return;
      }
      const [dr, dc] = dir === "down" ? [1, 0] : dir === "up" ? [-1, 0] : dir === "right" ? [0, 1] : [0, -1];
      await docsRun("selection.move", { dr, dc });
    },
    [docsRun],
  );
  const flushTyping = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      // Записи обрабатываются по порядку: каждая видит выделение, оставленное предыдущей.
      while (typing.current.length) {
        await commitDone.current;
        await idle();
        const q = typing.current.shift();
        const st = getState(docIdRef.current) ?? stateRef.current;
        if (!q || !st) continue;
        if (!q.end) {
          const open = editRef.current;
          if (open) {
            const next = { ...open, text: open.text + q.text, caret: undefined };
            editRef.current = next;
            setEdit(next);
          } else begin(q.text, "cell", "enter");
          continue;
        }
        const res = await docsRun("cell.set", { cell: a1(st.sel.active.r, st.sel.active.c), input: q.text });
        if (res === undefined) {
          begin(q.text, "cell", "edit");
          typing.current = [];
        } else await afterMove(q.end, getState(docIdRef.current) ?? st);
      }
    } finally {
      flushing.current = false;
    }
  }, [idle, getState, begin, docsRun, afterMove]);
  const typeChar = useCallback(
    (ch: string) => {
      const q = typing.current;
      const last = q[q.length - 1];
      if (last && !last.end) last.text += ch;
      else q.push({ text: ch, end: null });
      void flushTyping();
    },
    [flushTyping],
  );
  const typeEnd = useCallback((dir: MoveDir): boolean => {
    const q = typing.current;
    const last = q[q.length - 1];
    if (!last || last.end) return false;
    last.end = dir;
    return true;
  }, []);
  const setText = useCallback((text: string, c?: number) => {
    const cur = editRef.current;
    if (cur) editRef.current = { ...cur, text, caret: c };
    setEdit((e) => (e ? { ...e, text, caret: c } : e));
  }, []);
  /** Завершение правки идёт в несколько запросов; ввод следующей ячейки ждёт, пока оно закончится целиком. */
  const commitDone = useRef<Promise<void>>(Promise.resolve());
  const doCommit = useCallback(
    async (dir: MoveDir, opts: { fill?: boolean; array?: boolean }): Promise<void> => {
      const e = editRef.current;
      const st = getState(docIdRef.current) ?? stateRef.current;
      if (!e || !st) return;
      editRef.current = null;
      setEdit(null);
      pointRef.current = null;
      const cell = a1(e.r, e.c);
      const same = e.text === st.bar.text && e.r === st.sel.active.r && e.c === st.sel.active.c;
      if (!same || opts.fill || opts.array) {
        const res = opts.fill
          ? await docsRun("range.fill", { input: e.text })
          : await docsRun("cell.set", { cell, input: e.text, ...(opts.array ? { array: true } : {}) });
        // Ядро не приняло ввод (ошибка формулы): правка остаётся открытой.
        if (res === undefined) {
          setEdit({ ...e, mode: "edit" });
          return;
        }
      }
      await afterMove(dir, st);
    },
    [docsRun, afterMove, getState],
  );
  const commit = useCallback(
    (dir: MoveDir = "down", opts: { fill?: boolean; array?: boolean } = {}): Promise<void> => {
      const p = doCommit(dir, opts);
      commitDone.current = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    [doCommit],
  );
  const cancel = useCallback(() => {
    editRef.current = null;
    setEdit(null);
    pointRef.current = null;
    focusGrid();
  }, [focusGrid]);
  const editApi: EditApi = useMemo(
    () => ({ caret, begin, type: typeChar, typeEnd, set: setText, commit, cancel }),
    [begin, typeChar, typeEnd, setText, commit, cancel],
  );

  // Указание ячейки мышью при правке формулы вставляет ссылку.
  const onPoint = useCallback(
    (ref: string, extend: boolean): boolean => {
      const e = editRef.current;
      if (!e || !e.text.startsWith("=")) return false;
      const pos = Math.min(caret.current, e.text.length);
      const before = e.text.slice(0, pos);
      const p = pointRef.current;
      if (p && p.end === pos) {
        const full = extend ? `${p.anchor}:${ref}` : ref;
        const next = e.text.slice(0, p.start) + full + e.text.slice(p.end);
        pointRef.current = { start: p.start, end: p.start + full.length, anchor: extend ? p.anchor : ref };
        setEdit({ ...e, text: next, caret: p.start + full.length });
        caret.current = p.start + full.length;
        return true;
      }
      if (/[=(,+\-*/^&<>;:]$/.test(before)) {
        const next = before + ref + e.text.slice(pos);
        pointRef.current = { start: pos, end: pos + ref.length, anchor: ref };
        setEdit({ ...e, text: next, caret: pos + ref.length });
        caret.current = pos + ref.length;
        return true;
      }
      return false;
    },
    [],
  );

  // Подсветка ссылок формулы в самой таблице.
  const refs = useMemo((): [SheetRange, string][] => {
    if (!edit || !edit.text.startsWith("=")) return [];
    const out: [SheetRange, string][] = [];
    findRefs(edit.text).forEach((r, i) => {
      const clean = r.text.replace(/\$/g, "");
      const [x, y] = clean.split(":");
      const parse = (s: string): { r: number; c: number } | null => {
        const m = /^([A-Za-z]{1,3})(\d+)$/.exec(s);
        if (!m) return null;
        let c = 0;
        for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
        return { r: Number(m[2]) - 1, c: c - 1 };
      };
      const a = parse(x);
      const b = y ? parse(y) : a;
      if (!a || !b) return;
      out.push([
        {
          r0: Math.min(a.r, b.r),
          c0: Math.min(a.c, b.c),
          r1: Math.max(a.r, b.r),
          c1: Math.max(a.c, b.c),
          a1: r.text,
        },
        REF_COLORS[i % REF_COLORS.length],
      ]);
    });
    return out;
  }, [edit]);

  // Смена листа или книги закрывает правку.
  useEffect(() => {
    setEdit(null);
    setSelObj(null);
  }, [docId, state?.active]);

  /* ---------------- запросы ядра к интерфейсу ---------------- */
  const setError = docs.setError;
  const openDialog = useCallback((name: string, props: Record<string, unknown> = {}) => setDialog({ name, props }), []);
  const togglePane = useCallback((name: SheetPane, on?: boolean) => {
    setPane((cur) => (on === undefined ? (cur === name ? null : name) : on ? name : cur === name ? null : cur));
  }, []);
  docs.onRequests.current = (reqs: SheetRequest[]) => {
    for (const r of reqs) {
      if (r.kind === "dialog") {
        if (r.name === "find") togglePane("find", true);
        else if (r.name === "open") fileRef.current?.click();
        else if (r.name === "saveAs") setBackstage("saveAs");
        else if (r.name === "options") setBackstage("options");
        else if (r.name === "backstage") setBackstage(((r.params.page as string) || "info") as BackstagePage);
        else if (r.name === "comment") togglePane("comments", true);
        else if (r.name === "pivotFields") togglePane("pivotFields", true);
        else openDialog(r.name, r.params);
      } else if (r.kind === "message") setError(r.text);
      else if (r.kind === "edit") begin(r.text ?? null, "cell", "edit");
      else if (r.kind === "url") {
        if (/^(https?:|mailto:)/i.test(r.url) && window.confirm(`${tw("Open")}: ${r.url}?`))
          window.open(r.url, "_blank", "noopener,noreferrer");
      }
    }
  };

  /* ---------------- буфер обмена ---------------- */
  const copy = useCallback(
    async (cut = false) => {
      const r = (await docsRun(cut ? "edit.cut" : "edit.copy", { html: true })) as
        | { text?: string; html?: string }
        | undefined;
      if (!r || r.text === undefined) return;
      ownClip.current = r.text;
      try {
        if (r.html && typeof ClipboardItem !== "undefined") {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([r.text], { type: "text/plain" }),
              "text/html": new Blob([r.html], { type: "text/html" }),
            }),
          ]);
        } else await navigator.clipboard.writeText(r.text);
      } catch {
        /* системный буфер недоступен: вставка внутри листа всё равно работает */
      }
    },
    [docsRun],
  );
  const paste = useCallback(
    async (what = "all", op?: string) => {
      let text = "";
      let html = "";
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (it.types.includes("text/html")) html = await (await it.getType("text/html")).text();
          if (it.types.includes("text/plain")) text = await (await it.getType("text/plain")).text();
        }
      } catch {
        try {
          text = await navigator.clipboard.readText();
        } catch {
          /* нет доступа к буферу */
        }
      }
      const internal = !text || text.trim() === ownClip.current.trim();
      if ((what !== "all" || op) && internal) {
        await docsRun("edit.pasteSpecial", {
          what,
          ...(op === "transpose" ? { transpose: true } : op === "link" ? { link: true } : op ? { operation: op } : {}),
        });
        return;
      }
      await docsRun("edit.paste", text ? { text, html } : {});
    },
    [docsRun],
  );

  /* ---------------- файлы и выгрузка ---------------- */
  const exportAs = useCallback(
    async (format: string, name?: string, sheets?: "active" | "all") => {
      const res = await docs.exportAs(format, name, sheets);
      if (res) saveBlob(res, `${(name ?? active?.name ?? "book").replace(/\.[^.]+$/, "")}.${format}`);
    },
    [docs, active?.name],
  );
  const upload = useCallback(
    async (f: File): Promise<string | undefined> => {
      try {
        return (await api.sheetUpload(f)).path;
      } catch (e) {
        setError(String((e as Error).message));
        return undefined;
      }
    },
    [setError],
  );
  const pickFile = useCallback((accept: string, then: (f: File) => void) => {
    const el = pickRef.current;
    if (!el) return;
    el.accept = accept;
    pickThen.current = then;
    el.click();
  }, []);

  const create = useCallback(
    (sample: string) => {
      setBackstage(null);
      void docs.create(sample, sample === "blank" ? `${tw("Book")}${docs.docs.length + 1}` : tw(sample[0].toUpperCase() + sample.slice(1)));
    },
    [docs, tw],
  );

  /* ---------------- контекст ленты ---------------- */
  const cx: SheetCx | null = useMemo(() => {
    if (!active || !state) return null;
    return {
      s: state,
      docId: active.id,
      themeColors: state.theme.colors.map((c) => c.replace("#", "")),
      lang,
      tw,
      run: (c, p) => {
        void docsRun(c, p ?? {});
        focusGrid();
      },
      dialog: openDialog,
      query: docsQuery,
      call: (c, p) => docsRun(c, p ?? {}, true),
      exec: docs.exec,
      ui: {
        backstage: (page?: string) => setBackstage((page as BackstagePage) ?? "info"),
        pane,
        togglePane,
        paste: (what, op) => void paste(what, op),
        copy: (cut) => void copy(cut),
        status: setError,
        pickFile,
        upload,
        exportAs: (f, n, s) => void exportAs(f, n, s),
        docName: active.name,
        edit: editApi,
        selObj,
        focusGrid,
        fonts: FONTS,
        sheets: state.sheets.map((s) => s.name),
      },
    };
  }, [active, state, lang, tw, docsRun, docsQuery, openDialog, pane, togglePane, paste, copy, setError, pickFile, upload, exportAs, editApi, selObj, focusGrid]);

  const onContext = useCallback((x: number, y: number, hit: Hit) => setCtxMenu({ x, y, hit }), []);

  const hiddenInputs = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept={OPEN_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) {
            setBackstage(null);
            void docsOpenFile(f);
          }
        }}
      />
      <input
        ref={pickRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) pickThen.current?.(f);
        }}
      />
    </>
  );

  if (docs.status && !docs.status.available) {
    return (
      <div className="page wd-page-root">
        <Glass className="wd-empty">
          <EmptyHint icon={FilePlus2} text={t("sheet.coreMissing")} />
          <p style={{ opacity: 0.7, fontSize: 13, textAlign: "center" }}>{t("sheet.coreMissingHint")}</p>
        </Glass>
      </div>
    );
  }

  if (!active || !state || !cx) {
    return (
      <div className="page wd-page-root">
        <Glass className="wd-empty">
          <EmptyHint icon={FilePlus2} text={t("sheet.emptyHint")} />
          <div className="wd-bs-tiles" style={{ width: "100%" }}>
            {SAMPLES.map((k) => (
              <button
                key={k}
                type="button"
                className="wd-bs-tile"
                disabled={docs.busy}
                onClick={() => create(k)}
              >
                <FilePlus2 size={30} />
                <span>{tw(k === "blank" ? "Blank workbook" : k[0].toUpperCase() + k.slice(1))}</span>
              </button>
            ))}
            <button type="button" className="wd-bs-tile" disabled={docs.busy} onClick={() => fileRef.current?.click()}>
              <FolderOpen size={30} />
              <span>{tw("Open")}</span>
            </button>
          </div>
          <RecoverList auto={auto} tw={tw} />
          {docs.error ? <div className="ph-error">{docs.error}</div> : null}
        </Glass>
        {hiddenInputs}
      </div>
    );
  }

  const base = baseTabs({ draw: true });
  const showPane = pane !== null;

  return (
    <div className="page wd-page-root sh-root">
      <TitleBar cx={cx} name={active.name} commands={commands} auto={auto} />

      <div className="wd-doctabs">
        {docs.docs.map((d) => (
          <div key={d.id} className={`wd-doctab${d.id === docs.activeId ? " active" : ""}`}>
            <button type="button" onClick={() => docs.setActiveId(d.id)}>
              {d.name}
              {d.state.doc.dirty ? " •" : ""}
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
          onClick={() => setBackstage("new")}
          title={tw("New")}
        >
          +
        </button>
      </div>

      {docs.error && (
        <div className="ph-error wd-error" role="alert">
          {docs.error}
          <button type="button" className="wd-x-btn" aria-label={t("word.close")} onClick={() => docs.setError("")}>
            <X size={12} />
          </button>
        </div>
      )}

      <CustomCtx.Provider value={SHEET_CUSTOM}>
        <Ribbon
          cx={cx}
          base={base}
          context={contextTabs(cx)}
          tab={tab}
          setTab={setTab}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
        />
      </CustomCtx.Provider>

      <FormulaBar cx={cx} edit={edit} docs={docs} list={showPane} />

      <div className="wd-main">
        <div className="wd-center sh-center">
          <GridView
            docs={docs}
            state={state}
            docId={active.id}
            edit={edit}
            editApi={editApi}
            selObj={selObj}
            setSelObj={setSelObj}
            onContext={onContext}
            onFilter={(r, c, rect) => setFilter({ r, c, rect })}
            onList={(r, c, rect) => setList({ r, c, rect })}
            shortcuts={shortcuts}
            refs={refs}
            onPoint={onPoint}
            focusKey={focusKey}
            tw={tw}
          />
        </div>
        {pane ? <PaneHost name={pane} cx={cx} docs={docs} onClose={() => setPane(null)} /> : null}
      </div>

      <SheetTabs cx={cx} />
      <StatusBar cx={cx} editMode={edit ? edit.mode : null} />

      {backstage ? (
        <Backstage
          cx={cx}
          page={backstage}
          setPage={setBackstage}
          onClose={() => {
            setBackstage(null);
            focusGrid();
          }}
          create={create}
          openFile={() => fileRef.current?.click()}
        />
      ) : null}
      <DialogHost
        dialog={dialog}
        cx={cx}
        docs={docs}
        onClose={() => {
          setDialog(null);
          focusGrid();
        }}
      />
      <ContextLayer cx={cx} menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      {filter ? (
        <FilterMenu cx={cx} docs={docs} anchor={filter} onClose={() => setFilter(null)} />
      ) : null}
      {list ? <ListPicker cx={cx} anchor={list} onClose={() => setList(null)} /> : null}
      {hiddenInputs}
    </div>
  );
}

export { colName };
