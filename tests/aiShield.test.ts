import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/** Щит для ИИ и журнал отправок (server/ts/aiShield.ts). */
const req = createRequire(import.meta.url);
let sh: any;
beforeAll(() => {
  sh = req("../server/aiShield");
});

describe("щит для ИИ", () => {
  it("прячет ключи, карты и пароли и возвращает их обратно", () => {
    const src =
      "ключ sk-abcdefghijklmnopqrstuvwx, карта 4539 1488 0343 6467, пароль: hunter22x. Привет!";
    const r = sh.shieldText(src);
    expect(r.text).not.toContain("sk-abcdef");
    expect(r.text).not.toContain("4539");
    expect(r.text).not.toContain("hunter22x");
    expect(r.text).toContain("[API_КЛЮЧ_1]");
    expect(r.text).toContain("[КАРТА_1]");
    expect(r.text).toContain("пароль: [ПАРОЛЬ_1]");
    expect(r.found).toEqual({ "api-key": 1, card: 1, password: 1 });
    expect(sh.restoreText(r.text, r.map)).toBe(src);
  });

  it("не трогает обычный текст и числа, не проходящие Luhn", () => {
    const src = "Встреча 2026-10-11, заказ 1234 5678 9012 3456, версия 1.2.3";
    expect(sh.shieldText(src).text).toBe(src);
  });

  it("почту, телефон и IP прячет только в режиме pii", () => {
    const src = "пиши на a.b@example.com или +7 (912) 345-67-89, сервер 10.1.2.3";
    expect(sh.shieldText(src).text).toBe(src);
    const r = sh.shieldText(src, { pii: true });
    expect(r.text).toContain("[ПОЧТА_1]");
    expect(r.text).toContain("[ТЕЛЕФОН_1]");
    expect(r.text).toContain("[IP_1]");
  });

  it("одинаковое значение получает одну метку во всём запросе", () => {
    const key = "sk-abcdefghijklmnopqrstuvwx";
    const r = sh.shieldMessages([
      { role: "user", text: `первый ${key}` },
      { role: "user", text: `второй ${key} и ещё sk-zzzzzzzzzzzzzzzzzzzzzzzz` },
    ]);
    expect(r.messages[0].text).toBe("первый [API_КЛЮЧ_1]");
    expect(r.messages[1].text).toBe("второй [API_КЛЮЧ_1] и ещё [API_КЛЮЧ_2]");
    expect(r.found["api-key"]).toBe(3);
  });

  it("приватный ключ скрывается целиком", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\ndef\n-----END PRIVATE KEY-----";
    const r = sh.shieldText(`вот ${pem} всё`);
    expect(r.text).toBe("вот [КЛЮЧ_ПРИВАТНЫЙ_1] всё");
  });
});

describe("журнал отправок", () => {
  it("пишет метаданные, обрезает превью и считает сводку", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shield-")), "audit.jsonl");
    const long = "я".repeat(300);
    sh.appendAudit(
      sh.makeEntry({
        provider: "openai",
        model: "gpt",
        local: false,
        messages: [{ role: "user", text: long }],
        hidden: { card: 2 },
        at: 1,
      }),
      file,
    );
    sh.appendAudit(
      sh.makeEntry({
        provider: "llamacpp",
        model: "m",
        local: true,
        messages: [{ role: "user", text: "привет" }],
        hidden: {},
        preview: false,
        at: 2,
      }),
      file,
    );
    const list = sh.loadAudit(10, file);
    expect(list).toHaveLength(2);
    expect(list[0].preview).toHaveLength(80);
    expect(list[1].preview).toBe("");
    const s = sh.summarize(list);
    expect(s).toMatchObject({ total: 2, cloud: 1, local: 1, hidden: 2 });
    expect(s.byProvider.map((r: any) => r.provider).sort()).toEqual(["llamacpp", "openai"]);
    sh.clearAudit(file);
    expect(sh.loadAudit(10, file)).toEqual([]);
  });
});
