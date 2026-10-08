import { describe, it, expect } from "vitest";

import { isLang, LANGS } from "@/pages/myspace/m3e/lib/i18n";

describe("isLang", () => {
  it("accepts every language the UI offers", () => {
    for (const { key } of LANGS) expect(isLang(key)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLang("fr")).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });
});
