import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";
import {
  HOTKEYS,
  HOTKEYS_EVENT,
  eventToCombo,
  findConflict,
  getCombo,
  isValidCombo,
  setCombo,
} from "@/lib/hotkeys";

/** Список действий с редактируемыми сочетаниями; запись — нажатием нужных клавиш. */
export function HotkeyRows() {
  const { t } = useI18n();
  const [, bump] = useState(0);
  const [recording, setRecording] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const h = () => bump((n) => n + 1);
    window.addEventListener(HOTKEYS_EVENT, h);
    return () => window.removeEventListener(HOTKEYS_EVENT, h);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // нажат только модификатор — ждём основную клавишу
      if (!isValidCombo(combo)) {
        setMsg(t("settings.hotkeys.needModifier"));
        return;
      }
      const clash = findConflict(recording, combo);
      if (clash) {
        const def = HOTKEYS.find((h) => h.id === clash);
        setMsg(t("settings.hotkeys.conflict", { name: def ? t(def.labelKey) : clash }));
        return;
      }
      setCombo(recording, combo);
      setRecording(null);
      setMsg("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, t]);

  return (
    <>
      {HOTKEYS.map((h) => (
        <Row key={h.id} label={t(h.labelKey)}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn
              variant={recording === h.id ? "primary" : "ghost"}
              onClick={() => {
                setMsg("");
                setRecording(recording === h.id ? null : h.id);
              }}
            >
              {recording === h.id ? t("settings.hotkeys.press") : getCombo(h.id)}
            </Btn>
            <Btn
              variant="ghost"
              icon={RotateCcw}
              title={t("settings.hotkeys.reset")}
              disabled={getCombo(h.id) === h.defaultCombo}
              onClick={() => setCombo(h.id, null)}
            />
          </div>
        </Row>
      ))}
      {msg && (
        <div className="muted-sm" style={{ marginTop: -6 }}>
          {msg}
        </div>
      )}
    </>
  );
}
