/**
 * Ядро текстового редактора (WordCraft, MIT/Apache-2.0) как сайдкар.
 *
 * Интерфейс страницы «Документы» — наш, на React; движок документа (модель, вёрстка, команды,
 * растеризация страниц, чтение и запись docx/odt/rtf/…) — готовый Rust-бинарник `wordcore`
 * (native/wordcore), который по строке JSON в stdin отвечает строкой JSON в stdout.
 * Один процесс = один открытый документ (у ядра один сеанс на процесс).
 */
import path from "path";
import { createHost, OFFICE_DIR } from "./coreHost";

export { OFFICE_DIR };
export type WordSession = import("./coreHost").CoreSession;

const host = createHost({
  label: "word",
  exe: "wordcore",
  envVar: "MOONAPP_WORDCORE",
  maxSessions: 6,
});

export const { binCandidates, binPath, status, list, get, call, close, closeAll } = host;

const TEMPLATES = ["blank", "sample", "letter", "resume", "report"];
/** Языки, для которых у ядра есть правописание «из коробки». */
const PROOF_LANGS = new Set([
  "ru-RU",
  "pl-PL",
  "pt-BR",
  "it-IT",
  "hr-HR",
  "tr-TR",
  "cs-CZ",
  "en-GB",
]);

/** Открыть новый сеанс: пустой документ/шаблон либо файл с диска. */
export async function open(o: {
  file?: string;
  template?: string;
  name?: string;
  /** Региональные настройки нового документа (формат бумаги и единицы): ru-RU, en-US… */
  region?: string;
  /** Язык проверки правописания нового документа (BCP 47), если ядро его знает. */
  lang?: string;
}): Promise<{ id: string; state: unknown }> {
  return host.start(
    {
      name: o.name || (o.file ? path.basename(o.file) : "Документ"),
      path: o.file || "",
      action: { file: !!o.file, template: o.template || "blank" },
    },
    async (proc) => {
      if (o.region && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(o.region)) {
        await proc
          .call("engine.execute", { command: "file.options", params: { region: o.region } })
          .catch(() => undefined);
      }
      if (o.file) {
        await proc.call("engine.execute", { command: "file.open", params: { path: o.file } });
      } else if (o.template && TEMPLATES.includes(o.template)) {
        // Новый документ создаётся уже с учётом региона (формат бумаги), в том числе пустой.
        await proc.call("engine.execute", { command: "file.new", params: { template: o.template } });
        if (o.lang && PROOF_LANGS.has(o.lang)) {
          await proc
            .call("engine.execute", {
              command: "review.language",
              params: { lang: o.lang, default: true },
            })
            .catch(() => undefined);
        }
      }
      return proc.call("view.state");
    },
  );
}
