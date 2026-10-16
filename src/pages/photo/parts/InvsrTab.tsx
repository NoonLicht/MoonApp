import { useState } from "react";
import { Download, Sparkles, X } from "lucide-react";
import { Glass, Btn, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
import { usePageBusy } from "@/components/Toolbar";
import CompareSlider from "@/components/upscale/CompareSlider";
import FilePick, { useObjectUrl } from "@/pages/photo/parts/FilePick";
import ToolInstall, { usePhotoTools } from "@/pages/photo/parts/ToolInstall";
import { useJob } from "@/pages/photo/parts/useJob";

/** Диффузионный апскейл ×4 (InvSR на SD-Turbo): 1–5 шагов, тайлы для больших снимков. */
export default function InvsrTab({ active }: { active: boolean }) {
  const { t } = useI18n();
  const { state, reload, tool } = usePhotoTools();
  const [file, setFile] = useState<File | null>(null);
  const [steps, setSteps] = useState(1);
  const [tile, setTile] = useState(256);
  const [colorFix, setColorFix] = useState("");
  const j = useJob();
  const srcUrl = useObjectUrl(file);
  const resUrl = useObjectUrl(j.result);
  usePageBusy(j.busy);

  const ready = !!tool("invsr")?.ready;

  return (
    <div className="ph-tab">
      <ToolInstall id="invsr" state={state} reload={reload} />

      <Glass className="ph-card">
        <FilePick file={file} accept="image/*" onPick={(f) => (setFile(f), j.reset())} />
        <div className="ph-grid">
          <label className="field">
            <span className="field-label">{t("photo.invsr.steps")}</span>
            <Select
              value={String(steps)}
              onChange={(e) => setSteps(Number(e.target.value))}
              options={["1", "2", "3", "4", "5"]}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("photo.invsr.tile")}</span>
            <Select
              value={String(tile)}
              onChange={(e) => setTile(Number(e.target.value))}
              options={["128", "192", "256", "384", "512"]}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("photo.invsr.colorFix")}</span>
            <Select
              value={colorFix}
              onChange={(e) => setColorFix(e.target.value)}
              options={[
                { value: "", label: t("photo.none") },
                { value: "wavelet", label: "wavelet" },
                { value: "ycbcr", label: "ycbcr" },
              ]}
            />
          </label>
        </div>
        <div className="muted-sm">{t("photo.invsr.hint")}</div>
        <div className="ph-row">
          <Btn
            variant="primary"
            icon={Sparkles}
            disabled={!file || !ready || j.busy}
            onClick={() =>
              file && void j.start(() => api.photoInvsr(file, { steps, tile, colorFix }))
            }
          >
            {j.busy ? t("photo.working") : t("photo.invsr.run")}
          </Btn>
          {j.busy && (
            <Btn icon={X} onClick={() => void j.cancel()}>
              {t("photo.cancel")}
            </Btn>
          )}
          {j.result && (
            <Btn
              icon={Download}
              onClick={() =>
                j.result &&
                saveBlob(j.result, `${file?.name.replace(/\.[^.]+$/, "") || "image"}-invsr.png`)
              }
            >
              {t("photo.save")}
            </Btn>
          )}
        </div>
        {j.busy && j.job && (
          <>
            <ProgressBar value={j.job.progress} />
            <div className="muted-sm">
              {t(`photo.stage.${j.job.stage}`)} · {j.job.progress}%
            </div>
          </>
        )}
        {j.error && <div className="ph-error">{j.error}</div>}
        {j.error && j.job && j.job.log.length > 0 && (
          <pre className="ph-log">{j.job.log.slice(-10).join("\n")}</pre>
        )}
      </Glass>

      {srcUrl && resUrl && (
        <Glass className="ph-card">
          <CompareSlider
            kind="photo"
            originalSrc={srcUrl}
            resultSrc={resUrl}
            originalLabel={t("photo.before")}
            resultLabel={t("photo.after")}
            active={active}
          />
        </Glass>
      )}
    </div>
  );
}
