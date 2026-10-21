import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { FolderOpen, Plus, Sparkles, X } from "lucide-react";
import { AutosaveSwitch, RecoverList } from "@/components/DocAutosaveUi";
import { useDocAutosave, type AutosaveKind } from "@/lib/docAutosave";
import { saveBlob } from "@/lib/download";
import { WcLink } from "@/lib/wcLink";

/**
 * Страница офисного приложения на готовой веб-сборке (WordCraft, GridCraft; wasm): по рамке на каждый
 * документ и всё, что вокруг: вкладки, открытие и сохранение файлов, автосохранение, помощник, тема и язык
 * приложения. Редактор шлёт события (`ready`, `state`, `download`), страница — команды (см. lib/wcLink.ts).
 */
type Tw = (en: string, vars?: Record<string, string | number>) => string;

/** Что нужно знать о состоянии редактора: сохранено ли, версия и имя файла. */
export interface OfficeAccess<S> {
  dirty: (s: S | null) => boolean;
  rev: (s: S | null) => unknown;
  /** Имя документа, которое хранит сам редактор (нет — вкладка называется «Документ N»). */
  name: (s: S | null) => string | undefined;
}

/** Панель помощника: компонент получает связь с рамкой активного документа. */
export interface AssistantHostProps<S> {
  link: WcLink<S>;
  docId: string;
  docName: string;
  onClose: () => void;
}

interface Props<S> {
  kind: AutosaveKind;
  /** Адрес страницы редактора (без параметров). */
  frame: string;
  title: string;
  ext: string;
  mime: string;
  accept: string;
  /** Имя файла сохранённого документа (а не экспорта в pdf или картинку). */
  savedRe: RegExp;
  /** Язык приложения → код языка интерфейса редактора. */
  langMap: Record<string, string>;
  lang: string;
  dark: boolean;
  tw: Tw;
  /** Как называть вкладку без файла: «Документ» или «Книга». */
  untitled: string;
  access: OfficeAccess<S>;
  /** Команды, которыми редактору меняют тему и язык на ходу. */
  themeCmd: (mode: "dark" | "light") => [string, unknown];
  langCmd: (code: string) => [string, unknown];
  Assistant: ComponentType<AssistantHostProps<S>>;
  newTitle: string;
  openTitle: string;
  confirmClose: string;
}

