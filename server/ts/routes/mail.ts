/**
 * API почты (логика — server/ts/mail/mailService.ts).
 *
 *  GET    /api/mail/accounts · POST · PATCH /:id · DELETE /:id
 *  GET    /api/mail/guess?email=          — настройки серверов по домену
 *  POST   /api/mail/sync { account? }     — синхронизация
 *  GET    /api/mail/folders?account=      — папки с числами
 *  GET    /api/mail/counts                — счётчики виртуальных ящиков
 *  GET    /api/mail/messages?box=&account=&folder=&q=&unread=&threads=&limit=&offset=
 *  GET    /api/mail/messages/:id          — письмо; /thread — вся цепочка
 *  POST   /api/mail/flags { ids, seen?, flagged? }
 *  POST   /api/mail/move { ids, special? | path? }
 *  POST   /api/mail/delete { ids }
 *  POST   /api/mail/snooze { ids, until }
 *  POST   /api/mail/reminder { id, at }
 *  GET    /api/mail/reminders             — просроченные «нет ответа»
 *  GET    /api/mail/attachment/:id/:index
 *  POST   /api/mail/send · GET /outbox · POST /outbox/:id/cancel · POST /outbox/:id/retry
 *  GET/POST /api/mail/templates · DELETE /templates/:id
 *  GET    /api/mail/contacts?q= · /contact?address=
 */
import express from "express";
import * as mail from "../mail/mailService";

const router = express.Router();

const fail = (res: express.Response, e: unknown, status = 400) =>
  res.status(status).json({ error: (e as Error).message || "error" });

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

router.get("/accounts", (_req, res) => res.json(mail.listAccounts()));

router.post("/accounts", async (req, res) => {
  try {
    res.status(201).json(await mail.addAccount(req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.patch("/accounts/:id", (req, res) => {
  try {
    res.json(mail.updateAccount(req.params.id, req.body ?? {}));
  } catch (e) {
    fail(res, e, 404);
  }
});

router.delete("/accounts/:id", (req, res) => {
  mail.removeAccount(req.params.id);
  res.json({ ok: true });
});

router.get("/guess", (req, res) => res.json(mail.guessServers(String(req.query.email ?? ""))));

router.post("/sync", async (req, res) => {
  try {
    const acc = req.body && req.body.account ? String(req.body.account) : "";
    if (acc) res.json(await mail.syncAccount(acc));
    else {
      await mail.syncAll();
      res.json({ ok: true });
    }
  } catch (e) {
    fail(res, e, 502);
  }
});

router.get("/folders", (req, res) => res.json(mail.listFolders(String(req.query.account ?? ""))));
router.get("/counts", (_req, res) => res.json(mail.boxCounts()));

router.get("/messages", (req, res) => {
  const q = req.query;
  res.json(
    mail.listMessages({
      account: q.account ? String(q.account) : undefined,
      box: q.box ? String(q.box) : undefined,
      folder: q.folder ? String(q.folder) : undefined,
      q: q.q ? String(q.q) : undefined,
      unread: q.unread === "1",
      threads: q.threads === "0" ? false : true,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    }),
  );
});

router.get("/messages/:id", (req, res) => {
  const m = mail.getMessage(req.params.id);
  if (!m) return res.status(404).json({ error: "not_found" });
  res.json(m);
});

router.get("/messages/:id/thread", (req, res) => res.json(mail.getThread(req.params.id)));

router.post("/flags", async (req, res) => {
  try {
    const b = req.body ?? {};
    await mail.setFlags(ids(b.ids), {
      seen: typeof b.seen === "boolean" ? b.seen : undefined,
      flagged: typeof b.flagged === "boolean" ? b.flagged : undefined,
    });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/move", async (req, res) => {
  try {
    const b = req.body ?? {};
    await mail.moveMessages(ids(b.ids), {
      path: b.path ? String(b.path) : undefined,
      special: b.special ? String(b.special) : undefined,
    });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/delete", async (req, res) => {
  try {
    await mail.deleteForever(ids((req.body ?? {}).ids));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/snooze", (req, res) => {
  const b = req.body ?? {};
  mail.snooze(ids(b.ids), Number(b.until) || 0);
  res.json({ ok: true });
});

router.post("/reminder", (req, res) => {
  const b = req.body ?? {};
  mail.setReminder(String(b.id ?? ""), Number(b.at) || 0);
  res.json({ ok: true });
});

router.get("/reminders", (_req, res) => res.json(mail.dueReminders()));

router.get("/attachment/:id/:index", async (req, res) => {
  try {
    const a = await mail.fetchAttachment(req.params.id, Number(req.params.index));
    if (!a) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", a.contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    );
    res.send(a.content);
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/send", (req, res) => {
  try {
    res.status(202).json(mail.queueSend(req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/outbox", (_req, res) => res.json(mail.listOutbox()));
router.post("/outbox/:id/cancel", (req, res) => res.json({ ok: mail.cancelSend(req.params.id) }));
router.post("/outbox/:id/retry", (req, res) => {
  mail.retryOutbox(req.params.id);
  res.json({ ok: true });
});

router.get("/templates", (_req, res) => res.json(mail.listTemplates()));
router.post("/templates", (req, res) => {
  const b = req.body ?? {};
  if (!b.name) return res.status(400).json({ error: "name_required" });
  res.json(mail.saveTemplate(b));
});
router.delete("/templates/:id", (req, res) => {
  mail.removeTemplate(req.params.id);
  res.json({ ok: true });
});

router.get("/contacts", (req, res) => res.json(mail.contacts(String(req.query.q ?? ""))));
router.get("/contact", (req, res) => res.json(mail.contactCard(String(req.query.address ?? ""))));

export default router;
