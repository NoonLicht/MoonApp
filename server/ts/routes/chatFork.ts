/**
 * Ветвление диалога (логика — в chatFork.ts).
 *
 *  POST /api/chat-fork/:id — { upToMessageId } → новый диалог с копией истории до этого сообщения
 */
import express from "express";
import { stmts } from "../db";
import * as fork from "../chatFork";

const router = express.Router();

router.post("/:id", (req, res) => {
  const id = Number(req.params.id);
  const src = stmts.convGet.get(id) as { provider: string; title: string } | undefined;
  if (!src) return res.status(404).json({ error: "conversation_not_found" });
  const msgs = (stmts.msgFor.all(id) as unknown as fork.ForkMsg[]) ?? [];
  const part = fork.messagesUpTo(msgs, Number(req.body?.upToMessageId));
  if (!part) return res.status(404).json({ error: "message_not_found" });
  const titles = (stmts.convAll.all() as unknown as { title: string }[]).map((c) => c.title);
  const info = stmts.convInsert.run(src.provider, fork.forkTitle(src.title, titles));
  const newId = Number(info.lastInsertRowid);
  for (const m of part) stmts.msgInsert.run(newId, m.role, m.text);
  res.status(201).json(stmts.convGet.get(newId));
});

export = router;
