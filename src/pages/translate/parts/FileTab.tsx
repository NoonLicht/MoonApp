import { useRef, useState } from "react";
import { Download, FileText, Languages, Square } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TrStatus } from "@/api/client";
import LangSelect from "@/pages/translate/parts/LangSelect";
import JobStatus from "@/pages/translate/parts/JobStatus";
import { memo, useJob } from "@/pages/translate/parts/useTranslate";
import type { TrSettings } from "@/pages/translate/parts/useTranslate";

/** Перевод файлов: txt/md/srt/vtt/html/docx/epub/pdf. Результат — файл того же формата (PDF → txt). */
export default function FileTab({
  status,
  settings,
  set,
  ready,
  notify,
}: {
  status: TrStatus;
  settings: TrSettings;
  set: (p: Partial<TrSettings>) => void;
  ready: boolean;
  notify: (text: string, ok?: boolean) => void;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(memo.file);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { job, running, start, cancel, error } = useJob("file");

  const pick = (f: File | undefined): void => {
    if (!f) return;
    const ext = `.${f.name.split(".").pop()?.toLowerCase()}`;
    if (!status.fileExt.includes(ext)) {
      notify(t("translate.unsupportedFile", { ext }), false);
      return;
    }
    memo.file = f;
    setFile(f);
  };

  const save = async (): Promise<void> => {
    if (!job) return;
    try {
      const blob = await api.trJobDownload(job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = job.outName || "translation.txt";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify((e as Error).message, false);
    }
  };

  return (
    <Glass style={{ padding: 14 }}>
      <div className="tr-langs">
        <LangSelect
          value={settings.src}
          onChange={(src) => set({ src })}
          codes={status.languages}
          auto
        />
        <span className="muted-sm">→</span>
        <LangSelect
          value={settings.tgt}
          onChange={(tgt) => set({ tgt })}
          codes={status.languages}
        />
      </div>
      <div
        className={`tr-drop ${drag ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files[0]);
        }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
      >
        <FileText size={22} />
        <div>{file ? file.name : t("translate.dropFile")}</div>
        <div className="muted-sm">{status.fileExt.join("  ")}</div>
        <input
          ref={input}
          type="file"
          hidden
          accept={status.fileExt.join(",")}
          onChange={(e) => pick(e.target.files?.[0])}
        />
      </div>
      <div className="tr-foot">
        <span className="muted-sm">{t("translate.fileHint")}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {job?.status === "done" && (
            <Btn variant="primary" icon={Download} onClick={() => void save()}>
              {t("translate.save")}
            </Btn>
          )}
          {running ? (
            <Btn icon={Square} onClick={cancel}>
              {t("translate.cancel")}
            </Btn>
          ) : (
            <Btn
              variant={job?.status === "done" ? "ghost" : "primary"}
              icon={Languages}
              disabled={!ready || !file}
              onClick={() =>
                file &&
                void start(() =>
                  api.trFile(
                    file,
                    {
                      src: settings.src,
                      tgt: settings.tgt,
                      provider: settings.provider,
                      variant: settings.variant,
                    },
                    "file",
                  ),
                )
              }
            >
              {t("translate.run")}
            </Btn>
          )}
        </div>
      </div>
      {job && <JobStatus job={job} />}
      {error && <div className="tn-msg bad">{error}</div>}
    </Glass>
  );
}
