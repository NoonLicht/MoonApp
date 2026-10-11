import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";
import { Trash2, RefreshCw } from "lucide-react";

/** Сколько последних проблем показывать списком (остальные — в файле «Собрать логи»). */
const SHOWN = 5;

/** Журнал проблем: ошибки и предупреждения приложения, одинаковые склеены со счётчиком. */
export function ProblemsRow() {
  const { t } = useI18n();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.getProblems>>["items"]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setItems((await api.getProblems()).items);
    } catch {
      setItems([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function clear() {
    await api.clearProblems();
    setItems([]);
  }

  return (
    <>
      <Row
        label={t("settings.problemsLabel")}
        hint={
          items.length
            ? t("settings.problemsCount", { n: items.length })
            : t("settings.problemsEmpty")
        }
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Btn icon={RefreshCw} onClick={load} disabled={busy}>
            {t("settings.problemsRefresh")}
          </Btn>
          <Btn icon={Trash2} onClick={clear} disabled={busy || items.length === 0}>
            {t("settings.problemsClear")}
          </Btn>
        </div>
      </Row>
      {items.slice(0, SHOWN).map((p) => (
        <div key={p.id} className="muted-sm" style={{ marginTop: -6 }}>
          {p.level === "error" ? "⛔" : "⚠️"} {p.source} ×{p.count} — {p.message}
        </div>
      ))}
    </>
  );
}
