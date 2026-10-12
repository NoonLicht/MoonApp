import { useState } from "react";
import { useI18n, LANGS } from "@/app/i18n";
import { api } from "@/api/client";

const THEMES = ["dark", "midnight", "light", "sand", "oled"] as const;
const ACCENTS = ["amber", "violet", "teal", "coral", "sky", "rose"] as const;

/**
 * Быстрая настройка на приветственном экране: язык, тема, акцент и два
 * переключателя доступности. Изменения применяются сразу (те же события, что
 * у страницы настроек) и сохраняются в settings.json.
 */
export default function WelcomeSetup() {
  const { t, lang } = useI18n();
  const [theme, setTheme] = useState<string>("dark");
  const [accent, setAccent] = useState<string>("amber");
  const [contrast, setContrast] = useState(false);
  const [motion, setMotion] = useState(false);

  const emit = (path: string, value: unknown) =>
    window.dispatchEvent(new CustomEvent("app:setting", { detail: { path, value } }));

  const save = (patch: Record<string, Record<string, unknown>>) => {
    api.updateSettings(patch).catch(() => undefined);
  };

  return (
    <div className="welcome-setup" style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "14px 0" }}>
      <label>
        <div className="muted-sm">{t("welcome.setup.language")}</div>
        <select
          className="input"
          value={lang}
          onChange={(e) => {
            emit("general.language", e.target.value);
            save({ general: { language: e.target.value } });
          }}
        >
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </label>
      <label>
        <div className="muted-sm">{t("welcome.setup.theme")}</div>
        <select
          className="input"
          value={theme}
          onChange={(e) => {
            setTheme(e.target.value);
            window.dispatchEvent(new CustomEvent("app:theme", { detail: e.target.value }));
            save({ appearance: { theme: e.target.value } });
          }}
        >
          {THEMES.map((v) => (
            <option key={v} value={v}>
              {t(`welcome.setup.theme_${v}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <div className="muted-sm">{t("welcome.setup.accent")}</div>
        <select
          className="input"
          value={accent}
          onChange={(e) => {
            setAccent(e.target.value);
            emit("appearance.accent", e.target.value);
            save({ appearance: { accent: e.target.value } });
          }}
        >
          {ACCENTS.map((v) => (
            <option key={v} value={v}>
              {t(`welcome.setup.accent_${v}`)}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <input
          type="checkbox"
          checked={contrast}
          onChange={(e) => {
            setContrast(e.target.checked);
            emit("appearance.highContrast", e.target.checked);
            save({ appearance: { highContrast: e.target.checked } });
          }}
        />
        {t("welcome.setup.contrast")}
      </label>
      <label style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <input
          type="checkbox"
          checked={motion}
          onChange={(e) => {
            setMotion(e.target.checked);
            emit("appearance.reduceMotion", e.target.checked);
            save({ appearance: { reduceMotion: e.target.checked } });
          }}
        />
        {t("welcome.setup.reduceMotion")}
      </label>
    </div>
  );
}
