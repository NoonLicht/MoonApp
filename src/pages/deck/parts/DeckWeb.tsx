import { useI18n } from "@/app/i18n";
import { useMemo } from "react";
import OfficeWeb, { type AssistantHostProps, type OfficeAccess } from "@/components/office/OfficeWeb";
import { DeckAssistant } from "@/components/assistant/DocAssistant";
import type { WcLink } from "@/lib/wcLink";
import type { AsstDeckCx } from "@/pages/deck/assistant";
import { useShellDark } from "@/lib/useShellDark";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * «Презентации»: готовый DeckCraft (веб-сборка на wasm, см. native/office-web). Вкладки, файлы и автосохранение
 * в общем OfficeWeb; язык интерфейса редактора (русский или английский) задаётся в адресе рамки и меняется командой.
 */
/** Название приложения-редактора (имя продукта не переводится). */
const APP = "DeckCraft";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ACCEPT = ".pptx,.potx,.ppsx,.deckcraft,.txt,.md";

/** Состояние, которое присылает редактор (native/office-web: deckcraft embed.rs). */
export interface DeckFrameState {
  open: boolean;
  doc?: { title: string; path: string | null; dirty: boolean; revision: number };
  slides?: number;
  undo?: number;
  sel?: { slide: number; shapes: number };
}

const ACCESS: OfficeAccess<DeckFrameState> = {
  dirty: (s) => !!s?.doc?.dirty,
  rev: (s) => s?.doc?.revision,
  // Безымянная презентация называется «Presentation N» — пусть вкладка будет «Презентация N».
  name: (s) => (s?.doc && !/^(Presentation|Untitled)\s*\d*$/i.test(s.doc.title) ? s.doc.title : undefined),
};
/** Языки приложения → коды языка интерфейса DeckCraft. */
const LANGS: Record<string, string> = { ru: "ru", en: "en" };
const THEME = (mode: "dark" | "light"): [string, unknown] => ["view.dark", { on: mode === "dark" }];
const LANG = (code: string): [string, unknown] => ["ui.language", { language: code }];

function frameCx(
  link: WcLink<DeckFrameState>,
  docId: string,
  docName: string,
  lang: string,
  tw: AsstDeckCx["tw"],
): AsstDeckCx {
  return {
    docId,
    lang,
    tw,
    get s() {
      const st = link.state;
      return { slides: st?.slides ?? 0, slide: st?.sel?.slide ?? 0 };
    },
    ui: { docName },
    query: async <T = unknown,>(method: string, p?: unknown) => {
      try {
        return (await link.run(method, p ?? {})) as T;
      } catch {
        return undefined;
      }
    },
    exec: async (cmd, p) => {
      const r = await link.exec(cmd, p ?? {});
      await link.refresh().catch(() => undefined);
      return r;
    },
    undoDepth: async () => (await link.refresh()).undo ?? 0,
  };
}

/** Помощник презентаций: команды идут в рамку активной презентации; номер слайда обновляется после каждой команды. */
function DeckAssistantHost({ link, docId, docName, onClose }: AssistantHostProps<DeckFrameState>) {
  const { lang } = useI18n();
  const tw = useTw();
  const cx = useMemo(() => frameCx(link, docId, docName, lang, tw), [link, docId, docName, lang, tw]);
  return <DeckAssistant cx={cx} onClose={onClose} />;
}

export default function DeckWeb() {
  const { lang } = useI18n();
  const tw = useTw();
  const dark = useShellDark();
  return (
    <OfficeWeb<DeckFrameState>
      kind="deck"
      frame="/office/deck/index.html"
      title={APP}
      ext="pptx"
      mime={PPTX}
      accept={ACCEPT}
      savedRe={/\.(pptx|deckcraft)$/i}
      langMap={LANGS}
      lang={lang}
      dark={dark}
      tw={tw}
      untitled={tw("Presentation")}
      access={ACCESS}
      themeCmd={THEME}
      langCmd={LANG}
      Assistant={DeckAssistantHost}
      newTitle={tw("New")}
      openTitle={tw("Open")}
      confirmClose={tw("Unsaved changes will be lost. Close anyway?")}
    />
  );
}
