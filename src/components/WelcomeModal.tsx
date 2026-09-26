import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Film,
  Popcorn,
  Wand2,
  Mic,
  Globe,
  FolderKanban,
  Gamepad2,
  KeyRound,
  X,
} from "lucide-react";
import { Glass, Checkbox } from "@/components/ui";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

const HIGHLIGHTS = [
  { icon: Film, key: "convert" },
  { icon: Popcorn, key: "movies" },
  { icon: Wand2, key: "upscale" },
  { icon: Mic, key: "lecture" },
  { icon: Globe, key: "bypass" },
  { icon: FolderKanban, key: "myspace" },
  { icon: Gamepad2, key: "games" },
  { icon: KeyRound, key: "vault" },
] as const;

/**
 * Приветственное окно при запуске — один раз показывает, что вообще умеет
 * приложение (страниц много, с наскока не видно). Отключается насовсем
 * галочкой здесь же или тумблером в Настройках → Общее (general.showWelcome),
 * оба пишут в один и тот же ключ, так что они всегда синхронны.
 */
export default function WelcomeModal() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dontShow, setDontShow] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s: any) => {
        if (s?.general?.showWelcome !== false) setOpen(true);
      })
      .catch(() => {});
  }, []);

  const close = () => {
    setOpen(false);
    if (dontShow) api.updateSettings({ general: { showWelcome: false } }).catch(() => {});
  };

  if (!open) return null;
  const root = getOverlayRoot();
  if (!root) return null;

  return createPortal(
    <div className="app-modal-backdrop welcome-backdrop" onClick={close}>
      <Glass className="welcome-card glass-solid" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="welcome-close" onClick={close} aria-label={t("welcome.close")}>
          <X size={16} />
        </button>

        <div className="welcome-head">
          <div className="welcome-logo">M</div>
          <h1>{t("welcome.title")}</h1>
          <p>{t("welcome.subtitle")}</p>
        </div>

        <div className="welcome-grid">
          {HIGHLIGHTS.map(({ icon: Icon, key }) => (
            <div className="welcome-item" key={key}>
              <span className="welcome-item-icon">
                <Icon size={18} strokeWidth={1.8} />
              </span>
              <div>
                <div className="welcome-item-title">{t(`welcome.f_${key}`)}</div>
                <div className="welcome-item-text">{t(`welcome.f_${key}_hint`)}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="welcome-foot">
          <label className="welcome-check">
            <Checkbox checked={dontShow} onClick={() => setDontShow((v) => !v)} />
            {t("welcome.dontShow")}
          </label>
          <button type="button" className="btn btn-primary welcome-start" onClick={close}>
            {t("welcome.start")}
          </button>
        </div>
      </Glass>
    </div>,
    root,
  );
}
