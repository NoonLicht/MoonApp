import { useState } from "react";
import { Camera, Download, Repeat, X } from "lucide-react";
import { Glass, Btn, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
import { usePageBusy } from "@/components/Toolbar";
import FilePick, { useObjectUrl } from "@/pages/photo/parts/FilePick";
import ToolInstall, { usePhotoTools } from "@/pages/photo/parts/ToolInstall";
import { useJob } from "@/pages/photo/parts/useJob";

const isVideo = (f: File | null): boolean => !!f && /^video\//.test(f.type || "");

/** Замена лица (Deep-Live-Cam): фото или видео по одному снимку лица, живая камера — отдельным окном. */
export default function FaceSwapTab() {
  const { t } = useI18n();
  const { state, reload, tool } = usePhotoTools();
  const [source, setSource] = useState<File | null>(null);
  const [target, setTarget] = useState<File | null>(null);
  const [device, setDevice] = useState<"cuda" | "cpu">("cuda");
  const [enhance, setEnhance] = useState(false);
  const [manyFaces, setManyFaces] = useState(false);
  const [mouthMask, setMouthMask] = useState(false);
  const [quality, setQuality] = useState(18);
  const [liveErr, setLiveErr] = useState("");
  const j = useJob();
  const srcUrl = useObjectUrl(source);
  const tgtUrl = useObjectUrl(target);
  const resUrl = useObjectUrl(j.result);
  usePageBusy(j.busy);

  const ready = !!tool("faceswap")?.ready;
  const live = !!state?.liveRunning;
  const video = isVideo(target);

  const toggleLive = async (): Promise<void> => {
    setLiveErr("");
    try {
      await api.photoFaceLive(!live, device);
    } catch (e) {
      setLiveErr(String((e as Error).message));
    }
    void reload();
  };

  return (
    <div className="ph-tab">
      <ToolInstall id="faceswap" state={state} reload={reload} />

      <Glass className="ph-card">
        <div className="muted-sm">{t("photo.face.consent")}</div>
        <div className="ph-pair">
          <div>
            <div className="muted-sm">{t("photo.face.source")}</div>
            <FilePick file={source} accept="image/*" onPick={(f) => (setSource(f), j.reset())} />
            {srcUrl && <img className="ph-thumb" src={srcUrl} alt={t("photo.face.source")} />}
          </div>
          <div>
            <div className="muted-sm">{t("photo.face.target")}</div>
            <FilePick
              file={target}
              accept="image/*,video/mp4,video/x-matroska,video/quicktime,video/webm"
              onPick={(f) => (setTarget(f), j.reset())}
            />
            {tgtUrl &&
              (video ? (
                <video className="ph-thumb" src={tgtUrl} controls muted />
              ) : (
                <img className="ph-thumb" src={tgtUrl} alt={t("photo.face.target")} />
              ))}
          </div>
        </div>

        <div className="ph-grid">
          <label className="field">
            <span className="field-label">{t("photo.face.device")}</span>
            <Select
              value={device}
              onChange={(e) => setDevice(e.target.value as "cuda" | "cpu")}
              options={[
                { value: "cuda", label: t("photo.deviceGpu") },
                { value: "cpu", label: t("photo.deviceCpu") },
              ]}
            />
          </label>
          {video && (
            <label className="field">
              <span className="field-label">{t("photo.face.quality")}</span>
              <input
                type="number"
                min={0}
                max={51}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
              />
            </label>
          )}
        </div>
        <div className="ph-checks">
          <label>
            <input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} />
            {t("photo.face.enhance")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={manyFaces}
              onChange={(e) => setManyFaces(e.target.checked)}
            />
            {t("photo.face.many")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={mouthMask}
              onChange={(e) => setMouthMask(e.target.checked)}
            />
            {t("photo.face.mouth")}
          </label>
        </div>

        <div className="ph-row">
          <Btn
            variant="primary"
            icon={Repeat}
            disabled={!source || !target || !ready || j.busy}
            onClick={() =>
              source &&
              target &&
              void j.start(() =>
                api.photoFaceSwap(source, target, { device, enhance, manyFaces, mouthMask, quality }),
              )
            }
          >
            {j.busy ? t("photo.working") : t("photo.face.run")}
          </Btn>
          {j.busy && (
            <Btn icon={X} onClick={() => void j.cancel()}>
              {t("photo.cancel")}
            </Btn>
          )}
          {j.result && (
            <Btn
              icon={Download}
              onClick={() => j.result && saveBlob(j.result, video ? "swap.mp4" : "swap.png")}
            >
              {t("photo.save")}
            </Btn>
          )}
          <Btn icon={Camera} disabled={!ready} onClick={() => void toggleLive()}>
            {live ? t("photo.face.liveStop") : t("photo.face.live")}
          </Btn>
        </div>
        {j.busy && j.job && (
          <>
            <ProgressBar value={j.job.progress} />
            <div className="muted-sm">
              {t(`photo.stage.${j.job.stage}`)} · {j.job.progress}%
            </div>
          </>
        )}
        {(j.error || liveErr) && <div className="ph-error">{j.error || liveErr}</div>}
        {j.error && j.job && j.job.log.length > 0 && (
          <pre className="ph-log">{j.job.log.slice(-10).join("\n")}</pre>
        )}
      </Glass>

      {resUrl && (
        <Glass className="ph-view">
          <div className="muted-sm">{t("photo.after")}</div>
          {video ? (
            <video src={resUrl} controls />
          ) : (
            <img src={resUrl} alt={t("photo.after")} />
          )}
        </Glass>
      )}
    </div>
  );
}
