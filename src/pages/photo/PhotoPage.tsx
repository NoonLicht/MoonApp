import { useState } from "react";
import { SectionHead } from "@/components/ui";
import { usePageActive } from "@/components/Toolbar";
import { useI18n } from "@/app/i18n";
import UpscalePage from "@/pages/upscale/UpscalePage";
import BgRemoveTab from "@/pages/photo/parts/BgRemoveTab";
import InvsrTab from "@/pages/photo/parts/InvsrTab";
import FaceSwapTab from "@/pages/photo/parts/FaceSwapTab";

const TABS = ["upscale", "bg", "invsr", "face"] as const;
type Tab = (typeof TABS)[number];

/**
 * «Фото и видео»: одно место для обработки изображений и видео. Вкладки: быстрый апскейл на ONNX
 * (бывшая страница «Апскейл»), удаление фона, диффузионный апскейл InvSR, замена лица.
 * Открытые вкладки остаются смонтированными: идущее задание не теряется при переключении.
 */
export default function PhotoPage() {
  const { t } = useI18n();
  const active = usePageActive();
  const [tab, setTab] = useState<Tab>("upscale");
  const [seen, setSeen] = useState<Set<Tab>>(new Set(["upscale"]));

  const pick = (k: Tab): void => {
    setTab(k);
    setSeen((s) => (s.has(k) ? s : new Set(s).add(k)));
  };
  const show = (k: Tab): React.CSSProperties => (tab === k ? {} : { display: "none" });

  return (
    <div className="page ph-page">
      <SectionHead eyebrow={t("photo.eyebrow")} title={t("photo.title")} />
      <div className="page-tabs">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            className={`page-tab${tab === k ? " active" : ""}`}
            onClick={() => pick(k)}
          >
            {t(`photo.tabs.${k}`)}
          </button>
        ))}
      </div>
      <div className="ph-body">
        {seen.has("upscale") && (
          <div className="ph-pane ph-pane-fill" style={show("upscale")}>
            <UpscalePage embedded />
          </div>
        )}
        {seen.has("bg") && (
          <div className="ph-pane" style={show("bg")}>
            <BgRemoveTab />
          </div>
        )}
        {seen.has("invsr") && (
          <div className="ph-pane" style={show("invsr")}>
            <InvsrTab active={active && tab === "invsr"} />
          </div>
        )}
        {seen.has("face") && (
          <div className="ph-pane" style={show("face")}>
            <FaceSwapTab />
          </div>
        )}
      </div>
    </div>
  );
}
