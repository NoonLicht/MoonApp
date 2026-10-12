import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Почта: автонастройка серверов, разбор поисковых операторов и очередь отправки. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-mail-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
let mail: any;
beforeAll(() => {
  mail = req("../server/mail/mailService");
});

describe("guessServers", () => {
  it("знает популярные почтовые сервисы", () => {
    const g = mail.guessServers("a@gmail.com");
    expect(g.imapHost).toBe("imap.gmail.com");
    expect(g.smtpPort).toBe(465);
    expect(mail.guessServers("a@yandex.ru").imapHost).toBe("imap.yandex.ru");
  });
  it("для неизвестного домена подставляет imap./smtp.", () => {
    const g = mail.guessServers("me@corp.example");
    expect(g.imapHost).toBe("imap.corp.example");
    expect(g.smtpHost).toBe("smtp.corp.example");
  });
});

describe("parseSearch", () => {
  it("разбирает операторы и свободный текст", () => {
    const s = mail.parseSearch("from:ivan is:unread счёт");
    expect(s.where.length).toBe(3);
    expect(s.args).toContain("%ivan%");
    expect(s.args).toContain("%счёт%");
  });
  it("has:attachment не добавляет аргументов", () => {
    const s = mail.parseSearch("has:attachment");
    expect(s.where).toHaveLength(1);
    expect(s.args).toHaveLength(0);
  });
});

describe("очередь отправки", () => {
  it("отказывает без получателей и без ящика", () => {
    expect(() => mail.queueSend({ account: "nope", to: [], subject: "", html: "" })).toThrow();
  });
  it("пустой список писем и ящиков", () => {
    expect(mail.listAccounts()).toEqual([]);
    expect(mail.listMessages({ box: "inbox" })).toEqual([]);
    expect(mail.listOutbox()).toEqual([]);
  });
});

describe("шаблоны", () => {
  it("сохраняются и удаляются", () => {
    const t = mail.saveTemplate({ name: "Привет", subject: "Тема", body: "<p>Текст</p>" });
    expect(mail.listTemplates().map((x: any) => x.id)).toContain(t.id);
    mail.removeTemplate(t.id);
    expect(mail.listTemplates()).toEqual([]);
  });
});
