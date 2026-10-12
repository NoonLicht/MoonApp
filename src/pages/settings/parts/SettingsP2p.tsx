import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, Wifi, WifiOff } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";

type Status = Awaited<ReturnType<typeof api.p2pStatus>>;

/**
 * Синхронизация заметок с другим устройством по локальной сети. Приём
 * соединений включается вручную и не сохраняется между запусками; обмен
 * подписан и зашифрован парным ключом.
 */
export function P2pRows() {
  const { t } = useI18n();
  const [st, setSt] = useState<Status | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("47813");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setSt(await api.p2pStatus());
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
      setMsg(m === "wrong_key" ? t("settings.p2p.wrongKey") : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row label={t("settings.p2p.title")} hint={t("settings.p2p.hint")}>
        {st?.listening ? (
          <Btn
            icon={WifiOff}
            disabled={busy}
            onClick={() => void run(async () => setSt(await api.p2pDisable()))}
          >
            {t("settings.p2p.disable")}
          </Btn>
        ) : (
          <Btn
            icon={Wifi}
            disabled={busy}
            onClick={() => void run(async () => setSt(await api.p2pEnable()))}
          >
            {t("settings.p2p.enable")}
          </Btn>
        )}
      </Row>
      {st?.listening && (
        <div className="muted-sm" style={{ marginTop: -4, userSelect: "text" }}>
          <div>
            {t("settings.p2p.address", {
              list: st.addresses.map((a) => `${a}:${st.port}`).join(", ") || `:${st.port}`,
            })}
          </div>
          <div>
            {t("settings.p2p.key")}: <code>{st.key}</code>
          </div>
          <Btn
            variant="ghost"
            disabled={busy}
            onClick={() => void run(async () => setSt(await api.p2pRotateKey()))}
          >
            {t("settings.p2p.rotate")}
          </Btn>
        </div>
      )}
      <Row label={t("settings.p2p.connect")} hint={t("settings.p2p.connectHint")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            placeholder={t("settings.p2p.host")}
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <input
            className="input"
            style={{ width: 90 }}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder={t("settings.p2p.key")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Btn
            icon={RefreshCcw}
            disabled={busy || !host.trim() || key.trim().length !== 64}
            onClick={() =>
              void run(async () => {
                const r = await api.p2pSync(host.trim(), Number(port) || 47813, key.trim());
                setMsg(
                  t("settings.p2p.done", {
                    pulled: r.pulled,
                    pushed: r.pushed,
                    conflicts: r.conflicts,
                    failed: r.failed.length,
                  }),
                );
              })
            }
          >
            {t("settings.p2p.sync")}
          </Btn>
        </div>
      </Row>
      {msg && (
        <div className="muted-sm" style={{ marginTop: -4 }}>
          {msg}
        </div>
      )}
    </>
  );
}
