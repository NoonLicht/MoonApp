import { describe, it, expect } from "vitest";
import { parseCandidate, isPrivateAddress, verdict } from "../src/lib/webrtcLeak";

/** Проверка утечки WebRTC (src/lib/webrtcLeak.ts). */
describe("webrtcLeak", () => {
  it("разбирает строку кандидата", () => {
    expect(
      parseCandidate("candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0"),
    ).toEqual({ ip: "203.0.113.7", type: "srflx" });
    expect(parseCandidate("candidate:1 1 udp 2113937151 abcd-1234.local 5000 typ host")).toEqual({
      ip: "abcd-1234.local",
      type: "host",
    });
    expect(parseCandidate("мусор")).toBeNull();
  });

  it("распознаёт локальные адреса", () => {
    for (const ip of ["192.168.1.5", "10.1.2.3", "172.16.0.1", "169.254.1.1", "127.0.0.1", "fd00::1", "x.local"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "203.0.113.7"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("безопасно, если видны только локальные и relay-адреса", () => {
    const v = verdict(
      [
        { ip: "192.168.1.5", type: "host" },
        { ip: "198.51.100.1", type: "relay" },
      ],
      "198.51.100.1",
    );
    expect(v).toEqual({ publicIps: [], leak: false, safe: true });
  });

  it("утечка, если публичный адрес отличается от адреса приложения", () => {
    const v = verdict([{ ip: "203.0.113.7", type: "srflx" }], "198.51.100.1");
    expect(v.leak).toBe(true);
    expect(v.safe).toBe(false);
  });

  it("совпадение с адресом приложения — не утечка; без адреса приложения вердикт «не определено»", () => {
    expect(verdict([{ ip: "198.51.100.1", type: "srflx" }], "198.51.100.1").leak).toBe(false);
    expect(verdict([{ ip: "203.0.113.7", type: "srflx" }], null).leak).toBe(false);
  });
});
