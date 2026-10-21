import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Plus, Sparkles, X } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { AutosaveSwitch, RecoverList } from "@/components/DocAutosaveUi";
import { WordAssistant } from "@/components/assistant/DocAssistant";
import { useDocAutosave } from "@/lib/docAutosave";
import { saveBlob } from "@/lib/download";
import type { AsstCx } from "@/pages/word/assistant";
import { useTw } from "@/pages/word/i18n/useTw";
import { WcLink, type WcState } from "@/pages/word/lib/wcLink";

/**
 * «Документы»: готовый WordCraft (веб-сборка на wasm) в рамке, по рамке на каждый открытый документ.
 * Страница отвечает за то, что вокруг: вкладки, файлы, автосохранение, помощник, тема и язык приложения.
 * Редактор шлёт события (`ready`, `state`, `download`), страница — команды (см. lib/wcLink.ts).
 */
const FRAME = "/office/word/index.html";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ACCEPT = ".docx,.docm,.dotx,.dotm,.doc,.odt,.rtf,.txt,.md,.html,.htm";

/** Языки приложения → коды языка интерфейса WordCraft (арабского у него нет — английский). */
const WC_LANG: Record<string, string> = { ru: "ru", en: "en", es: "es", fr: "fr", zh: "zh-hans", ar: "en" };

interface Tab {
  id: string;
  num: number;
  /** Адрес рамки: язык и тема на момент открытия; дальше они меняются командами. */
  src: string;
}

