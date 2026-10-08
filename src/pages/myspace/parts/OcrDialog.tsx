import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Select } from "@/components/ui";
import LlamaPanel from "@/components/LlamaPanel";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaStatus } from "@/api/client";
import { saveOcrPrefs } from "@/lib/noteOcr";
import type { OcrDevice, OcrPrefs } from "@/lib/noteOcr";

/** Настройки распознавания картинок в заметках: устройство, модель Chandra OCR 2, установка. */
export default function OcrDialog({
  prefs,
  onChange,
  onClose,
}: {
  prefs: OcrPrefs;
  onChange: (p: OcrPrefs) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [st, setSt] = useState<LlamaStatus | null>(null);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSt(await api.llamaStatus());
    } catch {
      /* сервер недоступен */
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = (patch: Partial<OcrPrefs>): void => {
    const next = { ...prefs, ...patch };
    saveOcrPrefs(next);
    onChange(next);
  };

  const has = (id: string): boolean => !!st?.builds.find((b) => b.id === id)?.installed;
  const mark = (id: string): string => (has(id) ? "" : ` · ${t("myspace.ocr.notInstalled")}`);
  const devices: { value: OcrDevice; label: string }[] = [
    { value: "auto", label: t("myspace.ocr.dev.auto") },
    { value: "cpu", label: t("myspace.ocr.dev.cpu") + mark("cpu") },
    { value: "vulkan", label: t("myspace.ocr.dev.vulkan") + mark("vulkan") },
    { value: "cuda", label: t("myspace.ocr.dev.cuda") + mark("cuda") },
  ];
  const models = st?.ocrModels ?? [];

  return createPortal(
    <div className="graph-fs-backdrop" onClick={onClose}>
      <div className="graph-fs-panel glass-solid" onClick={(e) => e.stopPropagation()}>
        <div className="graph-fs-header">
          <b style={{ fontSize: 15, color: "var(--text-primary)" }}>{t("myspace.ocr.title")}</b>
          <button
            type="button"
            className="btn btn-ghost"
            aria-label={t("tuning.close")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="ocr-dlg-body">
          <div className="muted-sm">{t("myspace.ocr.hint")}</div>

          <div className="ocr-dlg-grid">
            <div>
              <div className="ocr-dlg-label">{t("myspace.ocr.device")}</div>
              <Select
                value={prefs.device}
                onChange={(e) => update({ device: e.target.value as OcrDevice })}
                options={devices}
              />
              <div className="muted-sm">{t(`myspace.ocr.devHint.${prefs.device}`)}</div>
            </div>
            <div>
              <div className="ocr-dlg-label">{t("myspace.ocr.model")}</div>
              <Select
                value={models.some((m) => m.file === prefs.model) ? prefs.model : ""}
                onChange={(e) => update({ model: e.target.value })}
                options={[
                  { value: "", label: t("myspace.ocr.modelAuto") },
                  ...models.map((m) => ({
                    value: m.file,
                    label: `${m.file} · ${(m.sizeMb / 1024).toFixed(1)} GB`,
                  })),
                ]}
              />
              <div className="muted-sm">{t("myspace.ocr.modelHint")}</div>
            </div>
          </div>

          {msg && <div className="muted-sm">{msg}</div>}
          <LlamaPanel kind="ocr" notify={(m) => setMsg(m)} onChange={setSt} />
          <div className="muted-sm">{t("myspace.ocr.license")}</div>
        </div>
      </div>
    </div>,
    getOverlayRoot() ?? document.body,
  );
}
