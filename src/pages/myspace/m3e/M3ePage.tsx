import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/app/i18n";
import M3eEditor from "@/pages/myspace/m3e/M3eEditor";
import type { M3eEditorHandle } from "@/pages/myspace/m3e/M3eEditor";
import { isUiLang, type UiLang } from "@/pages/myspace/m3e/lib/i18n";
import type { Doc } from "@/pages/myspace/m3e/lib/tokens";
import PagesBar, { pageLabel } from "@/pages/myspace/m3e/pages/PagesBar";
import PagesOverview, { useAllDocs } from "@/pages/myspace/m3e/pages/PagesOverview";
import PageSwitcher from "@/pages/myspace/m3e/pages/PageSwitcher";
import { useWorkbook } from "@/pages/myspace/m3e/pages/useWorkbook";
import {
  blankDoc,
  downloadText,
  fileNameFor,
  parseDoc,
  projectText,
} from "@/pages/myspace/m3e/pages/docUtil";
import "@/styles/m3e.css";
import "@/styles/m3e-pages.css";

const LANG_KEY = "moonapp.m3e.lang";

function storedLang(appLang: string): UiLang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (isUiLang(v)) return v;
  } catch {
    /* хранилище недоступно */
  }
  return appLang === "ru" ? "ru" : "en";
}

interface Toast {
  text: string;
  undo?: () => void;
}

