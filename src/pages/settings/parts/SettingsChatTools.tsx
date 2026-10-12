import { useState } from "react";
import { useI18n } from "@/app/i18n";
import { BoolRow } from "@/pages/settings/parts/SettingsControls";
import { isAutoSaveOn, setAutoSave } from "@/pages/ai-chat/lib/autoSave";

/** Автосохранение ценных ответов ИИ-чата в заметки (настройка этого устройства). */
export function ChatAutoSaveRow() {
  const { t } = useI18n();
  const [on, setOn] = useState(isAutoSaveOn());
  return (
    <BoolRow
      label={t("aichat.autoSave")}
      hint={t("aichat.autoSaveHint")}
      value={on}
      onChange={(v) => {
        setAutoSave(v);
        setOn(v);
      }}
    />
  );
}
