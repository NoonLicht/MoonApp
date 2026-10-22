import { useI18n } from "@/app/i18n";
import OfficeWeb, { type OfficeAccess } from "@/components/office/OfficeWeb";
import { useShellDark } from "@/lib/useShellDark";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * «Фоторедактор»: готовый PhotoCraft (веб-сборка на wasm, см. native/office-web). Вкладки, файлы и автосохранение
 * в общем OfficeWeb; язык задаётся в адресе рамки и меняется командой настройки `interface.language`.
 * Автосохранение и экспорт — в родном формате .pcraft (слои сохраняются).
 */
/** Название приложения-редактора (имя продукта не переводится). */
const APP = "PhotoCraft";
const ACCEPT = ".pcraft,.psd,.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,.gif,.svg,.avif,.heic,image/*";

/** Состояние, которое присылает редактор (native/office-web: photocraft embed.rs). */
export interface PhotoFrameState {
  open: boolean;
  docs?: number;
  doc?: { name: string; path: string | null; dirty: boolean; revision: number };
  size?: [number, number];
}

const ACCESS: OfficeAccess<PhotoFrameState> = {
  dirty: (s) => !!s?.doc?.dirty,
  rev: (s) => s?.doc?.revision,
  // Безымянный документ называется «Untitled-N»: вкладка получит своё имя.
  name: (s) => (s?.doc && !/^(Untitled|Без имени)[\s-]*\d*$/i.test(s.doc.name) ? s.doc.name : undefined),
};
/** Языки приложения → коды языка интерфейса PhotoCraft. */
const LANGS: Record<string, string> = { ru: "ru", en: "en" };
const THEME = (mode: "dark" | "light"): [string, unknown] => ["ui.set", { theme: mode === "dark" ? "pro" : "proLightGray" }];
const LANG = (code: string): [string, unknown] => [
  "engine.execute",
  { command: "prefs.set", params: { path: "interface.language", value: code } },
];

export default function PhotoWeb() {
  const { lang } = useI18n();
  const tw = useTw();
  const dark = useShellDark();
  return (
    <OfficeWeb<PhotoFrameState>
      kind="photoedit"
      frame="/office/photo/index.html"
      title={APP}
      ext="pcraft"
      mime="application/octet-stream"
      accept={ACCEPT}
      savedRe={/\.(pcraft|psd|png|jpe?g|webp|tiff?|bmp)$/i}
      langMap={LANGS}
      lang={lang}
      dark={dark}
      tw={tw}
      untitled={tw("Image")}
      access={ACCESS}
      themeCmd={THEME}
      langCmd={LANG}
      newTitle={tw("New")}
      openTitle={tw("Open")}
      confirmClose={tw("Unsaved changes will be lost. Close anyway?")}
    />
  );
}