export default function OfficeWeb<S>(p: Props<S>) {
  const { kind, frame, ext, access } = p;
  const code = p.langMap[p.lang] ?? "en";
  const mode = p.dark ? "dark" : "light";

  interface Tab {
    id: string;
    num: number;
    /** Адрес рамки: язык и тема на момент открытия; дальше они меняются командами. */
    src: string;
  }
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [asst, setAsst] = useState(false);
  /** Последнее состояние каждого редактора — для вкладок и автосохранения. */
  const [info, setInfo] = useState<Record<string, S | null>>({});
  /** Имя, которое дал документу файл: открытый или сохранённый (рамка своего имени не хранит). */
  const [names, setNames] = useState<Record<string, string>>({});
  const [links] = useState(() => new Map<string, WcLink<S>>());
  const counter = useRef(0);
  const filePick = useRef<HTMLInputElement>(null);
  const live = useRef({ code, mode });
  useEffect(() => {
    live.current = { code, mode };
  }, [code, mode]);

  const addTab = useCallback(
    (file?: { name: string; bytes: ArrayBuffer }) => {
      const num = ++counter.current;
      const id = `d${num}`;
      const link = new WcLink<S>({
        changed: () => setInfo((m) => ({ ...m, [id]: link.state })),
        download: (name, bytes) => {
          saveBlob(new Blob([bytes as BlobPart]), name);
          if (p.savedRe.test(name)) setNames((m) => ({ ...m, [id]: name }));
        },
      });
      if (file) {
        setNames((m) => ({ ...m, [id]: file.name }));
        link.whenReady(() => void link.open(file.name, file.bytes).catch(() => undefined));
      }
      links.set(id, link);
      const src = `${frame}?embed&lang=${live.current.code}&theme=${live.current.mode}`;
      setTabs((t) => [...t, { id, num, src }]);
      setActiveId(id);
    },
    [frame, links, p.savedRe],
  );

  // Первый документ — стартовый экран редактора (шаблоны, недавние).
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
  const { themeCmd, langCmd } = p;
  useEffect(() => {
    for (const l of links.values()) {
      l.whenReady(() => {
        const [tc, tp] = themeCmd(mode);
        const [lc, lp] = langCmd(code);
        void l.run(tc, tp).catch(() => undefined);
        void l.run(lc, lp).catch(() => undefined);
      });
    }
  }, [code, mode, links, themeCmd, langCmd]);

  const nameOf = useCallback(
    (t: { id: string; num: number }): string =>
      names[t.id] || access.name(info[t.id] ?? null) || `${p.untitled} ${t.num}`,
    [names, info, access, p.untitled],
  );

  const openFile = useCallback(
    async (f: File) => {
      addTab({ name: f.name, bytes: await f.arrayBuffer() });
    },
    [addTab],
  );

  const close = useCallback(
    (id: string) => {
      if (access.dirty(info[id] ?? null) && !window.confirm(p.confirmClose)) return;
      links.get(id)?.dispose();
      links.delete(id);
      const rest = tabs.filter((t) => t.id !== id);
      setTabs(rest);
      if (activeId === id) setActiveId(rest[rest.length - 1]?.id ?? "");
      if (!rest.length) addTab();
    },
    [tabs, activeId, addTab, info, links, access, p.confirmClose],
  );

  const auto = useDocAutosave({
    kind,
    ext,
    items: tabs.map((t) => {
      const st = info[t.id] ?? null;
      return { id: t.id, name: nameOf(t), dirty: access.dirty(st), version: access.rev(st) };
    }),
    exportBlob: async (id) => {
      const link = links.get(id);
      return link ? new Blob([(await link.exportFile(`document.${ext}`)) as BlobPart], { type: p.mime }) : undefined;
    },
    openFile,
  });

  const active = tabs.find((t) => t.id === activeId);
  const activeLink = active ? links.get(active.id) : undefined;
  const Assistant = p.Assistant;

  return (
    <div className="wd-page-root">
      <div className="wd-web-bar">
        <div className="wd-web-tabs">
          {tabs.map((t) => (
            <div key={t.id} className={`wd-doctab${t.id === activeId ? " active" : ""}`}>
              <button type="button" onClick={() => setActiveId(t.id)}>
                {nameOf(t)}
                {access.dirty(info[t.id] ?? null) ? " •" : ""}
              </button>
              <button type="button" className="wd-x-btn" aria-label="×" onClick={() => close(t.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
          <button type="button" className="wd-doctab wd-web-add" onClick={() => addTab()} title={p.newTitle}>
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="wd-doctab wd-web-add"
            onClick={() => filePick.current?.click()}
            title={p.openTitle}
          >
            <FolderOpen size={13} />
          </button>
          <input
            ref={filePick}
            type="file"
            accept={p.accept}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void openFile(f);
            }}
          />
        </div>
        <AutosaveSwitch auto={auto} tw={p.tw} />
        <button
          type="button"
          className={`wd-title-btn${asst ? " on" : ""}`}
          aria-pressed={asst}
          onClick={() => setAsst((v) => !v)}
        >
          <Sparkles size={13} />
          {p.tw("Assistant")}
        </button>
      </div>
      <RecoverList auto={auto} tw={p.tw} />
      <div className="wd-web-body">
        <div className="wd-web-frames">
          {tabs.map((t) => (
            <iframe
              key={t.id}
              className={t.id === activeId ? "on" : ""}
              title={p.title}
              src={t.src}
              allow="clipboard-read; clipboard-write; fullscreen"
              ref={(el) => {
                const l = links.get(t.id);
                if (l) l.win = el?.contentWindow ?? null;
              }}
            />
          ))}
        </div>
        {asst && active && activeLink ? (
          <aside className="wd-web-side">
            <Assistant
              link={activeLink}
              docId={active.id}
              docName={nameOf(active)}
              onClose={() => setAsst(false)}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
