import { useI18n } from "@/app/i18n";
import OfficeWeb, { type OfficeAccess } from "@/components/office/OfficeWeb";
import { useShellDark } from "@/lib/useShellDark";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * «PDF»: готовый PdfCraft (веб-сборка на wasm, см. native/office-web). Вкладки, файлы и автосохранение
 * в общем OfficeWeb; язык и тема редактора задаются в адресе рамки и меняются командой `ui.set`.
 */
/** Название приложения-редактора (имя продукта не переводится). */
const APP = "PdfCraft";

/** Состояние, которое присылает редактор (native/office-web: pdfcraft embed.rs). */
export interface PdfFrameState {
  open: boolean;
  docs?: number;
  doc?: { name: string; path: string | null; dirty: boolean; revision: number };
  pages?: number;
  page?: number;
  zoom?: number;
}

const ACCESS: OfficeAccess<PdfFrameState> = {
  dirty: (s) => !!s?.doc?.dirty,
  rev: (s) => s?.doc?.revision,
  name: (s) => s?.doc?.name,
};
/** Языки приложения → коды языка интерфейса PdfCraft. */
const LANGS: Record<string, string> = { ru: "ru", en: "en" };
const THEME = (mode: "dark" | "light"): [string, unknown] => ["ui.set", { key: "theme", value: mode }];
const LANG = (code: string): [string, unknown] => ["ui.set", { key: "language", value: code }];

export default function PdfWeb() {
  const { lang } = useI18n();
  const tw = useTw();
  const dark = useShellDark();
  return (
    <OfficeWeb<PdfFrameState>
      kind="pdf"
      frame="/office/pdf/index.html"
      title={APP}
      ext="pdf"
      mime="application/pdf"
      accept=".pdf"
      savedRe={/\.pdf$/i}
      langMap={LANGS}
      lang={lang}
      dark={dark}
      tw={tw}
      untitled="PDF"
      access={ACCESS}
      themeCmd={THEME}
      langCmd={LANG}
      newTitle={tw("New")}
      openTitle={tw("Open")}
      confirmClose={tw("Unsaved changes will be lost. Close anyway?")}
    />
  );
}