/** Вкладка «M3E» в «Моём пространстве»: холст эскизов интерфейсов Material 3 Expressive со страницами. */
export default function M3ePage() {
  const { t, lang: appLang } = useI18n();
  const [uiLang, setUiLang] = useState<UiLang>(() => storedLang(appLang));
  const wbk = useWorkbook(uiLang === "ru" ? "Главная" : "Home");
  const { wb, active } = wbk;
  const handle = useRef<M3eEditorHandle | null>(null);
  const ready = useRef(false);
  const root = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [overview, setOverview] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dropping, setDropping] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const say = useCallback((text: string, undo?: () => void) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 9000 : 3500);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const pages = wb?.pages ?? [];
  const activeId = active?.id ?? null;
  // Пока редактор нового ключа не сообщил «готов», его первые отправки документа не сохраняются.
  useEffect(() => {
    ready.current = false;
  }, [activeId]);
  const modalOpen = overview || switcher;
  const allDocs = useAllDocs(pages, wbk.readDoc, modalOpen);

  const nameOf = useCallback(
    (id: string) => {
      const i = pages.findIndex((p) => p.id === id);
      return i < 0 ? "" : pageLabel(pages[i], i, t);
    },
    [pages, t],
  );

  const openPage = useCallback(
    (id: string, screen?: string) => {
      setOverview(false);
      setSwitcher(false);
      if (id === activeId) {
        if (screen) handle.current?.focusFrame(screen);
        return;
      }
      void wbk.open(id, screen ?? null);
    },
    [activeId, wbk],
  );

  const newPage = useCallback(
    async (kind: "blank" | "demo" | "copy") => {
      try {
        if (kind === "copy" && activeId)
          await wbk.duplicate(activeId, t("myspace.m3e.duplicateOf", { name: nameOf(activeId) }));
        else if (kind === "demo") await wbk.create("");
        else await wbk.createBlank();
      } catch (e) {
        say((e as Error).message);
      }
    },
    [activeId, wbk, t, nameOf, say],
  );

  const removePage = useCallback(
    async (id: string) => {
      const name = nameOf(id);
      try {
        const gone = await wbk.remove(id);
        if (gone)
          say(
            t("myspace.m3e.deleted", { name }),
            () => void wbk.restore(gone.id).then(() => say(t("myspace.m3e.restored", { name }))),
          );
      } catch (e) {
        say((e as Error).message);
      }
    },
    [activeId, nameOf, wbk, say, t],
  );

  const renamePage = useCallback(
    (id: string, title: string) => {
      if (id === activeId && handle.current) handle.current.setTitle(title);
      else void wbk.retitleClosed(id, title).catch((e: Error) => say(e.message));
    },
    [activeId, wbk, say],
  );

  const exportPage = useCallback(
    async (id: string) => {
      try {
        const text = await wbk.readDoc(id);
        const doc = parseDoc(text);
        const title = pages.find((p) => p.id === id)?.title ?? "";
        downloadText(
          fileNameFor(title),
          JSON.stringify(doc ?? JSON.parse(blankDoc("Home")), null, 2),
        );
      } catch (e) {
        say((e as Error).message);
      }
    },
    [wbk, pages, say],
  );

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      let added = 0;
      for (const f of Array.from(files)) {
        if (!/\.json$/i.test(f.name) && f.type !== "application/json") continue;
        const text = projectText(await f.text());
        if (!text) {
          say(t("myspace.m3e.invalidFile"));
          continue;
        }
        try {
          await wbk.create(text);
          added++;
        } catch (e) {
          say((e as Error).message);
        }
      }
      if (added > 0) say(t("myspace.m3e.importMany", { n: added }));
    },
    [wbk, say, t],
  );

  // Горячие клавиши страниц. Редактор слушает свои клавиши сам; здесь только переходы между страницами.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!root.current || modalOpen || !pages.length) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && k === "k") {
        e.preventDefault();
        setSwitcher(true);
        return;
      }
      if (mod && e.altKey && k === "n") {
        e.preventDefault();
        void newPage("blank");
        return;
      }
      const t0 = e.target as HTMLElement | null;
      if (t0 && (t0.tagName === "INPUT" || t0.tagName === "TEXTAREA" || t0.isContentEditable))
        return;
      if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const i = pages.findIndex((p) => p.id === activeId);
        const j = i + (e.key === "ArrowRight" ? 1 : -1);
        if (i >= 0 && j >= 0 && j < pages.length) openPage(pages[j].id);
        return;
      }
      if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
        const target = pages[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          openPage(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pages, activeId, modalOpen, newPage, openPage]);

  const onDocChange = useCallback(
    (doc: Doc) => {
      if (!ready.current || !activeId) return;
      wbk.onDocChange(activeId, doc);
    },
    [activeId, wbk],
  );

  const onLang = useCallback((l: UiLang) => {
    setUiLang(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* без запоминания */
    }
  }, []);

  if (wbk.error && !active) {
    return (
      <div className="m3p-state" role="alert">
        <p>{t("myspace.m3e.loadFailed", { error: wbk.error })}</p>
        <button type="button" className="m3p-btn" onClick={() => void wbk.reload()}>
          {t("myspace.m3e.retry")}
        </button>
      </div>
    );
  }
  if (!wb || !active) return <div className="m3p-state">{t("myspace.m3e.loading")}</div>;

  return (
    <div
      ref={root}
      className="m3p-root"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setDropping(false);
          void importFiles(e.dataTransfer.files);
        }
      }}
    >
      <PagesBar
        pages={pages}
        activeId={activeId}
        save={wbk.save}
        onOpen={openPage}
        onNew={(k) => void newPage(k)}
        onImport={() => fileInput.current?.click()}
        onRename={renamePage}
        onDuplicate={(id) => {
          void wbk
            .duplicate(id, t("myspace.m3e.duplicateOf", { name: nameOf(id) }))
            .catch((e: Error) => say(e.message));
        }}
        onDelete={(id) => void removePage(id)}
        onPin={(id, pinned) => wbk.patchPage(id, { pinned })}
        onColor={(id, color) => wbk.patchPage(id, { color })}
        onReorder={wbk.reorder}
        onExport={(id) => void exportPage(id)}
        onOverview={() => setOverview(true)}
      />
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="m3p-stage">
        <M3eEditor
          key={active.id}
          pageId={active.id}
          initialLang={uiLang}
          onLangChange={onLang}
          initialDoc={active.doc}
          initialFocusFrame={active.focus}
          onDocChange={onDocChange}
          handleRef={handle}
          onReady={() => {
            ready.current = true;
          }}
        />
        {wbk.busy && <div className="m3p-busy">{t("myspace.m3e.loading")}</div>}
        {dropping && <div className="m3p-drop">{t("myspace.m3e.dropHint")}</div>}
      </div>
      {toast && (
        <div className="m3p-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              {t("myspace.m3e.undo")}
            </button>
          )}
        </div>
      )}
      {overview && (
        <PagesOverview
          pages={pages}
          trash={wb.trash}
          activeId={activeId}
          docs={allDocs}
          onOpen={openPage}
          onDuplicate={(id) => {
            setOverview(false);
            void wbk
              .duplicate(id, t("myspace.m3e.duplicateOf", { name: nameOf(id) }))
              .catch((e: Error) => say(e.message));
          }}
          onDelete={(id) => void removePage(id)}
          onExport={(id) => void exportPage(id)}
          onPin={(id, pinned) => wbk.patchPage(id, { pinned })}
          onRestore={(id) => {
            setOverview(false);
            void wbk.restore(id);
          }}
          onPurge={(id) => void wbk.purge(id)}
          onClose={() => setOverview(false)}
        />
      )}
      {switcher && (
        <PageSwitcher
          pages={pages}
          docs={allDocs}
          activeId={activeId}
          onPick={openPage}
          onClose={() => setSwitcher(false)}
        />
      )}
    </div>
  );
}
