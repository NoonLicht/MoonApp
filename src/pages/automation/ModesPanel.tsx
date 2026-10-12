import { useCallback, useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import { Glass, Btn, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { applyLiveSettings } from "@/pages/settings/parts/SettingsControls";

/**
 * Режимы «Учёба» и «Игра»: набор настроек включается одним нажатием, при выходе
 * возвращаются прежние значения.
 */
export default function ModesPanel() {
  const { t } = useI18n();
  const [modes, setModes] = useState<{ id: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.appModes();
      setModes(r.modes);
      setActive(r.active);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<{ active: string | null; settings: unknown }>) => {
    setErr("");
    try {
      const r = await fn();
      setActive(r.active);
      applyLiveSettings(r.settings);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div style={{ marginTop: 24 }}>
      <SectionHead eyebrow={t("automation.modes.eyebrow")} title={t("automation.modes.title")} />
      <Glass className="p-4">
        {modes.map((m) => (
          <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <div style={{ flex: 1 }}>
              <strong>{t(`automation.modes.${m.id}`)}</strong>
              <div className="muted-sm">{t(`automation.modes.${m.id}Hint`)}</div>
            </div>
            {active === m.id ? (
              <Btn icon={Square} onClick={() => void run(() => api.appModeDeactivate())}>
                {t("automation.modes.off")}
              </Btn>
            ) : (
              <Btn icon={Play} onClick={() => void run(() => api.appModeActivate(m.id))}>
                {t("automation.modes.on")}
              </Btn>
            )}
          </div>
        ))}
        {err && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{err}</div>}
      </Glass>
    </div>
  );
}
