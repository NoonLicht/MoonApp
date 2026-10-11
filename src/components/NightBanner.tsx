import { useEffect, useState } from "react";
import { Moon } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { appliesTo, dismiss, isDeepNight, isDismissed } from "@/lib/nightMode";

/**
 * Мягкая подсказка глубокой ночью: решения по бюджету и отправку сообщений
 * лучше отложить до утра. Ничего не блокирует; можно скрыть на ночь или навсегда.
 */
export default function NightBanner({ page }: { page: string }) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);

  useEffect(() => {
    const check = () => setShow(isDeepNight() && !isDismissed());
    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!show || !appliesTo(page)) return null;
  const hide = (forever: boolean) => {
    dismiss(forever);
    setShow(false);
  };
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 14px",
        fontSize: 12,
        background: "color-mix(in srgb, #4a6fa5 18%, transparent)",
        borderBottom: "1px solid var(--glass-border, rgba(255,255,255,.1))",
      }}
    >
      <Moon size={14} />
      <span style={{ flex: 1 }}>{t("night.message")}</span>
      <button className="btn" onClick={() => hide(false)}>
        {t("night.ok")}
      </button>
      <button className="btn" onClick={() => hide(true)}>
        {t("night.never")}
      </button>
    </div>
  );
}
