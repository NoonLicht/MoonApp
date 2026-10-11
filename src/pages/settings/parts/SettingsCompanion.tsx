import { useCallback, useEffect, useState } from "react";
import { Smartphone, RefreshCw, Trash2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { CompanionStatus } from "@/api/apiCompanion";
import { Btn, Badge } from "@/components/ui";
import QrCode from "@/components/QrCode";
import { BoolRow, NumberInput, Row, Section } from "@/pages/settings/parts/SettingsControls";
import { PhoneCamPanel } from "@/pages/settings/parts/PhoneCamPanel";

const fmtBytes = (n: number): string =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Настройки веб-компаньона: включение, адрес + QR, код сопряжения, устройства и «входящие». */
export function CompanionSection() {
  const { t, lang } = useI18n();
  const [st, setSt] = useState<CompanionStatus | null>(null);
  const [port, setPort] = useState(4717);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    api
      .companionStatus()
      .then((s) => {
        setSt(s);
        setPort(s.port);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  // Пока включён: тикаем для обратного отсчёта кода и подтягиваем новые устройства/файлы.
  useEffect(() => {
    if (!st?.running) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(load, 5000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [st?.running, load]);

  const toggle = async (enabled: boolean) => {
    setError("");
    try {
      setSt(await api.companionEnable(enabled, port));
    } catch (e) {
      const m = (e as Error).message;
      setError(m.includes("port_in_use") ? t("companion.portInUse") : m);
      load();
    }
  };

  const left = st?.pairing ? Math.max(0, Math.round((st.pairing.expiresAt - now) / 1000)) : 0;
  const fmtTime = (ts: number) => new Date(ts).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" });

  return (
    <Section title={t("companion.title")} icon={Smartphone}>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        {t("companion.hint")}
      </div>
      <BoolRow
        label={t("companion.enable")}
        hint={t("companion.enableHint")}
        value={!!st?.enabled}
        onChange={(v) => void toggle(v)}
      />
      <Row label={t("companion.port")} hint={t("companion.portHint")}>
        <NumberInput value={port} onChange={(v) => setPort(Number(v) || 4717)} min={1024} max={65535} step={1} />
      </Row>
      {error && <div className="muted-sm" style={{ color: "var(--coral)" }}>{error}</div>}

      {st?.running && (
        <>
          <Row label={t("companion.address")} hint={t("companion.addressHint")}>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              {st.urls[0] ? <QrCode text={st.urls[0]} /> : null}
              <div>
                {st.urls.length === 0 && <span className="muted-sm">{t("companion.noNetwork")}</span>}
                {st.urls.map((u) => (
                  <div key={u}>
                    <code>{u}</code>
                  </div>
                ))}
              </div>
            </div>
          </Row>
          <Row label={t("companion.code")} hint={t("companion.codeHint")}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <b style={{ fontSize: 26, letterSpacing: "0.25em" }}>{st.pairing && left > 0 ? st.pairing.code : "——————"}</b>
              {st.pairing && left > 0 && (
                <span className="muted-sm">{t("companion.codeLeft", { m: Math.floor(left / 60), s: String(left % 60).padStart(2, "0") })}</span>
              )}
              <Btn icon={RefreshCw} onClick={() => void api.companionNewCode().then(setSt)}>
                {t("companion.newCode")}
              </Btn>
            </div>
          </Row>
          <PhoneCamPanel st={st} onStatus={setSt} />
        </>
      )}

      {(st?.devices.length ?? 0) > 0 && (
        <Row label={t("companion.devices")} hint={t("companion.devicesHint")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {st!.devices.map((d) => (
              <div key={d.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <Badge tone="teal">{d.name}</Badge>
                <span className="muted-sm" style={{ flex: 1 }}>
                  {t("companion.lastSeen", { when: fmtTime(d.lastSeen) })}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("companion.revoke")}
                  onClick={() => void api.companionRevoke(d.id).then(load)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </Row>
      )}

      {st && st.inbox.length > 0 && (
        <Row label={t("companion.inbox")} hint={st.inboxDir}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {st.inbox.slice(0, 8).map((f) => (
              <span key={f.name} className="muted-sm">
                {f.name} · {fmtBytes(f.size)}
              </span>
            ))}
          </div>
        </Row>
      )}
    </Section>
  );
}
