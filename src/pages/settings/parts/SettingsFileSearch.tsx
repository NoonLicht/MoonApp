import { useCallback, useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import FolderInput from "@/components/FolderInput";
import { Row } from "@/pages/settings/parts/SettingsControls";

type Info = Awaited<ReturnType<typeof api.semFiles>>;

/**
 * Поиск по файлам: папки, из которых берётся текст (PDF, текстовые файлы,
 * картинки через OCR). Папки добавляются через окно проводника, а не вводом
 * пути руками. Результаты появляются в общем поиске приложения.
 */
export function FileSearchRows() {
  const { t } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const i = await api.semFiles();
      setInfo(i);
      setFolders((cur) => (cur.length === 0 ? i.folders : cur));
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!info?.scan.running) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [info?.scan.running, load]);

  const save = async (next: string[]) => {
    setFolders(next);
    try {
      await api.semFilesSetFolders(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const scan = async () => {
    setError("");
    try {
      await api.semFilesSetFolders(folders);
      await api.semFilesScan();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const s = info?.scan;
  return (
    <>
      <Row label={t("settings.fileSearch")} hint={t("settings.fileSearchHint")}>
        <Btn icon={FolderSearch} onClick={scan} disabled={s?.running || folders.length === 0}>
          {s?.running ? t("settings.fileSearchRunning") : t("settings.fileSearchScan")}
        </Btn>
      </Row>
      <div className="fs-folders">
        {loaded &&
          folders.map((f) => (
            <span key={f} className="fs-folder">
              <span className="fs-folder-path" title={f}>
                {f}
              </span>
              <button
                type="button"
                aria-label={t("common.delete")}
                onClick={() => void save(folders.filter((x) => x !== f))}
              >
                ×
              </button>
            </span>
          ))}
        <FolderInput
          value=""
          placeholder={t("settings.fileSearchFolders")}
          onChange={(p) => {
            if (p && !folders.includes(p)) void save([...folders, p]);
          }}
        />
      </div>
      {s && s.total > 0 && (
        <div className="muted-sm">
          {t("settings.fileSearchProgress", {
            done: s.done,
            total: s.total,
            indexed: s.indexed,
            failed: s.failed,
          })}
        </div>
      )}
      {(error || s?.error) && (
        <div className="muted-sm" style={{ color: "var(--danger, #e66)" }}>
          {error || s?.error}
        </div>
      )}
    </>
  );
}
