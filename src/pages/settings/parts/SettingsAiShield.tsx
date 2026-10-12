import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { BoolRow, Row } from "@/pages/settings/parts/SettingsControls";

type Audit = Awaited<ReturnType<typeof api.aiShieldAudit>>;
type Cfg = {
  enabled: boolean;
  pii: boolean;
  audit: boolean;
  preview: boolean;
  names: boolean;
  localNames: boolean;
};

/**
 * «Щит для ИИ»: маскировка секретов перед облачными провайдерами и журнал
 * «кто что получал» (только метаданные и начало запроса после маскировки).
 */
export function AiShieldRows() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<Cfg>({
    enabled: true,
    pii: false,
    audit: true,
    preview: true,
    names: true,
    localNames: false,
  });
  const [log, setLog] = useState<Audit | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = (await api.getSettings()) as { aiShield?: Partial<Cfg> };
      setCfg((c) => ({ ...c, ...(s?.aiShield ?? {}) }));
      setLog(await api.aiShieldAudit(50));
    } catch {
      /* сервер недоступен — покажем значения по умолчанию */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = async (patch: Partial<Cfg>) => {
    setCfg((c) => ({ ...c, ...patch }));
    try {
      await api.updateSettings({ aiShield: patch });
    } catch {
      void load();
    }
  };

  const hiddenText = (h: Record<string, number>) =>
    Object.entries(h)
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");

  return (
    <>
      <BoolRow
        label={t("settings.aiShield.enabled")}
        hint={t("settings.aiShield.enabledHint")}
        value={cfg.enabled}
        onChange={(v) => void set({ enabled: v })}
      />
      <BoolRow
        label={t("settings.aiShield.pii")}
        hint={t("settings.aiShield.piiHint")}
        value={cfg.pii}
        onChange={(v) => void set({ pii: v })}
      />
      <BoolRow
        label={t("settings.aiShield.names")}
        hint={t("settings.aiShield.namesHint")}
        value={cfg.names}
        onChange={(v) => void set({ names: v })}
      />
      <BoolRow
        label={t("settings.aiShield.localNames")}
        hint={t("settings.aiShield.localNamesHint")}
        value={cfg.localNames}
        onChange={(v) => void set({ localNames: v })}
      />
      <BoolRow
        label={t("settings.aiShield.audit")}
        hint={t("settings.aiShield.auditHint")}
        value={cfg.audit}
        onChange={(v) => void set({ audit: v })}
      />
      <BoolRow
        label={t("settings.aiShield.preview")}
        hint={t("settings.aiShield.previewHint")}
        value={cfg.preview}
        onChange={(v) => void set({ preview: v })}
      />
      <Row
        label={t("settings.aiShield.log")}
        hint={
          log
            ? t("settings.aiShield.summary", {
                total: log.summary.total,
                cloud: log.summary.cloud,
                hidden: log.summary.hidden,
              })
            : ""
        }
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? t("settings.aiShield.hide") : t("settings.aiShield.show")}
          </Btn>
          <Btn
            variant="ghost"
            icon={Trash2}
            onClick={() => void api.aiShieldClear().then(load)}
          >
            {t("settings.aiShield.clear")}
          </Btn>
        </div>
      </Row>
      {open && log && (
        <div className="muted-sm" style={{ marginTop: -4, userSelect: "text" }}>
          {log.summary.byProvider.map((p) => (
            <div key={p.provider}>
              <b>{p.provider}</b>
              {p.local ? ` (${t("settings.aiShield.local")})` : ""}: {p.requests} ·{" "}
              {p.chars.toLocaleString()} · {t("settings.aiShield.hiddenCount", { n: p.hidden })}
            </div>
          ))}
          <hr />
          {log.items.length === 0 && <div>{t("settings.aiShield.empty")}</div>}
          {log.items.map((e) => (
            <div key={`${e.at}-${e.provider}-${e.chars}`}>
              {new Date(e.at).toLocaleString()} · <b>{e.provider}</b> · {e.model} · {e.chars}
              {Object.keys(e.hidden).length > 0 && ` · 🛡 ${hiddenText(e.hidden as Record<string, number>)}`}
              {e.preview && <div style={{ opacity: 0.7 }}>«{e.preview}»</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
