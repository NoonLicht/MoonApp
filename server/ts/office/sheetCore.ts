/**
 * Ядро электронных таблиц (GridCraft, MIT/Apache-2.0) как сайдкар.
 *
 * Интерфейс страницы «Таблицы» — наш, на React; движок книги (модель, формулы, 500+ функций,
 * диаграммы, сводные таблицы, чтение и запись xlsx/csv/…) — готовый Rust-бинарник `gridcore`
 * (native/gridcore), который по строке JSON в stdin отвечает строкой JSON в stdout.
 * Один процесс = одна открытая книга.
 */
import path from "path";
import { createHost, OFFICE_DIR } from "./coreHost";

export { OFFICE_DIR };

const host = createHost({
  label: "sheet",
  exe: "gridcore",
  envVar: "MOONAPP_GRIDCORE",
  maxSessions: 8,
});

export const { binCandidates, binPath, status, list, get, call, close, closeAll } = host;

const SAMPLES = ["budget", "sales", "grades"];

/** Открыть новый сеанс: пустая книга, готовый образец либо файл с диска. */
export async function open(o: {
  file?: string;
  sample?: string;
  name?: string;
  password?: string;
}): Promise<{ id: string; state: unknown }> {
  return host.start(
    {
      name: o.name || (o.file ? path.basename(o.file) : "Книга"),
      path: o.file || "",
      action: { file: !!o.file, sample: o.sample || "blank" },
    },
    async (proc) => {
      if (o.file) {
        await proc.call("engine.execute", {
          command: "file.open",
          params: { path: o.file, ...(o.password ? { password: o.password } : {}) },
        });
      } else if (o.sample && SAMPLES.includes(o.sample)) {
        await proc.call("engine.execute", { command: "file.new", params: { sample: o.sample } });
      }
      return proc.call("view.init");
    },
  );
}
