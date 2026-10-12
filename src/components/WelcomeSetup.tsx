import { useEffect, useState } from "react";
import { useI18n, LANGS } from "@/app/i18n";
import { api } from "@/api/client";

const THEMES = [
  { id: "dark", bg: "#0c0e16", fg: "#f1f0f6" },
  { id: "midnight", bg: "#070b1a", fg: "#eaf1ff" },
  { id: "light", bg: "#eef0f6", fg: "#1c1d2b" },
  { id: "sand", bg: "#f4efe6", fg: "#2c2417" },
  { id: "oled", bg: "#000000", fg: "#f4f5f9" },
] as const;
const ACCENTS = [
  { id: "amber", color: "#f0a63d" },
  { id: "violet", color: "#8b7bf0" },
  { id: "teal", color: "#3fc7ab" },
  { id: "coral", color: "#ea6b6b" },
  { id: "sky", color: "#4aa8ff" },
  { id: "rose", color: "#f2789c" },
] as const;

/**
 * Быстрая настройка на приветственном экране: язык, дизайн, тема, акцент и
 * переключатели (стекло, контраст, анимации). Изменения применяются сразу (те
 * же события, что у страницы настроек) и сохраняются в settings.json.
 */
export default function WelcomeSetup() {
  const { t, lang } = useI18n();
  const [theme, setTheme] = useState<string>("dark");
  const [accent, setAccent] = useState<string>("amber");
  const [design, setDesign] = useState<string>("fluent");
  const [glass, setGlass] = useState(true);
  const [contrast, setContrast] = useState(false);
  const [motion, setMotion] = useState(false);

  // Показываем реальные текущие значения, а не «по умолчанию».
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const ap = ((s as { appearance?: Record<string, unknown> })?.appearance ?? {}) as Record<
          string,
          unknown
        >;
        if (typeof ap.theme === "string") setTheme(ap.theme);
        if (typeof ap.accent === "string") setAccent(ap.accent);
        setDesign(ap.design === "classic" ? "classic" : "fluent");
        setGlass(ap.glass !== false);
        setContrast(!!ap.highContrast);
        setMotion(!!ap.reduceMotion);
      })
      .catch(() => undefined);
  }, []);

  const emit = (path: string, value: unknown) =>
    window.dispatchEvent(new CustomEvent("app:setting", { detail: { path, value } }));
  const save = (patch: Record<string, Record<string, unknown>>) => {
    api.updateSettings(patch).catch(() => undefined);
  };
  const setAppearance = (key: string, value: unknown) => {
    emit(`appearance.${key}`, value);
    save({ appearance: { [key]: value } });
  };

  const Switch = ({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) => (
    <div className="ws-switch-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`switch ${on ? "is-on" : ""}`}
        onClick={onToggle}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );

  return (
    <div className="welcome-setup">
      <div className="ws-group">
        <div className="ws-label">{t("welcome.setup.language")}</div>
        <div className="ws-chips">
          {LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`ws-chip ${lang === l.code ? "is-on" : ""}`}
              onClick={() => {
                emit("general.language", l.code);
                save({ general: { language: l.code } });
              }}
            >
              {l.native}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-group">
        <div className="ws-label">{t("welcome.setup.theme")}</div>
        <div className="ws-themes">
          {THEMES.map((th) => (
            <button
              key={th.id}
              type="button"
              className={`ws-theme ${theme === th.id ? "is-on" : ""}`}
              onClick={() => {
                setTheme(th.id);
                window.dispatchEvent(new CustomEvent("app:theme", { detail: th.id }));
                save({ appearance: { theme: th.id } });
              }}
            >
              <span className="ws-theme-prev" style={{ background: th.bg, color: th.fg }}>
                Aa
              </span>
              <span>{t(`welcome.setup.theme_${th.id}`)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="ws-group">
        <div className="ws-label">{t("welcome.setup.accent")}</div>
        <div className="ws-accents">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              title={t(`welcome.setup.accent_${a.id}`)}
              aria-label={t(`welcome.setup.accent_${a.id}`)}
              className={`ws-accent ${accent === a.id ? "is-on" : ""}`}
              style={{ background: a.color }}
              onClick={() => {
                setAccent(a.id);
                setAppearance("accent", a.id);
              }}
            />
          ))}
        </div>
      </div>

      <div className="ws-group">
        <div className="ws-label">{t("welcome.setup.design")}</div>
        <div className="ws-chips">
          {(["fluent", "classic"] as const).map((d) => (
            <button
              key={d}
              type="button"
              className={`ws-chip ${design === d ? "is-on" : ""}`}
              onClick={() => {
                setDesign(d);
                setAppearance("design", d);
              }}
            >
              {t(d === "fluent" ? "settings.designFluent" : "settings.designClassic")}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-group ws-switches">
        <Switch
          on={glass}
          label={t("welcome.setup.glass")}
          onToggle={() => {
            setGlass(!glass);
            setAppearance("glass", !glass);
          }}
        />
        <Switch
          on={contrast}
          label={t("welcome.setup.contrast")}
          onToggle={() => {
            setContrast(!contrast);
            setAppearance("highContrast", !contrast);
          }}
        />
        <Switch
          on={motion}
          label={t("welcome.setup.reduceMotion")}
          onToggle={() => {
            setMotion(!motion);
            setAppearance("reduceMotion", !motion);
          }}
        />
      </div>
    </div>
  );
}
