import { useCallback, useEffect, useState } from "react";
import { DatabaseBackup, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";

interface Item {
  id?: string;
  at: string;
  trigger: string;
}

/** Список бэкапов: создать, проверить по манифесту (sha256), восстановить. */
export function BackupRows() {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setItems(((await api.listBackups()) as Item[]).slice().reverse());
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      const m = (e as Error).message;
      setMsg(
        /no_manifest/.test(m)
          ? t("settings.backups.noManifest")
          : /corrupted/.test(m)
            ? t("settings.backups.corrupted")
            : m,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row label={t("settings.backups.title")} hint={t("settings.backups.hint")}>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn
            icon={DatabaseBackup}
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.createBackup();
                await load();
              })
            }
          >
            {t("settings.backups.create")}
          </Btn>
          <Btn icon={RefreshCw} disabled={busy} onClick={() => void load()} />
        </div>
      </Row>
      {items.slice(0, 8).map((b) => (
        <div
          key={b.id ?? b.at}
          style={{ display: "flex", gap: 8, alignItems: "center", marginTop: -4 }}
        >
          <span className="muted-sm" style={{ flex: 1 }}>
            {new Date(b.at).toLocaleString()} · {b.trigger}
          </span>
          <Btn
            icon={ShieldCheck}
            disabled={busy || !b.id}
            onClick={() =>
              run(async () => {
                const v = await api.backupVerify(b.id as string);
                setMsg(
                  v.ok
                    ? t("settings.backups.verifyOk", { n: v.checked })
                    : !v.hasManifest
                      ? t("settings.backups.noManifest")
                      : t("settings.backups.verifyBad", {
                          bad: v.corrupted.length,
                          missing: v.missing.length,
                        }),
                );
              })
            }
          >
            {t("settings.backups.verify")}
          </Btn>
          <Btn
            icon={Undo2}
            disabled={busy || !b.id}
            onClick={() =>
              run(async () => {
                if (!window.confirm(t("settings.backups.confirm"))) return;
                const r = await api.backupRestore(b.id as string);
                setMsg(t("settings.backups.restored", { n: r.restoredFiles }));
                await load();
              })
            }
          >
            {t("settings.backups.restore")}
          </Btn>
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
