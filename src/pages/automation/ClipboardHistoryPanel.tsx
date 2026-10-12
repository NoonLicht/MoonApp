import { useCallback, useEffect, useState } from "react";
import { Pin, PinOff, Copy, Trash2 } from "lucide-react";
import { Glass, Btn, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Item = Awaited<ReturnType<typeof api.clipboardHistory>>["items"][number];

/**
 * История буфера обмена: выключена по умолчанию, включается явно. Секреты
 * (карты, токены, приватные ключи) в историю не попадают, обычные записи
 * хранятся неделю, закреплённые — пока их не удалят.
 */
export default function ClipboardHistoryPanel() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setItems((await api.clipboardHistory(q)).items);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [q]);

  useEffect(() => {
    void (api.getSettings() as Promise<{ clipboardHistory?: { enabled?: boolean } }>)
      .then((s) => setEnabled(s?.clipboardHistory?.enabled === true))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
    if (!enabled) return;
    const id = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(id);
  }, [load, enabled]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await api.updateSettings({ clipboardHistory: { enabled: next } });
    } catch (e) {
      setEnabled(!next);
      setErr((e as Error).message);
    }
  };

  return (
    <div>
      <SectionHead eyebrow={t("automation.clip.eyebrow")} title={t("automation.clip.title")} />
      <Glass className="p-4">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Btn variant={enabled ? "primary" : undefined} onClick={() => void toggle()}>
            {enabled ? t("automation.clip.on") : t("automation.clip.off")}
          </Btn>
          <input
            className="input"
            style={{ flex: 1, minWidth: 160 }}
            placeholder={t("automation.clip.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Btn
            icon={Trash2}
            onClick={() =>
              void api
                .clipboardClear()
                .then(load)
                .catch((e) => setErr((e as Error).message))
            }
          >
            {t("automation.clip.clear")}
          </Btn>
        </div>
        <div className="muted-sm" style={{ marginTop: 6 }}>
          {t("automation.clip.hint")}
        </div>
        {err && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{err}</div>}
        {items.length === 0 && (
          <div className="muted-sm" style={{ marginTop: 10 }}>
            {t("automation.clip.empty")}
          </div>
        )}
        {items.map((it) => (
          <div
            key={it.id}
            style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13 }}
          >
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={it.text}
            >
              {it.text.replace(/\s+/g, " ")}
            </span>
            <Btn
              variant="ghost"
              icon={Copy}
              onClick={() => void navigator.clipboard.writeText(it.text).catch(() => undefined)}
              aria-label={t("automation.clip.copy")}
            />
            <Btn
              variant="ghost"
              icon={it.pinned ? PinOff : Pin}
              onClick={() =>
                void api
                  .clipboardPin(it.id, !it.pinned)
                  .then(load)
                  .catch((e) => setErr((e as Error).message))
              }
              aria-label={t("automation.clip.pin")}
            />
            <Btn
              variant="ghost"
              icon={Trash2}
              onClick={() =>
                void api
                  .clipboardDelete(it.id)
                  .then(load)
                  .catch((e) => setErr((e as Error).message))
              }
              aria-label={t("automation.clip.delete")}
            />
          </div>
        ))}
      </Glass>
    </div>
  );
}
