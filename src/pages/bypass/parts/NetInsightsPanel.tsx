import { useState } from "react";
import { Wifi, ShieldQuestion, Radar } from "lucide-react";
import { Glass, Btn, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { parseCandidate, verdict, type IceCandidate, type LeakVerdict } from "@/lib/webrtcLeak";

type Wifi = Awaited<ReturnType<typeof api.netWifiAnalyze>>;
type Dns = Awaited<ReturnType<typeof api.netDns>>;

/** Собирает ICE-кандидаты браузера: показывает, какие адреса видны сайтам через WebRTC. */
function collectIce(timeoutMs = 4000): Promise<IceCandidate[]> {
  return new Promise((resolve) => {
    const found = new Map<string, IceCandidate>();
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    } catch {
      resolve([]);
      return;
    }
    pc.createDataChannel("probe");
    pc.onicecandidate = (e) => {
      const c = e.candidate ? parseCandidate(e.candidate.candidate) : null;
      if (c) found.set(`${c.ip}|${c.type}`, c);
    };
    void pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => {
      pc.close();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/**
 * Сетевая диагностика: загруженность Wi-Fi каналов, DNS-серверы системы и
 * адреса, видимые через WebRTC (возможная утечка мимо прокси/VPN).
 */
export default function NetInsightsPanel() {
  const { t } = useI18n();
  const [wifi, setWifi] = useState<Wifi | null>(null);
  const [dns, setDns] = useState<Dns | null>(null);
  const [ice, setIce] = useState<IceCandidate[] | null>(null);
  const [leak, setLeak] = useState<LeakVerdict | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <SectionHead eyebrow={t("bypass.insights.eyebrow")} title={t("bypass.insights.title")} />
      <Glass className="p-4">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn icon={Wifi} disabled={!!busy} onClick={() => run("wifi", async () => setWifi(await api.netWifiAnalyze()))}>
            {t("bypass.insights.wifi")}
          </Btn>
          <Btn icon={ShieldQuestion} disabled={!!busy} onClick={() => run("dns", async () => setDns(await api.netDns()))}>
            {t("bypass.insights.dns")}
          </Btn>
          <Btn icon={Radar} disabled={!!busy} onClick={() => run("ice", async () => {
                const found = await collectIce();
                const appIp = await api.netPublicIp().then((r) => r.ip || null).catch(() => null);
                setIce(found);
                setLeak(verdict(found, appIp));
              })}>
            {busy === "ice" ? t("bypass.insights.checking") : t("bypass.insights.webrtc")}
          </Btn>
        </div>
        {err && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{err}</div>}

        {wifi && (
          <div style={{ marginTop: 12 }}>
            {!wifi.ok && <div className="muted-sm">{wifi.error || t("bypass.insights.wifiFail")}</div>}
            {wifi.ok && wifi.recommended && (
              <strong>{t("bypass.insights.recommended", { ch: wifi.recommended })}</strong>
            )}
            {wifi.ok && !wifi.recommended && <div className="muted-sm">{t("bypass.insights.noBand")}</div>}
            {wifi.ok && (
              <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 60, marginTop: 8 }}>
                {wifi.channels.map((c) => (
                  <div
                    key={c.channel}
                    title={`${c.channel}: ${c.networks}`}
                    style={{
                      flex: 1,
                      textAlign: "center",
                      fontSize: 10,
                    }}
                  >
                    <div
                      style={{
                        height: Math.min(48, 6 + c.interference * 14),
                        background: c.channel === wifi.recommended ? "var(--teal)" : "var(--amber)",
                        borderRadius: 3,
                      }}
                    />
                    {c.channel}
                  </div>
                ))}
              </div>
            )}
            {wifi.nets.slice(0, 8).map((n, i) => (
              <div key={i} className="muted-sm">
                {n.ssid} — {n.signal}% {n.channel ? `· ch ${n.channel}` : ""}
              </div>
            ))}
          </div>
        )}

        {dns && (
          <div style={{ marginTop: 12 }}>
            {dns.servers.length === 0 && <div className="muted-sm">{t("bypass.insights.dnsNone")}</div>}
            {dns.servers.map((s) => (
              <div key={s.ip} className="muted-sm">
                {s.ip} — {t(`bypass.insights.dnsKind_${s.kind.replace("-", "_")}`)}
                {s.provider ? ` (${s.provider})` : ""}
              </div>
            ))}
            <div className="muted-sm">{t("bypass.insights.dnsHint")}</div>
          </div>
        )}

        {ice && (
          <div style={{ marginTop: 12 }}>
            {ice.length === 0 && <div className="muted-sm">{t("bypass.insights.iceNone")}</div>}
            {leak && (
              <strong style={{ color: leak.leak ? "var(--coral)" : "var(--teal)" }}>
                {leak.safe
                  ? t("bypass.insights.iceSafe")
                  : leak.leak
                    ? t("bypass.insights.iceLeak", { ip: leak.publicIps.join(", ") })
                    : t("bypass.insights.iceOk")}
              </strong>
            )}
            {ice.map((a) => (
              <div key={`${a.ip}|${a.type}`} className="muted-sm">
                {a.ip} ({a.type})
              </div>
            ))}
            {ice.length > 0 && <div className="muted-sm">{t("bypass.insights.iceHint")}</div>}
          </div>
        )}
      </Glass>
    </>
  );
}
