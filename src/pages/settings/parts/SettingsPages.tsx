import { useState } from "react";
import { PAGES } from "@/app/navigation";
import { useI18n } from "@/app/i18n";
import type { TranslateFn } from "@/app/i18n";
import { setPageEnabled, usePageAccess } from "@/app/pageAccess";
import PageProfilePicker from "@/components/PageProfilePicker";
import { Row } from "@/pages/settings/parts/SettingsControls";

/** Название серверной функции по префиксу роута; пусто — служебная, пользователю не показываем. */
function featLabel(t: TranslateFn, prefix: string): string {
  const key = `settings.pages.feat.${prefix.replaceAll("-", "_")}`;
  const v = t(key);
  return v === key ? "" : v;
}

/**
 * Раздел настроек «Страницы и профили»: профиль одной кнопкой и выключатель у каждой страницы.
 * Под названием — что остановится вместе со страницей и что останется, потому что нужно
 * другим включённым страницам (например, голосовой ввод чата переживёт отключение лектория).
 */
export function PagesSection() {
  const { t } = useI18n();
  const { state } = usePageAccess();
  const [error, setError] = useState("");

  const toggle = async (id: string, on: boolean): Promise<void> => {
    setError("");
    try {
      await setPageEnabled(id, on);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        {t("settings.pages.hint")}
      </div>
      <Row label={t("settings.pages.profile")}>
        <PageProfilePicker />
      </Row>
      {error && <div className="proxy-error">{error}</div>}
      {state?.pages.map((p) => {
        const meta = PAGES.find((x) => x.id === p.id);
        if (!meta) return null; // страница скрыта на этой платформе
        const stops = p.stops.map((x) => featLabel(t, x)).filter(Boolean);
        const keeps = p.keeps
          .map((k) => ({
            label: featLabel(t, k.prefix),
            by: k.by.map((b) => (b === "shell" ? t("settings.pages.shell") : t(`nav.${b}`))),
          }))
          .filter((k) => k.label);
        const hint = p.locked
          ? t("settings.pages.locked")
          : [
              stops.length ? t("settings.pages.stops", { list: stops.join(", ") }) : "",
              keeps.length
                ? t("settings.pages.keeps", {
                    list: keeps.map((k) => `${k.label} (${k.by.join(", ")})`).join("; "),
                  })
                : "",
            ]
              .filter(Boolean)
              .join(" · ");
        const Icon = meta.icon;
        return (
          <Row
            key={p.id}
            label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Icon size={15} /> {t(meta.i18n)}
              </span>
            }
            hint={hint}
          >
            <button
              type="button"
              role="switch"
              aria-checked={p.enabled}
              aria-label={t(meta.i18n)}
              disabled={p.locked}
              className={`switch${p.enabled ? " is-on" : ""}`}
              onClick={() => void toggle(p.id, !p.enabled)}
            >
              <span className="switch-knob" />
            </button>
          </Row>
        );
      })}
    </>
  );
}
