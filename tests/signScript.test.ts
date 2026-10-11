import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

/** scripts/ts/sign.ts → scripts/sign.js: выбор способа подписи и аргументы signtool. */
const req = createRequire(import.meta.url);
const sign = req("../scripts/sign.js");

const AZ = {
  AZURE_TS_ENDPOINT: "https://eus.codesigning.azure.net",
  AZURE_TS_ACCOUNT: "acc",
  AZURE_TS_PROFILE: "prof",
  AZURE_TS_DLIB: "C:\\x\\Azure.CodeSigning.Dlib.dll",
};

describe("подпись кода", () => {
  it("без секретов подпись выключена, а не падает", async () => {
    expect(sign.chooseMethod({})).toBe("none");
    expect(sign.chooseMethod({ WIN_CSC_FILE: "a.pfx" })).toBe("none"); // нет пароля
    expect(sign.chooseMethod({ AZURE_TS_ENDPOINT: "x" })).toBe("none"); // неполный набор
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const saved = { ...process.env };
    for (const k of Object.keys(AZ)) delete process.env[k];
    delete process.env.WIN_CSC_FILE;
    await expect(sign({ path: "C:\\out\\MoonApp.exe" })).resolves.toBeUndefined();
    expect(log.mock.calls[0][0]).toContain("unsigned");
    process.env = saved;
    log.mockRestore();
  });

  it("Azure выбирается при полном наборе и приоритетнее .pfx", () => {
    expect(sign.chooseMethod(AZ)).toBe("azure");
    expect(sign.chooseMethod({ ...AZ, WIN_CSC_FILE: "a", WIN_CSC_KEY_PASSWORD: "b" })).toBe("azure");
    expect(sign.chooseMethod({ WIN_CSC_FILE: "a", WIN_CSC_KEY_PASSWORD: "b" })).toBe("pfx");
  });

  it("аргументы signtool: SHA-256 и метка времени (подпись переживает срок сертификата)", () => {
    const az = sign.buildSignArgs("azure", "app.exe", AZ, "meta.json");
    expect(az).toEqual(expect.arrayContaining(["/fd", "SHA256", "/td", "SHA256", "/dlib", AZ.AZURE_TS_DLIB, "/dmdf", "meta.json"]));
    expect(az.some((a: string) => a.startsWith("http"))).toBe(true);
    expect(az[az.length - 1]).toBe("app.exe");
    const pfx = sign.buildSignArgs("pfx", "app.exe", { WIN_CSC_FILE: "c.pfx", WIN_CSC_KEY_PASSWORD: "pw" });
    expect(pfx).toEqual(expect.arrayContaining(["/f", "c.pfx", "/p", "pw", "/tr"]));
  });

  it("metadata для Azure содержит только публичные идентификаторы, без секретов", () => {
    const meta = JSON.parse(sign.azureMetadata({ ...AZ, AZURE_CLIENT_SECRET: "top-secret" }));
    expect(meta).toEqual({ Endpoint: AZ.AZURE_TS_ENDPOINT, CodeSigningAccountName: "acc", CertificateProfileName: "prof" });
    expect(JSON.stringify(meta)).not.toContain("top-secret");
  });
});
