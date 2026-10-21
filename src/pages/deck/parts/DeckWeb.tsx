import { useI18n } from "@/app/i18n";
import OfficeWeb, { type OfficeAccess } from "@/components/office/OfficeWeb";
import { useShellDark } from "@/lib/useShellDark";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * «Презентации»: готовый DeckCraft (веб-сборка на wasm, см. native/office-web). Вкладки, файлы и автосохранение
 * в общем OfficeWeb; помощника для слайдов пока нет, язык интерфейса у редактора один (английский).
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
  sel?: { slide: number; shapes: number };
}

const ACCESS: OfficeAccess<DeckFrameState> = {
  dirty: (s) => !!s?.doc?.dirty,
  rev: (s) => s?.doc?.revision,
  // Безымянная презентация называется «Presentation N» — пусть вкладка будет «Презентация N».
  name: (s) => (s?.doc && !/^(Presentation|Untitled)\s*\d*$/i.test(s.doc.title) ? s.doc.title : undefined),
};
const THEME = (mode: "dark" | "light"): [string, unknown] => ["view.dark", { on: mode === "dark" }];

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
      langMap={{}}
      lang={lang}
      dark={dark}
      tw={tw}
      untitled={tw("Presentation")}
      access={ACCESS}
      themeCmd={THEME}
      newTitle={tw("New")}
      openTitle={tw("Open")}
      confirmClose={tw("Unsaved changes will be lost. Close anyway?")}
    />
  );
}
