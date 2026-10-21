import { useMemo } from "react";
import { useI18n } from "@/app/i18n";
import OfficeWeb, { type AssistantHostProps, type OfficeAccess } from "@/components/office/OfficeWeb";
import { WordAssistant } from "@/components/assistant/DocAssistant";
import { useShellDark } from "@/lib/useShellDark";
import type { WcState } from "@/lib/wcLink";
import type { AsstCx } from "@/pages/word/assistant";
import { useTw } from "@/pages/word/i18n/useTw";

/**
 * «Документы»: готовый WordCraft (веб-сборка на wasm, см. native/office-web). Всё вокруг редактора —
 * вкладки, файлы, автосохранение — в общем OfficeWeb; здесь то, что относится именно к Word.
 */
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ACCEPT = ".docx,.docm,.dotx,.dotm,.doc,.odt,.rtf,.txt,.md,.html,.htm";
/** Языки приложения → коды языка интерфейса WordCraft (арабского и китайского шрифтов в веб-сборке нет — английский). */
const LANGS: Record<string, string> = { ru: "ru", en: "en", es: "es", fr: "fr", zh: "en", ar: "en" };

const ACCESS: OfficeAccess<WcState> = {
  dirty: (s) => !!s?.dirty,
  rev: (s) => s?.rev,
  name: (s) => s?.fileName ?? undefined,
};
const THEME = (mode: "dark" | "light"): [string, unknown] => ["ui.theme", { value: mode }];
const LANG = (code: string): [string, unknown] => ["ui.language", { value: code }];

/** Помощник Word: команды идут в рамку активного документа, выделение берётся из её последнего состояния. */
function WordAssistantHost({ link, docId, docName, onClose }: AssistantHostProps<WcState>) {
  const { lang } = useI18n();
  const tw = useTw();
  const cx = useMemo<AsstCx>(
    () => ({
      docId,
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
      ui: { docName },
      query: async <T = unknown,>(method: string, p?: unknown) => {
        try {
          return (await link.run(method, p ?? {})) as T;
        } catch {
          return undefined;
        }
      },
      exec: (cmd, p) => link.exec(cmd, p ?? {}),
    }),
    [link, docId, docName, lang, tw],
  );
  return <WordAssistant cx={cx} onClose={onClose} />;
}

export default function WordWeb() {
  const { lang } = useI18n();
  const tw = useTw();
  const dark = useShellDark();
  return (
    <OfficeWeb<WcState>
      kind="word"
      frame="/office/word/index.html"
      title="WordCraft"
      ext="docx"
      mime={DOCX}
      accept={ACCEPT}
      savedRe={/\.(docx|docm|dotx|dotm|odt|rtf)$/i}
      langMap={LANGS}
      lang={lang}
      dark={dark}
      tw={tw}
      untitled={tw("Document")}
      access={ACCESS}
      themeCmd={THEME}
      langCmd={LANG}
      Assistant={WordAssistantHost}
      newTitle={tw("New")}
      openTitle={tw("Open a document")}
      confirmClose={tw("Unsaved changes will be lost. Close anyway?")}
    />
  );
}
