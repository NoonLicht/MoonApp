import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

/** Почта, часть 2: правила, iCalendar, значок, настройки, защита от SSRF, шаблон трекинга. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-mail2-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let rules: any;
let ics: any;
let notify: any;
let settings: any;
let service: any;
let tracking: any;
beforeAll(() => {
  rules = req("../server/mail/mailRules");
  ics = req("../server/mail/mailIcs");
  notify = req("../server/mail/mailNotify");
  settings = req("../server/mail/mailSettings");
  service = req("../server/mail/mailService");
  tracking = req("../server/mail/mailTracking");
});

const subject = {
  from: "billing@shop.example",
  fromName: "Shop Billing",
  to: "me@example.com",
  cc: "",
  subject: "Your invoice #42",
  body: "Total due 120 USD",
  hasAttachment: true,
  isList: false,
  size: 4096,
};

describe("правила", () => {
  const rule = (conditions: any[], actions: any[], matchAll = true, position = 1) => ({
    id: "r",
    account: "",
    name: "t",
    enabled: true,
    matchAll,
    conditions,
    actions,
    position,
  });

  it("все условия / любое условие", () => {
    const c = [
      { field: "from", op: "contains", value: "shop" },
      { field: "subject", op: "contains", value: "refund" },
    ];
    expect(rules.matchRule(rule(c, [], true), subject)).toBe(false);
    expect(rules.matchRule(rule(c, [], false), subject)).toBe(true);
  });

  it("вложение, размер и регулярное выражение", () => {
    expect(
      rules.matchRule(rule([{ field: "hasAttachment", op: "is", value: "true" }], []), subject),
    ).toBe(true);
    expect(rules.matchRule(rule([{ field: "size", op: "gt", value: "2" }], []), subject)).toBe(
      true,
    );
    expect(
      rules.matchRule(rule([{ field: "subject", op: "regex", value: "#\\d+$" }], []), subject),
    ).toBe(true);
    expect(
      rules.matchRule(rule([{ field: "subject", op: "regex", value: "(" }], []), subject),
    ).toBe(false);
  });

  it("из перемещающих действий выполняется только первое", () => {
    const r1 = rule(
      [{ field: "from", op: "contains", value: "shop" }],
      [{ type: "archive" }, { type: "star" }],
      true,
      1,
    );
    const r2 = rule(
      [{ field: "from", op: "contains", value: "shop" }],
      [{ type: "trash" }, { type: "markRead" }],
      true,
      2,
    );
    const acts = rules.actionsFor([r2, r1], subject).map((a: any) => a.type);
    expect(acts).toEqual(["archive", "star", "markRead"]);
  });

  it("List-Unsubscribe: ссылка, mailto и one-click", () => {
    const u = rules.parseListUnsubscribe(
      "<mailto:u@x.test?subject=bye>, <https://x.test/u?i=1>",
      true,
    );
    expect(u.https).toBe("https://x.test/u?i=1");
    expect(u.mailto).toMatch(/^mailto:u@x\.test/);
    expect(u.oneClick).toBe(true);
  });
});

describe("iCalendar", () => {
  const ICS = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:abc",
    "SUMMARY:Stand-up\\, daily",
    "DTSTART;VALUE=DATE:20260311",
    "LOCATION:Room 1",
    'ORGANIZER;CN="Big Boss":mailto:boss@x.test',
    "DESCRIPTION:Line one\\nLine two",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("разбирает событие на весь день", () => {
    const ev = ics.parseIcs(ICS);
    expect(ev.summary).toBe("Stand-up, daily");
    expect(ev.allDay).toBe(true);
    expect(ev.organizer).toBe("boss@x.test");
    expect(ev.organizerName).toBe("Big Boss");
    expect(ev.description).toContain("Line two");
  });

  it("не событие — null; ответ содержит PARTSTAT", () => {
    expect(ics.parseIcs("hello")).toBeNull();
    const ev = ics.parseIcs(ICS);
    const reply = ics.buildReply(ev, "me@x.test", "Me", "DECLINED");
    expect(reply).toContain("METHOD:REPLY");
    expect(reply).toContain("PARTSTAT=DECLINED");
    expect(reply).toContain("UID:abc");
  });
});

describe("значок непрочитанных", () => {
  it("PNG 32×32 с корректной структурой", () => {
    for (const n of [1, 9, 42, 150]) {
      const png: Buffer = notify.badgePng(n);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
      expect(png.readUInt32BE(16)).toBe(32);
      expect(png.readUInt32BE(20)).toBe(32);
      // IDAT распаковывается в 32 строки по 1 + 32·4 байт
      const idat = png.indexOf("IDAT");
      const len = png.readUInt32BE(idat - 4);
      const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + len));
      expect(raw.length).toBe(32 * (1 + 32 * 4));
    }
  });
});

describe("настройки", () => {
  it("слияние по секциям, массивы заменяются целиком", () => {
    settings.setSettings({
      notify: { sound: false },
      pinned: [{ account: "a", path: "X", name: "X" }],
    });
    const s = settings.getSettings();
    expect(s.notify.sound).toBe(false);
    expect(s.notify.enabled).toBe(true);
    expect(s.pinned).toHaveLength(1);
    settings.setSettings({ pinned: [] });
    expect(settings.getSettings().pinned).toHaveLength(0);
  });

  it("секреты в публичном виде скрыты и не затираются маской", () => {
    settings.setSettings({ mcp: { key: "secret-key" } });
    const pub = settings.publicSettings();
    expect(pub.mcp.key).not.toBe("secret-key");
    expect(pub._secrets.mcpKey).toBe(true);
    settings.setSettingsFromClient({ mcp: { key: pub.mcp.key, enabled: false } });
    expect(settings.getSettings().mcp.key).toBe("secret-key");
  });
});

describe("защита от SSRF при отписке", () => {
  it("локальные и частные адреса блокируются", async () => {
    for (const u of [
      "http://127.0.0.1:4000/api",
      "http://localhost/x",
      "http://192.168.1.1/",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest",
      "http://[::1]/",
    ]) {
      await expect(service.assertPublicUrl(u)).rejects.toThrow();
    }
    await expect(service.assertPublicUrl("ftp://example.com/")).rejects.toThrow();
  });
});

describe("трекинг", () => {
  it("без настроенного эндпоинта письмо не меняется", () => {
    settings.setSettings({ tracking: { enabled: false, base: "", key: "" } });
    const p = {
      account: "a",
      to: ["x@y.z"],
      subject: "s",
      html: '<a href="https://a.test">a</a>',
      track: true,
    };
    const r = tracking.decorateOutgoing(p);
    expect(r.trackId).toBe("");
    expect(r.payload.html).toBe(p.html);
  });

  it("с эндпоинтом: пиксель и переписанные ссылки; шаблон воркера отдаёт события", () => {
    settings.setSettings({
      tracking: {
        enabled: true,
        base: "https://t.example.dev/",
        key: "k",
        opens: true,
        clicks: true,
      },
    });
    const r = tracking.decorateOutgoing({
      account: "a",
      to: ["x@y.z"],
      subject: "s",
      html: '<p><a href="https://a.test/p?q=1">a</a></p>',
      track: true,
    });
    expect(r.trackId).toMatch(/^[\w-]{12}$/);
    expect(r.payload.html).toContain(
      `https://t.example.dev/c/${r.trackId}?u=${encodeURIComponent("https://a.test/p?q=1")}`,
    );
    expect(r.payload.html).toContain(`/o/${r.trackId}.gif`);
    expect(tracking.WORKER_TEMPLATE).toContain("/events");
  });
});
