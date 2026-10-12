/**
 * API почты (логика — server/ts/mail/*).
 *
 *  Ящики:      GET/POST /accounts · PATCH/DELETE /accounts/:id · GET /guess?email=
 *              POST /oauth/start {provider} · GET /oauth/:id
 *  Чтение:     POST /sync · GET /folders · /labels · /counts · /messages · /messages/:id[/thread]
 *              POST /load-older {account, folder}
 *  Действия:   POST /flags · /move · /delete · /snooze · /reminder · /unsubscribe · /invite
 *              (ids принимают «t:<id>» — вся цепочка в той же папке)
 *  Вложения:   GET /attachment/:id/:index · GET /eml/:id · POST /import/eml
 *  Отправка:   POST /send · GET /outbox · POST /outbox/:id/cancel|retry
 *  Черновики:  GET/POST /drafts · GET/DELETE /drafts/:id
 *  Прочее:     /templates · /signatures · /rules · /settings · /contacts · /contact · /avatar
 *              /ai · /tracking · /backup · /mcp/status
 */
import express from "express";
import * as mail from "../mail/mailService";
import * as settingsMod from "../mail/mailSettings";
import { runAi } from "../mail/mailAi";
import { avatarFor } from "../mail/mailAvatar";
import { oauthStatus, oauthConfigured, type OAuthProvider } from "../mail/mailOAuth";
import { WORKER_TEMPLATE, pollTracking, trackingSummary } from "../mail/mailTracking";
import { exportBundle, importBundle, exportMbox, splitMbox } from "../mail/mailBackup";
import { syncMcp, mcpStatus } from "../mail/mailMcp";

const router = express.Router();

// локальный MCP-сервер поднимается при старте, если включён в настройках
try {
  syncMcp();
} catch {
  /* настройки недоступны — включится при сохранении */
}

const fail = (res: express.Response, e: unknown, status = 400) =>
  res.status(status).json({ error: (e as Error).message || "error" });

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/* ------------------------------ ящики ------------------------------------- */

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

router.get("/guess", (req, res) => {
  const g = mail.guessServers(str(req.query.email));
  res.json({ ...g, oauthReady: g.oauth ? oauthConfigured(g.oauth) : false });
});

