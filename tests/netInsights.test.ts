import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Wi-Fi, каналы и DNS (server/ts/netInsights.ts). */
const req = createRequire(import.meta.url);
let ni: any;
beforeAll(() => {
  ni = req("../server/netInsights");
});

const NETSH = `
SSID 1 : Home
    Network type            : Infrastructure
    BSSID 1                 : aa:bb:cc:dd:ee:01
         Signal             : 90%
         Radio type         : 802.11n
         Channel            : 1
    BSSID 2                 : aa:bb:cc:dd:ee:02
         Signal             : 40%
         Channel            : 1

SSID 2 : Соседи
    BSSID 1                 : 11:22:33:44:55:66
         Сигнал             : 70%
         Канал              : 6

SSID 3 : Office5G
    BSSID 1                 : 77:88:99:aa:bb:cc
         Signal             : 55%
         Channel            : 44
`;

describe("parseNetsh", () => {
  it("берёт максимальный сигнал, канал и диапазон; понимает русские метки", () => {
    const n = ni.parseNetsh(NETSH);
    expect(n).toEqual([
      { ssid: "Home", signal: 90, channel: 1, band: "2.4" },
      { ssid: "Соседи", signal: 70, channel: 6, band: "2.4" },
      { ssid: "Office5G", signal: 55, channel: 44, band: "5" },
    ]);
  });
});

describe("parseNmcli", () => {
  it("разбирает поля через двоеточие с экранированием", () => {
    const n = ni.parseNmcli("My\\:Net:80:11\nOther:30:36\n");
    expect(n[0]).toMatchObject({ ssid: "My:Net", signal: 80, channel: 11, band: "2.4" });
    expect(n[1]).toMatchObject({ ssid: "Other", band: "5" });
  });
});

describe("analyzeChannels", () => {
  it("рекомендует наименее занятый из 1/6/11", () => {
    const nets = ni.parseNetsh(NETSH);
    const r = ni.analyzeChannels(nets);
    expect(r.recommended).toBe(11); // 1 и 6 заняты, 11 дальше всех
    expect(r.loads[0]).toMatchObject({ channel: 1, networks: 1 });
  });

  it("без сетей 2.4 ГГц рекомендации нет", () => {
    expect(ni.analyzeChannels([]).recommended).toBeNull();
  });
});

describe("DNS и ICE", () => {
  it("классифицирует адреса", () => {
    expect(ni.classifyDns("192.168.1.1")).toEqual({ kind: "private", provider: null });
    expect(ni.classifyDns("1.1.1.1")).toEqual({ kind: "public-known", provider: "Cloudflare" });
    expect(ni.classifyDns("5.6.7.8").kind).toBe("public-other");
    expect(ni.classifyDns("127.0.0.1").kind).toBe("loopback");
    expect(ni.classifyDns("999.1.1.1").kind).toBe("invalid");
  });

  it("разбирает ICE-кандидат", () => {
    const c = "candidate:842163049 1 udp 1677729535 203.0.113.7 51472 typ srflx raddr 0.0.0.0 rport 0";
    expect(ni.parseIceCandidate(c)).toEqual({ address: "203.0.113.7", type: "srflx" });
    expect(ni.parseIceCandidate("мусор")).toBeNull();
  });
});
