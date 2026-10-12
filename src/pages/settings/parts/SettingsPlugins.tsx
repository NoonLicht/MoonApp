import { useCallback, useEffect, useRef, useState } from "react";
import { Puzzle, Trash2, Upload } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";

type Plugin = Awaited<ReturnType<typeof api.plugins>>["items"][number];

/**
 * Плагины: наборы навыков ИИ-чата и шаблонов заметок в JSON. Это только данные —
 * плагин не исполняет код и не получает доступа к приложению.
 */
export function PluginRows() {
  const { t } = useI18n();
  const [items, setItems] = useState<Plugin[]>([]);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.plugins()).items);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (file: File) => {
    setMsg("");
    try {
      const manifest = JSON.parse(await file.text());
      const r = await api.pluginInstall(manifest);
      setMsg(t("settings.plugins.installed", { name: r.name }));
      await load();
    } catch (e) {
      const m = (e as Error).message;
      setMsg(t("settings.plugins.failed", { reason: m }));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <Row label={t("settings.plugins.title")} hint={t("settings.plugins.hint")}>
        <Btn icon={Upload} onClick={() => fileRef.current?.click()}>
          {t("settings.plugins.install")}
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void install(f);
          }}
        />
      </Row>
      {items.map((p) => (
        <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: -4 }}>
          <Puzzle size={14} />
          <span style={{ flex: 1 }}>
            {p.name} <span className="muted-sm">v{p.version}</span>
          </span>
          <span className="muted-sm">
            {t("settings.plugins.counts", { s: p.skills, t: p.templates })}
          </span>
          <Btn
            variant="ghost"
            icon={Trash2}
            aria-label={t("settings.plugins.remove")}
            onClick={() =>
              void api
                .pluginRemove(p.id)
                .then(load)
                .catch((e) => setMsg((e as Error).message))
            }
          />
        </div>
      ))}
      {msg && (
        <div className="muted-sm" style={{ marginTop: -4 }}>
          {msg}
        </div>
      )}
    </>
  );
}