router.post("/oauth/start", async (req, res) => {
  try {
    const p = str((req.body ?? {}).provider);
    if (p !== "google" && p !== "microsoft") throw new Error("bad_provider");
    res.json(await mail.startOAuthLogin(p as OAuthProvider));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/oauth/:id", (req, res) => {
  const s = oauthStatus(req.params.id);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json(s);
});

/* ------------------------------ чтение ------------------------------------ */

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

router.post("/load-older", async (req, res) => {
  try {
    const b = req.body ?? {};
    res.json(await mail.loadOlder(str(b.account), str(b.folder)));
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/label", async (req, res) => {
  try {
    const b = req.body ?? {};
    await mail.setLabel(ids(b.ids), str(b.label), b.add !== false);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/folders", async (req, res) => {
  try {
    const b = req.body ?? {};
    if (b.rename) await mail.renameFolder(str(b.account), str(b.path), str(b.rename));
    else await mail.createFolder(str(b.account), str(b.path));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, 502);
  }
});

router.delete("/folders", async (req, res) => {
  try {
    await mail.deleteFolder(str(req.query.account), str(req.query.path));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/mark-all-read", async (req, res) => {
  try {
    const b = req.body ?? {};
    res.json({ count: await mail.markAllRead(str(b.account), str(b.folder)) });
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/empty", async (req, res) => {
  try {
    const b = req.body ?? {};
    res.json({ count: await mail.emptyFolder(str(b.account), str(b.special)) });
  } catch (e) {
    fail(res, e, 502);
  }
});

router.get("/folders", (req, res) => res.json(mail.listFolders(str(req.query.account))));
router.get("/labels", (req, res) => res.json(mail.listLabels(str(req.query.account))));
router.get("/counts", (_req, res) => res.json(mail.boxCounts()));

router.get("/messages", (req, res) => {
  const q = req.query;
  res.json(
    mail.listMessages({
      account: q.account ? String(q.account) : undefined,
      box: q.box ? String(q.box) : undefined,
      folder: q.folder ? String(q.folder) : undefined,
      label: q.label ? String(q.label) : undefined,
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

/* ------------------------------ действия ---------------------------------- */

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
  mail.setReminder(str(b.id), Number(b.at) || 0);
  res.json({ ok: true });
});

router.get("/reminders", (_req, res) => res.json(mail.dueReminders()));

router.post("/unsubscribe", async (req, res) => {
  try {
    res.json(await mail.unsubscribe(str((req.body ?? {}).id)));
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/invite", (req, res) => {
  try {
    const b = req.body ?? {};
    const p = str(b.partstat).toUpperCase();
    if (!["ACCEPTED", "DECLINED", "TENTATIVE"].includes(p)) throw new Error("bad_partstat");
    res.json(mail.replyInvite(str(b.id), p as "ACCEPTED" | "DECLINED" | "TENTATIVE"));
  } catch (e) {
    fail(res, e);
  }
});

/* ------------------------------ вложения ---------------------------------- */

router.get("/attachment/:id/:index", async (req, res) => {
  try {
    const a = await mail.fetchAttachment(req.params.id, Number(req.params.index));
    if (!a) return res.status(404).json({ error: "not_found" });
    const inline = req.query.inline === "1";
    res.setHeader("Content-Type", a.contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    );
    res.send(a.content);
  } catch (e) {
    fail(res, e, 502);
  }
});

router.get("/eml/:id", async (req, res) => {
  try {
    const src = await mail.fetchSource(req.params.id);
    if (!src) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", "message/rfc822");
    res.setHeader("Content-Disposition", "attachment; filename=message.eml");
    res.send(src);
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/import/eml", async (req, res) => {
  try {
    const b = req.body ?? {};
    const data = Buffer.from(str(b.data), "base64");
    const isMbox = /^From \S+/.test(data.subarray(0, 200).toString("latin1"));
    const parts = isMbox ? splitMbox(data) : [data];
    for (const p of parts) await mail.importEml(str(b.account), str(b.folder), p);
    res.json({ imported: parts.length });
  } catch (e) {
    fail(res, e, 502);
  }
});

router.get("/export/mbox", async (req, res) => {
  try {
    const buf = await exportMbox(str(req.query.account), str(req.query.folder));
    res.setHeader("Content-Type", "application/mbox");
    res.setHeader("Content-Disposition", "attachment; filename=mail.mbox");
    res.send(buf);
  } catch (e) {
    fail(res, e, 502);
  }
});

/* ------------------------------ отправка ---------------------------------- */

router.post("/send", (req, res) => {
  try {
    res.status(202).json(mail.queueSend(req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/outbox", (_req, res) => res.json(mail.listOutbox()));

/** Отмена отправки возвращает содержимое: окно написания можно открыть снова. */
router.post("/outbox/:id/cancel", (req, res) => {
  const p = mail.cancelSend(req.params.id);
  res.json({ ok: !!p, payload: p });
});

router.post("/outbox/:id/retry", (req, res) => {
  mail.retryOutbox(req.params.id);
  res.json({ ok: true });
});

/* ------------------------------ черновики --------------------------------- */

router.get("/drafts", (_req, res) => res.json(mail.listDrafts()));
router.get("/drafts/:id", (req, res) => {
  const d = mail.getDraft(req.params.id);
  if (!d) return res.status(404).json({ error: "not_found" });
  res.json(d);
});
router.post("/drafts", async (req, res) => {
  try {
    res.json(await mail.saveDraft(req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});
router.delete("/drafts/:id", async (req, res) => {
  await mail.deleteDraft(req.params.id);
  res.json({ ok: true });
});

/* -------------------------- шаблоны, подписи, правила --------------------- */

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

router.get("/signatures", (_req, res) => res.json(mail.listSignatures()));
router.post("/signatures", (req, res) => {
  const b = req.body ?? {};
  if (!b.name) return res.status(400).json({ error: "name_required" });
  res.json(mail.saveSignature(b));
});
router.delete("/signatures/:id", (req, res) => {
  mail.removeSignature(req.params.id);
  res.json({ ok: true });
});

router.get("/rules", (_req, res) => res.json(mail.listRules()));
router.post("/rules", (req, res) => {
  const b = req.body ?? {};
  if (!b.name) return res.status(400).json({ error: "name_required" });
  res.json(mail.saveRule(b));
});
router.delete("/rules/:id", (req, res) => {
  mail.removeRule(req.params.id);
  res.json({ ok: true });
});
router.post("/rules/run", async (req, res) => {
  try {
    res.json(
      await mail.runRulesNow(req.body && req.body.account ? String(req.body.account) : undefined),
    );
  } catch (e) {
    fail(res, e, 502);
  }
});

/* ------------------------------ настройки --------------------------------- */

router.get("/settings", (_req, res) => res.json(settingsMod.publicSettings()));
router.put("/settings", (req, res) => {
  settingsMod.setSettingsFromClient(req.body ?? {});
  syncMcp();
  res.json(settingsMod.publicSettings());
});
router.post("/settings/generate-key", (req, res) => {
  const which = str((req.body ?? {}).which);
  const key = settingsMod.newKey();
  if (which === "mcp") settingsMod.setSettings({ mcp: { key } });
  else if (which === "tracking") settingsMod.setSettings({ tracking: { key } });
  else return res.status(400).json({ error: "bad_target" });
  syncMcp();
  // ключ показывается один раз — его нужно скопировать в настройки клиента / воркера
  res.json({ key });
});
router.get("/mcp/status", (_req, res) => res.json(mcpStatus()));

/* ------------------------------ контакты, аватары ------------------------- */

router.get("/contacts", (req, res) => res.json(mail.contacts(str(req.query.q))));
router.get("/contact", (req, res) => res.json(mail.contactCard(str(req.query.address))));
router.get("/avatar", async (req, res) => {
  const a = await avatarFor(str(req.query.address));
  if (!a) return res.status(404).end();
  res.setHeader("Content-Type", a.type);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(a.data);
});

/* ------------------------------ ИИ, трекинг, бэкап ------------------------ */

router.post("/ai", async (req, res) => {
  try {
    res.json(await runAi(req.body ?? {}));
  } catch (e) {
    fail(res, e, 502);
  }
});

router.get("/tracking", async (_req, res) => {
  try {
    await pollTracking().catch(() => 0);
  } finally {
    res.json(trackingSummary());
  }
});
router.get("/tracking/worker", (_req, res) => res.json({ code: WORKER_TEMPLATE }));

router.get("/backup", (_req, res) => res.json(exportBundle()));
router.post("/backup", (req, res) => {
  try {
    res.json(importBundle(req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

export default router;
