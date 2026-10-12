import { useCallback, useEffect, useState } from "react";
import { MousePointerClick } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";

/** Пункты MoonApp в контекстном меню Проводника Windows (только для текущего пользователя). */
export function ContextMenuRow() {
  const { t } = useI18n();
  const [state, setState] = useState<{ supported: boolean; installed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setState(await api.contextMenuStatus());
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state?.supported) return null;

  const toggle = async () => {
    setBusy(true);
    setMsg("");
    try {
      if (state.installed) await api.contextMenuRemove();
      else
        await api.contextMenuInstall({
          note: t("settings.contextMenu.noteLabel"),
          folder: t("settings.contextMenu.folderLabel"),
        });
      await load();
    } catch (e) {
      const m = (e as Error).message;
      setMsg(/dev_build/.test(m) ? t("settings.contextMenu.dev") : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row label={t("settings.contextMenu.title")} hint={t("settings.contextMenu.hint")}>
        <Btn icon={MousePointerClick} disabled={busy} onClick={() => void toggle()}>
          {state.installed ? t("settings.contextMenu.remove") : t("settings.contextMenu.add")}
        </Btn>
      </Row>
      {msg && (
        <div className="muted-sm" style={{ marginTop: -4 }}>
          {msg}
        </div>
      )}
    </>
  );
}
