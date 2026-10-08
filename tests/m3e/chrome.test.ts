import { describe, expect, it } from "vitest";
import { chromeFrom } from "@/pages/myspace/m3e/lib/chrome";

const vars = (o: Record<string, string>) => (n: string) => o[n] ?? "";

describe("палитра оболочки M3E из темы приложения", () => {
  it("берёт акцент и поверхности приложения, все значения — hex", () => {
    const p = chromeFrom(
      vars({ "--bg-base": "#0c0e16", "--surface-solid": "#161927", "--amber": "#f0a63d" }),
    );
    expect(p.primary).toBe("#F0A63D");
    expect(p.surface).toBe("#161927");
    for (const v of Object.values(p).filter((x) => x !== "app" && x !== "App")) {
      expect(v).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("на светлой теме текст тёмный, а акцентный текст затемняется", () => {
    const p = chromeFrom(
      vars({
        "--bg-base": "#eef0f6",
        "--surface-solid": "#ffffff",
        "--text-primary": "#1c1d2b",
        "--amber": "#f0a63d",
      }),
    );
    expect(p.onSurface).toBe("#1C1D2B");
    expect(p.onSecondaryContainer).not.toBe(p.primary);
  });

  it("без переменных отдаёт тёмную тему по умолчанию", () => {
    expect(chromeFrom(() => "").surface).toBe("#161927");
  });
});
