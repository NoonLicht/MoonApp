import { useState } from "react";
import { Download, Play, Square, Trash2, X } from "lucide-react";
import { Glass, Btn, ProgressBar, Select, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { ComfyFlavor, ComfyStatus } from "@/api/apiComfy";

const size = (mb: number): string =>
  mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;

/** Установка, запуск и остановка ComfyUI: всё, что нужно до того, как откроется рабочая область. */
export default function ComfySetup({
  st,
  act,
}: {
  st: ComfyStatus;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [flavor, setFlavor] = useState<ComfyFlavor>("nvidia");
  const [cpu, setCpu] = useState(false);
  const working = st.setup.state === "working";

  if (!st.supported)
    return (
      <Glass className="ph-card">
        <div className="muted-sm">{t("photo.comfy.unsupported")}</div>
      </Glass>
    );

  const progress = working && (
    <>
      <ProgressBar value={st.setup.progress} />
      <div className="muted-sm">
        {t(`photo.comfy.phase.${st.setup.phase || "download"}`)} · {st.setup.progress}%
        {st.setup.total > 0 &&
          ` · ${size(st.setup.received / 1048576)} / ${size(st.setup.total / 1048576)}`}
      </div>
    </>
  );
  const err = st.setup.state === "error" && (
    <div className="ph-error">
      {st.setup.error.includes("path_too_long") ? t("photo.comfy.pathTooLong") : st.setup.error}
    </div>
  );

  if (!st.installed)
    return (
      <Glass className="ph-card">
        <b>{t("photo.comfy.installTitle")}</b>
        <div className="muted-sm">{t("photo.comfy.installHint")}</div>
        <div className="ph-row">
          <label className="field">
            <span className="field-label">{t("photo.comfy.flavor")}</span>
            <Select
              value={flavor}
              onChange={(e) => setFlavor(e.target.value as ComfyFlavor)}
              options={st.flavors.map((f) => ({
                value: f.id,
                label: `${t(`photo.comfy.flavors.${f.id}`)} · ${size(f.sizeMb)}`,
              }))}
            />
          </label>
          <Btn
            variant="primary"
            icon={Download}
            disabled={working}
            onClick={() => void act(() => api.comfyInstall(flavor))}
          >
            {t("photo.comfy.install")}
          </Btn>
          {working && (
            <Btn icon={X} onClick={() => void act(() => api.comfyInstallCancel())}>
              {t("photo.cancel")}
            </Btn>
          )}
        </div>
        {progress}
        {err}
      </Glass>
    );

  return (
    <Glass className="ph-card">
      <div className="ph-row">
        <b>ComfyUI</b>
        {st.running && st.ready ? (
          <Badge tone="teal">{t("photo.comfy.running")}</Badge>
        ) : st.running ? (
          <Badge>{t("photo.comfy.starting")}</Badge>
        ) : (
          <Badge>{t("photo.comfy.stopped")}</Badge>
        )}
        {st.flavor && <span className="muted-sm">{t(`photo.comfy.flavors.${st.flavor}`)}</span>}
        <span style={{ flex: 1 }} />
        {st.running ? (
          <Btn icon={Square} onClick={() => void act(() => api.comfyStop())}>
            {t("photo.comfy.stop")}
          </Btn>
        ) : (
          <>
            <label className="ph-checks">
              <label>
                <input type="checkbox" checked={cpu} onChange={(e) => setCpu(e.target.checked)} />
                {t("photo.comfy.cpuMode")}
              </label>
            </label>
            <Btn
              variant="primary"
              icon={Play}
              disabled={working}
              onClick={() => void act(() => api.comfyStart(cpu))}
            >
              {t("photo.comfy.start")}
            </Btn>
          </>
        )}
      </div>
      {!st.running && (
        <div className="ph-row">
          <Badge tone={st.gguf ? "teal" : undefined}>
            {st.gguf ? t("photo.comfy.ggufOn") : t("photo.comfy.ggufOff")}
          </Badge>
          {!st.gguf && (
            <Btn
              icon={Download}
              disabled={working}
              onClick={() => void act(() => api.comfyGgufNode())}
            >
              {t("photo.comfy.ggufInstall")}
            </Btn>
          )}
          <span style={{ flex: 1 }} />
          <Btn
            icon={Trash2}
            disabled={working}
            onClick={() => {
              if (window.confirm(t("photo.comfy.removeConfirm"))) void act(() => api.comfyRemove());
            }}
          >
            {t("photo.comfy.remove")}
          </Btn>
        </div>
      )}
      {progress}
      {err}
      {st.running && !st.ready && <div className="muted-sm">{t("photo.comfy.startingHint")}</div>}
      {st.error && !st.running && <div className="ph-error">{st.error}</div>}
      {!st.ready && st.log.length > 0 && st.running && (
        <pre className="ph-log">{st.log.slice(-8).join("\n")}</pre>
      )}
      {!st.running && st.error && st.log.length > 0 && (
        <pre className="ph-log">{st.log.slice(-12).join("\n")}</pre>
      )}
    </Glass>
  );
}
