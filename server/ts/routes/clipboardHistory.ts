/**
 * История буфера обмена (логика — в clipboardHistory.ts).
 *
 *  GET    /api/clipboard-history           — ?q= → записи (закреплённые первыми)
 *  POST   /api/clipboard-history/:id/pin   — { pinned } → закрепить/открепить
 *  DELETE /api/clipboard-history/:id       — удалить запись
 *  DELETE /api/clipboard-history           — очистить всё, кроме закреплённого
 */
import express from "express";
import * as ch from "../clipboardHistory";

const router = express.Router();

router.get("/", (req, res) => {
  const list = ch.prune(ch.load());
  res.json({ items: ch.search(list, String(req.query.q ?? "")).slice(0, 200) });
});

router.post("/:id/pin", (req, res) => {
  ch.save(ch.setPinned(ch.load(), req.params.id, req.body?.pinned !== false));
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  ch.save(ch.remove(ch.load(), req.params.id));
  res.json({ ok: true });
});

router.delete("/", (_req, res) => {
  ch.clearUnpinned();
  res.json({ ok: true });
});

export = router;
