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
  Wallet,
  Zap,
  Camera,
  Archive,
  Wrench,
  BookOpen,
  Music,
  MessageSquare,
} from "lucide-react";
import { Checkbox } from "@/components/ui";
import { getOverlayRoot, getUnderToolbarRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import logoUrl from "@/assets/app-logo.ico?url";

/** Позиции искр фиксированы (не Math.random на каждый рендер — иначе они бы
 *  «прыгали» при любом ре-рендере компонента, например при клике на чекбокс). */
const SPARKS = [
  { top: "8%", left: "12%", delay: "0s", size: 3 },
  { top: "18%", left: "78%", delay: "0.6s", size: 4 },
  { top: "62%", left: "6%", delay: "1.1s", size: 3 },
  { top: "82%", left: "88%", delay: "0.3s", size: 4 },
  { top: "30%", left: "48%", delay: "1.6s", size: 2 },
  { top: "70%", left: "60%", delay: "2.1s", size: 3 },
  { top: "12%", left: "34%", delay: "0.9s", size: 2 },
  { top: "50%", left: "90%", delay: "1.4s", size: 3 },
  { top: "88%", left: "22%", delay: "0.2s", size: 3 },
  { top: "40%", left: "8%", delay: "1.9s", size: 2 },
  { top: "5%", left: "60%", delay: "2.4s", size: 3 },
  { top: "58%", left: "35%", delay: "0.5s", size: 2 },
  { top: "76%", left: "45%", delay: "1.2s", size: 4 },
  { top: "24%", left: "94%", delay: "1.8s", size: 2 },
];

const HIGHLIGHTS = [
  { icon: Film, key: "convert" },
  { icon: Popcorn, key: "movies" },
  { icon: Wand2, key: "upscale" },
  { icon: Mic, key: "lecture" },
  { icon: Globe, key: "bypass" },
  { icon: FolderKanban, key: "myspace" },
  { icon: Gamepad2, key: "games" },
  { icon: KeyRound, key: "vault" },
  { icon: Wallet, key: "budget" },
  { icon: Zap, key: "automation" },
  { icon: Camera, key: "screenshots" },
  { icon: Archive, key: "archive" },
  { icon: Wrench, key: "tools" },
  { icon: BookOpen, key: "books" },
  { icon: Music, key: "music" },
  { icon: MessageSquare, key: "aichat" },
] as const;

/**
 * Приветственное окно при запуске — один раз показывает, что вообще умеет
 * приложение (страниц много, с наскока не видно). Отключается насовсем
 * галочкой здесь же или тумблером в Настройках → Общее (general.showWelcome),
 * оба пишут в один и тот же ключ, так что они всегда синхронны.
 */
export default function WelcomeModal({
  onOpenChange,
}: {
  /** App.tsx подменяет заголовок тулбара на "Привет!" и прячет рельс
   *  страниц (.welcome-open), пока приветствие открыто. */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dontShow, setDontShow] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s: any) => {
        if (s?.general?.showWelcome !== false) {
          setOpen(true);
          onOpenChange?.(true);
        } else {
          // Показывать не нужно — сразу сообщаем родителю, чтобы он
          // размонтировал этот компонент (App.tsx → welcomeMounted).
          onOpenChange?.(false);
        }
      })
      .catch(() => onOpenChange?.(false));
    // onOpenChange стабилен (setState из App.tsx) — эффект должен сработать
    // только один раз при монтировании.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    setOpen(false);
    onOpenChange?.(false);
    if (dontShow) api.updateSettings({ general: { showWelcome: false } }).catch(() => {});
  };

  if (!open) return null;
  const root = getOverlayRoot();
  const bgRoot = getUnderToolbarRoot();
  if (!root) return null;

  return (
    <>
      {/* Декоративный фон — отдельный портал ПОД тулбаром (z-index:35, между
          .content-area и .top-toolbar:40), а не в #overlay-root (z-index:1000,
          выше тулбара — тот бы просто скрылся под фоном). Тулбар остаётся на
          виду и кликабельным, а его полупрозрачный фон пропускает сквозь себя
          пятна снизу — так же, как обычный фоновый mesh приложения. Один
          слой на весь экран (а не два, как раньше) — иначе на стыке с
          .welcome-page был виден шов, где два независимых градиента и два
          набора пятен стыковались не в тех же координатах. Рельс страниц
          слева прячется отдельно, классом .welcome-open на app-shell (см.
          App.tsx), поэтому дублировать фон ради его перекрытия не нужно. */}
      {bgRoot &&
        createPortal(
          <div className="welcome-fx" aria-hidden="true">
            <span className="welcome-blob welcome-blob-1" />
            <span className="welcome-blob welcome-blob-2" />
            <span className="welcome-blob welcome-blob-3" />
            {SPARKS.map((s, i) => (
              <span
                key={i}
                className="welcome-spark"
                style={{
                  top: s.top,
                  left: s.left,
                  width: s.size,
                  height: s.size,
                  animationDelay: s.delay,
                }}
              />
            ))}
          </div>,
          bgRoot,
        )}

      {createPortal(
        <div className="welcome-page">
          <div className="welcome-content">
            <div className="welcome-head">
              <img src={logoUrl} alt="MoonApp" className="welcome-logo" />
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
          </div>
        </div>,
        root,
      )}
    </>
  );
}
