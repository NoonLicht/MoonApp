import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";
import { saveBlob } from "@/lib/download";

type Kind = "obsidian" | "notion" | "anki-basic" | "anki-cloze";

/**
 * Обмен заметками: архив Obsidian/Notion → в хранилище, хранилище → архив,
 * карточки «вопрос :: ответ» и пропуски {{c1::…}} → TSV для Anki.
 */
export function InterchangeRows() {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"obsidian" | "notion">("obsidian");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      const m = (e as Error).message;
      setMsg(
        /no_notes/.test(m)
          ? t("settings.interchangeNoNotes")
          : /no_cards/.test(m)
            ? t("settings.interchangeNoCards")
            : m,
      );
    } finally {
      setBusy(false);
    }
  };

  const download = (kind: Kind) =>
    run(async () => {
      const { blob, name } = await api.interchangeDownload(kind);
      saveBlob(blob, name);
    });

  const pick = (file: File) =>
    run(async () => {
      const r = await api.interchangeImport(file, source, source === "notion" ? "Notion" : "Obsidian");
      setMsg(
        t("settings.interchangeDone", {
          n: r.imported,
          renamed: r.renamed,
          skipped: r.skippedAttachments,
        }),
      );
    });

  return (
    <>
      <Row label={t("settings.interchangeImport")} hint={t("settings.interchangeImportHint")}>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            className="input"
            value={source}
            onChange={(e) => setSource(e.target.value as "obsidian" | "notion")}
          >
            <option value="obsidian">Obsidian</option>
            <option value="notion">Notion</option>
          </select>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void pick(f);
            }}
          />
          <Btn icon={Upload} disabled={busy} onClick={() => fileRef.current?.click()}>
            {t("settings.interchangePickZip")}
          </Btn>
        </div>
      </Row>
      <Row label={t("settings.interchangeExport")} hint={t("settings.interchangeExportHint")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn icon={Download} disabled={busy} onClick={() => void download("obsidian")}>
            Obsidian
          </Btn>
          <Btn icon={Download} disabled={busy} onClick={() => void download("notion")}>
            Notion
          </Btn>
          <Btn icon={Download} disabled={busy} onClick={() => void download("anki-basic")}>
            Anki
          </Btn>
          <Btn icon={Download} disabled={busy} onClick={() => void download("anki-cloze")}>
            Anki cloze
          </Btn>
        </div>
      </Row>
      {msg && (
        <div className="muted-sm" style={{ marginTop: -6 }}>
          {msg}
        </div>
      )}
    </>
  );
}
