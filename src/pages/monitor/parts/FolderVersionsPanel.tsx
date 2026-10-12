import FolderInput from "@/components/FolderInput";
import { useState } from "react";
import { History, Camera, RotateCcw, Trash2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { Glass, Btn } from "@/components/ui";
import { SubHead } from "@/pages/monitor/parts/MonitorSensors";
import { api } from "@/api/client";

type Version = Awaited<ReturnType<typeof api.folderVersions>>["items"][number];

const fmt = (n: number): string =>
  n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/**
 * Версии папки: полный снимок и восстановление. Восстановление не перезаписывает
 * исходную папку, а раскладывает версию рядом с ней.
 */
export function FolderVersionsPanel() {
  const { t } = useI18n();
  const [folder, setFolder] = useState("");
  const [items, setItems] = useState<Version[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => setItems((await api.folderVersions(folder)).items);

  return (
    <Glass className="p-4" style={{ marginTop: 16 }}>
      <SubHead>{t("monitor.versions.title")}</SubHead>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <FolderInput
          style={{ minWidth: 220 }}
          placeholder={t("monitor.versions.folder")}
          value={folder}
          onChange={setFolder}
        />
        <Btn icon={History} disabled={busy || !folder.trim()} onClick={() => void run(refresh)}>
          {t("monitor.versions.show")}
        </Btn>
        <Btn
          icon={Camera}
          variant="primary"
          disabled={busy || !folder.trim()}
          onClick={() =>
            void run(async () => {
              await api.folderVersionCreate(folder);
              await refresh();
              setMsg(t("monitor.versions.created"));
            })
          }
        >
          {t("monitor.versions.create")}
        </Btn>
      </div>
      {err && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{err}</div>}
      {msg && <div className="muted-sm" style={{ marginTop: 6 }}>{msg}</div>}
      {items.map((v) => (
        <div key={v.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13 }}>
          <span style={{ flex: 1 }}>
            {new Date(v.at).toLocaleString()} · {v.files} · {fmt(v.bytes)}
          </span>
          <Btn
            icon={RotateCcw}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await api.folderVersionRestore(folder, v.id);
                setMsg(t("monitor.versions.restored", { path: r.path }));
              })
            }
          >
            {t("monitor.versions.restore")}
          </Btn>
          <Btn
            variant="ghost"
            icon={Trash2}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.folderVersionDelete(folder, v.id);
                await refresh();
              })
            }
            aria-label={t("monitor.versions.delete")}
          />
        </div>
      ))}
      <div className="muted-sm" style={{ marginTop: 8 }}>
        {t("monitor.versions.hint")}
      </div>
    </Glass>
  );
}
