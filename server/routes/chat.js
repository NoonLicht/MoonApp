const express = require("express");
const { stmts, db } = require("../db");
const settings = require("../settings");
const { getProvider } = require("../providers");
const { getSecret } = require("../security");
const logger = require("../logger");

const router = express.Router();

router.get("/", (req, res) => {
  res.json(stmts.convAll.all());
});

router.post("/", (req, res) => {
  const { provider = "openai", title = "New chat" } = req.body || {};
  const info = stmts.convInsert.run(provider, String(title));
  const conv = stmts.convGet.get(info.lastInsertRowid);
  logger.action("chat.create", { id: conv.id, provider });
  res.status(201).json(conv);
});

router.get("/:id/messages", (req, res) => {
  res.json(stmts.msgFor.all(Number(req.params.id)));
});

router.delete("/:id", (req, res) => {
  stmts.convDelete.run(Number(req.params.id));
  logger.action("chat.delete", { id: Number(req.params.id) });
  res.json({ ok: true });
});

/**
 * POST /:id/send — отправка сообщения. Потоковый ответ по SSE.
 * Middleware must set req.conv and req.provider (ниже в router.use).
 */
router.post("/:id/send", async (req, res) => {
  const { text } = req.body || {};
  const chatCfg = settings.get("chat");

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "empty message" });
  }
  const conv = stmts.convGet.get(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const provider = getProvider(conv.provider);
  const secret = getSecret(provider.id);
  if (!secret) {
    return res.status(409).json({ error: `Provider "${provider.id}" не настроен: сохраните ключ в настройках.` });
  }

  // Сохранение сообщения пользователя
  stmts.msgInsert.run(conv.id, "user", String(text));
  stmts.convTouch.run(conv.id);

  // История для контекста загружается (последние N сообщений)
  const limit = Number(chatCfg.contextMessages) || 30;
  const history = stmts.msgFor.all(conv.id)
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }));
  const model = req.body?.model || chatCfg.model;
  const temperature = req.body?.temperature ?? chatCfg.temperature;
  const maxTokens = req.body?.maxTokens ?? chatCfg.maxTokens;
  const stream = req.body?.stream ?? true;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    const onToken = (token) => { if (stream) emit({ type: "token", text: token }); };
    const full = await provider.chat({
      secret,
      model,
      messages: history,
      temperature,
      maxTokens,
      stream,
      onToken,
    });
    stmts.msgInsert.run(conv.id, "assistant", full);
    logger.action("chat.completed", { id: conv.id, provider: provider.id, chars: full.length });
    emit({ type: "done", text: full });
  } catch (e) {
    logger.error("chat.error", { id: conv.id, provider: provider.id, error: e.message });
    emit({ type: "error", message: e.message });
  } finally {
    res.end();
  }
});

module.exports = router;