import { useMemo } from "react";
import { useI18n } from "@/app/i18n";
import OfficeWeb, { type AssistantHostProps, type OfficeAccess } from "@/components/office/OfficeWeb";
import { SheetAssistant } from "@/components/assistant/DocAssistant";
import { useShellDark } from "@/lib/useShellDark";
import type { AsstSheetCx } from "@/pages/sheet/assistant";
import { useTw } from "@/pages/sheet/i18n/useTw";
import type { WcLink } from "@/lib/wcLink";

/**
 * «Таблицы»: готовый GridCraft (веб-сборка на wasm, см. native/office-web). Всё вокруг редактора —
 * вкладки, файлы, автосохранение — в общем OfficeWeb; здесь то, что относится именно к таблицам.
 */
/** Название приложения-редактора (имя продукта не переводится). */
const APP = "GridCraft";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ACCEPT = ".xlsx,.xlsm,.xls,.xlsb,.ods,.csv,.tsv,.txt,.json";
/** Языки приложения → коды языка интерфейса GridCraft . */
const LANGS: Record<string, string> = { ru: "ru", en: "en" };

/** Состояние, которое присылает редактор (native/office-web: gridcraft embed.rs). */
export interface SheetFrameState {
  open: boolean;
  doc?: { title: string; path: string | null; dirty: boolean; revision: number };
  sheets?: Array<{ i: number; name: string }>;
  active?: number;
  sel?: { a1: string };
}

const ACCESS: OfficeAccess<SheetFrameState> = {
  dirty: (s) => !!s?.doc?.dirty,
  rev: (s) => s?.doc?.revision,
  // «Book1» — безымянная книга: пусть вкладка называется «Книга N».
  name: (s) => (s?.doc && !/^Book\d*$/.test(s.doc.title) ? s.doc.title : undefined),
};
const THEME = (mode: "dark" | "light"): [string, unknown] => ["view.theme", { mode }];
const LANG = (code: string): [string, unknown] => ["app.language.set", { language: code }];

function frameCx(link: WcLink<SheetFrameState>, docId: string, docName: string, lang: string, tw: AsstSheetCx["tw"]): AsstSheetCx {
  return {
    docId,
    lang,
    tw,
    get s() {
      const st = link.state;
      return { sheets: st?.sheets ?? [], active: st?.active ?? 0, sel: { a1: st?.sel?.a1 ?? "A1" } };
    },
    ui: { docName },
    query: async <T = unknown,>(method: string, p?: unknown) => {
      try {
        return (await link.run(method, p ?? {})) as T;
      } catch {
        return undefined;
      }
    },
    exec: (cmd, p) => link.exec(cmd, p ?? {}),
  };
}

/** Помощник таблиц: команды идут в рамку активной книги, листы и выделение берутся из её последнего состояния. */
function SheetAssistantHost({ link, docId, docName, onClose }: AssistantHostProps<SheetFrameState>) {
  const { lang } = useI18n();
  const tw = useTw();
  const cx = useMemo(() => frameCx(link, docId, docName, lang, tw), [link, docId, docName, lang, tw]);
  return <SheetAssistant cx={cx} onClose={onClose} />;
}

export default function SheetWeb() {
  const { lang } = useI18n();
  const tw = useTw();
  const dark = useShellDark();
  return (
    <OfficeWeb<SheetFrameState>
      kind="sheet"
      frame="/office/sheet/index.html"
      title={APP}
      ext="xlsx"
      mime={XLSX}
      accept={ACCEPT}
      savedRe={/\.(xlsx|xlsm)$/i}
      langMap={LANGS}
      lang={lang}
      dark={dark}
      tw={tw}
      untitled={tw("Workbook")}
      access={ACCESS}
      themeCmd={THEME}
      langCmd={LANG}
      Assistant={SheetAssistantHost}
      newTitle={tw("New")}
      openTitle={tw("Open")}
      confirmClose={tw("Unsaved changes will be lost. Close anyway?")}
    />
  );
}
