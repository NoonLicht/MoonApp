import { useCallback, useEffect, useState } from "react";
import { Download, Eraser, X } from "lucide-react";
import { Glass, Btn, Badge, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { PhotoModelsState } from "@/api/apiPhoto";
import { saveBlob } from "@/lib/download";
import { usePageBusy } from "@/components/Toolbar";
import FilePick, { useObjectUrl } from "@/pages/photo/parts/FilePick";

type Mode = "cutout" | "mask" | "color";

/** Удаление фона (BiRefNet, ONNX): вырезка на прозрачном, маска или заливка цветом. */
export default function BgRemoveTab() {
  const { t } = useI18n();
  const [models, setModels] = useState<PhotoModelsState | null>(null);
  const [model, setModel] = useState("birefnet-lite");
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>("cutout");
  const [color, setColor] = useState("#ffffff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ blob: Blob; sec: number; provider: string } | null>(null);

  const srcUrl = useObjectUrl(file);
  const resUrl = useObjectUrl(result?.blob ?? null);
  usePageBusy(busy);

  const reload = useCallback(async () => {
    try {
      setModels(await api.photoModels());
    } catch {
      /* повторится при следующем опросе */
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const downloading = models?.task.state === "working";
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void reload(), 1000);
    return () => clearInterval(timer);
  }, [downloading, reload]);

  const info = models?.models.find((m) => m.id === model);
  const installed = !!info?.installed;

  const run = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const r = await api.photoBgRemove(file, { model, mode, color });
      const blob = await api.photoFile(r.name);
      setResult({ blob, sec: r.sec, provider: r.provider });
    } catch (e) {
      const m = String((e as Error).message);
      setError(m === "model_not_installed" ? t("photo.bg.needModel") : m);
      void reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ph-tab">
      <Glass className="ph-card">
        <div className="ph-row">
          <b>{t("photo.bg.model")}</b>
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            options={(models?.models || []).map((m) => ({
              value: m.id,
              label: `${m.title} · ${m.sizeMb} MB${m.installed ? " ✓" : ""}`,
            }))}
          />
          {info && <span className="muted-sm">{info.license}</span>}
          {installed ? (
            <Badge tone="teal">{t("photo.ready")}</Badge>
          ) : downloading ? (
            <Btn icon={X} onClick={() => void api.photoModelCancel().then(reload)}>
              {t("photo.cancel")}
            </Btn>
          ) : (
            <Btn
              variant="primary"
              icon={Download}
              onClick={() => void api.photoModelDownload(model).then(reload)}
            >
              {t("photo.download")}
            </Btn>
          )}
        </div>
        {downloading && <ProgressBar value={models?.task.progress || 0} />}
        {models?.task.state === "error" && <div className="ph-error">{models.task.error}</div>}
      </Glass>

      <Glass className="ph-card">
        <FilePick file={file} accept="image/*" onPick={(f) => (setFile(f), setResult(null))} />
        <div className="ph-row">
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            options={[
              { value: "cutout", label: t("photo.bg.cutout") },
              { value: "mask", label: t("photo.bg.mask") },
              { value: "color", label: t("photo.bg.color") },
            ]}
          />
          {mode === "color" && (
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label={t("photo.bg.color")}
            />
          )}
          <Btn
            variant="primary"
            icon={Eraser}
            disabled={!file || busy || !installed}
            onClick={() => void run()}
          >
            {busy ? t("photo.working") : t("photo.bg.run")}
          </Btn>
          {result && (
            <Btn
              icon={Download}
              onClick={() =>
                saveBlob(result.blob, `${file?.name.replace(/\.[^.]+$/, "") || "image"}-nobg.png`)
              }
            >
              {t("photo.save")}
            </Btn>
          )}
        </div>
        {error && <div className="ph-error">{error}</div>}
        {result && (
          <div className="muted-sm">
            {t("photo.done", { sec: String(result.sec) })} · {result.provider.toUpperCase()}
          </div>
        )}
      </Glass>

      {(srcUrl || resUrl) && (
        <div className="ph-pair">
          {srcUrl && (
            <Glass className="ph-view">
              <div className="muted-sm">{t("photo.before")}</div>
              <img src={srcUrl} alt={t("photo.before")} />
            </Glass>
          )}
          {resUrl && (
            <Glass className="ph-view ph-checker">
              <div className="muted-sm">{t("photo.after")}</div>
              <img src={resUrl} alt={t("photo.after")} />
            </Glass>
          )}
        </div>
      )}
    </div>
  );
}