/** Тёмная ли тема приложения (класс на оболочке `.app-shell`). */
function useShellDark(): boolean {
  const read = () => !document.querySelector(".app-shell")?.classList.contains("theme-light");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const el = document.querySelector(".app-shell");
    if (!el) return;
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

export default function WordWeb() {
  const { lang } = useI18n();
  const tw = useTw();
  const dark = useShellDark();
  const wcLang = WC_LANG[lang] ?? "en";
  const wcTheme = dark ? "dark" : "light";

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [asst, setAsst] = useState(false);
  /** Последнее состояние каждого редактора (имя файла, правки, ревизия) — для вкладок и автосохранения. */
  const [info, setInfo] = useState<Record<string, WcState | null>>({});
  /** Имя, которое дал документу файл: открытый или сохранённый (само ядро имя в рамке не хранит). */
  const [names, setNames] = useState<Record<string, string>>({});
  const [links] = useState(() => new Map<string, WcLink>());
  const counter = useRef(0);
  const filePick = useRef<HTMLInputElement>(null);
  const live = useRef({ lang: wcLang, theme: wcTheme });
  useEffect(() => {
    live.current = { lang: wcLang, theme: wcTheme };
  }, [wcLang, wcTheme]);

  const addTab = useCallback((file?: { name: string; bytes: ArrayBuffer }) => {
    const num = ++counter.current;
    const id = `d${num}`;
    const link = new WcLink({
      changed: () => setInfo((m) => ({ ...m, [id]: link.state })),
      download: (name, bytes) => {
        saveBlob(new Blob([bytes as BlobPart]), name);
        // Сохранение документа (а не экспорт в pdf или картинку) называет вкладку по файлу.
        if (/\.(docx|docm|dotx|dotm|odt|rtf)$/i.test(name)) setNames((m) => ({ ...m, [id]: name }));
      },
    });
    if (file) setNames((m) => ({ ...m, [id]: file.name }));
    if (file) link.whenReady(() => void link.open(file.name, file.bytes).catch(() => undefined));
    links.set(id, link);
    const src = `${FRAME}?embed&lang=${live.current.lang}&theme=${live.current.theme}`;
    setTabs((t) => [...t, { id, num, src }]);
    setActiveId(id);
  }, [links]);

  // Первый документ — стартовый экран WordCraft (шаблоны, недавние).
  useEffect(() => {
    if (!links.size) addTab();
  }, [addTab, links]);

  // Сообщения рамок: каждое — в связь той рамки, из которой оно пришло.
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const m = e.data as Record<string, unknown> | null;
      if (!m || m.wc !== 1) return;
      for (const l of links.values()) {
        if (l.win && l.win === e.source) {
          l.handle(m);
          return;
        }
      }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [links]);

  // Уходим со страницы — освобождаем связи (рамки уничтожаются вместе со страницей).
  useEffect(
    () => () => {
      for (const l of links.values()) l.dispose();
      links.clear();
    },
    [links],
  );

  // Тема и язык приложения → в каждый уже открытый редактор.
  useEffect(() => {
    for (const l of links.values()) {
      l.whenReady(() => {
        void l.run("ui.theme", { value: wcTheme }).catch(() => undefined);
        void l.run("ui.language", { value: wcLang }).catch(() => undefined);
      });
    }
  }, [wcLang, wcTheme, links]);

  const nameOf = useCallback(
    (t: Tab): string => names[t.id] || info[t.id]?.fileName || `${tw("Document")} ${t.num}`,
    [tw, info, names],
  );

  const openFile = useCallback(
    async (f: File) => {
      addTab({ name: f.name, bytes: await f.arrayBuffer() });
    },
    [addTab],
  );

  const close = useCallback(
    (id: string) => {
      const link = links.get(id);
      if (info[id]?.dirty && !window.confirm(tw("Unsaved changes will be lost. Close anyway?"))) return;
      link?.dispose();
      links.delete(id);
      const rest = tabs.filter((t) => t.id !== id);
      setTabs(rest);
      if (activeId === id) setActiveId(rest[rest.length - 1]?.id ?? "");
      if (!rest.length) addTab();
    },
    [tabs, activeId, tw, addTab, info, links],
  );

  const auto = useDocAutosave({
    kind: "word",
    ext: "docx",
    items: tabs.map((t) => {
      const st = info[t.id];
      return { id: t.id, name: nameOf(t), dirty: !!st?.dirty, version: st?.rev };
    }),
    exportBlob: async (id) => {
      const link = links.get(id);
      return link ? new Blob([(await link.exportDocx()) as BlobPart], { type: DOCX }) : undefined;
    },
    openFile,
  });

  const active = tabs.find((t) => t.id === activeId);
  const activeLink = active ? links.get(active.id) : undefined;

  // Контекст помощника: команды идут в рамку активного документа, выделение берётся из её последнего состояния.
  const cx = useMemo<AsstCx | null>(() => {
    if (!active || !activeLink) return null;
    const link = activeLink;
    const tab = active;
    return {
      docId: tab.id,
      lang,
      tw,
      get s() {
        const st = link.state;
        return {
          selection: st?.selection ?? null,
          pages: Array.from({ length: st?.pages ?? 1 }),
          words: st?.words ?? 0,
        };
      },
      get ui() {
        return { docName: nameOf(tab) };
      },
      query: async <T = unknown,>(method: string, p?: unknown) => {
        try {
          return (await link.run(method, p ?? {})) as T;
        } catch {
          return undefined;
        }
      },
      exec: (cmd, p) => link.exec(cmd, p ?? {}),
    };
  }, [active, activeLink, lang, tw, nameOf]);

  return (
    <div className="wd-page-root">
      <div className="wd-web-bar">
        <div className="wd-web-tabs">
          {tabs.map((t) => {
            const st = info[t.id];
            return (
              <div key={t.id} className={`wd-doctab${t.id === activeId ? " active" : ""}`}>
                <button type="button" onClick={() => setActiveId(t.id)}>
                  {nameOf(t)}
                  {st?.dirty ? " •" : ""}
                </button>
                <button type="button" className="wd-x-btn" aria-label="×" onClick={() => close(t.id)}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button type="button" className="wd-doctab wd-web-add" onClick={() => addTab()} title={tw("New")}>
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="wd-doctab wd-web-add"
            onClick={() => filePick.current?.click()}
            title={tw("Open a document")}
          >
            <FolderOpen size={13} />
          </button>
          <input
            ref={filePick}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void openFile(f);
            }}
          />
        </div>
        <AutosaveSwitch auto={auto} tw={tw} />
        <button
          type="button"
          className={`wd-title-btn${asst ? " on" : ""}`}
          aria-pressed={asst}
          onClick={() => setAsst((v) => !v)}
        >
          <Sparkles size={13} />
          {tw("Assistant")}
        </button>
      </div>
      <RecoverList auto={auto} tw={tw} />
      <div className="wd-web-body">
        <div className="wd-web-frames">
          {tabs.map((t) => (
            <iframe
              key={t.id}
              className={t.id === activeId ? "on" : ""}
              title="WordCraft"
              src={t.src}
              allow="clipboard-read; clipboard-write; fullscreen"
              ref={(el) => {
                const l = links.get(t.id);
                if (l) l.win = el?.contentWindow ?? null;
              }}
            />
          ))}
        </div>
        {asst && cx ? (
          <aside className="wd-web-side">
            <WordAssistant cx={cx} onClose={() => setAsst(false)} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
