import { useCallback, useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";

type Info = Awaited<ReturnType<typeof api.semFiles>>;

/**
 * Поиск по файлам: папки, из которых берётся текст (PDF, текстовые файлы,
 * картинки через OCR). Результаты появляются в общем поиске приложения.
 */
export function FileSearchRows() {
  const { t } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const i = await api.semFiles();
      setInfo(i);
      setText((cur) => (cur === "" ? i.folders.join("\n") : cur));
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

  const scan = async () => {
    setError("");
    try {
      const folders = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
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
        <Btn icon={FolderSearch} onClick={scan} disabled={s?.running || !text.trim()}>
          {s?.running ? t("settings.fileSearchRunning") : t("settings.fileSearchScan")}
        </Btn>
      </Row>
      <textarea
        className="input"
        rows={3}
        style={{ width: "100%", marginTop: -6 }}
        placeholder={t("settings.fileSearchFolders")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
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
