const express = require("express");
const { stmts, db } = require("../db");
const settings = require("../settings");
const { PROVIDERS, getProvider } = require("../providers");
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

// GET /api/chat/models?provider=deepseek — dynamic model listing
router.get("/models", async (req, res) => {
  const { provider: providerId } = req.query;
  if (!providerId) return res.status(400).json({ error: "provider required" });
  try {
    const provider = getProvider(providerId);
    const secret = getSecret(provider.id);
    if (!secret || typeof provider.listModels !== "function") {
      return res.json(provider.models || []);
    }
    const models = await provider.listModels(secret);
    res.json(models);
  } catch {
    try { res.json(getProvider(providerId).models || []); }
    catch (e) { res.status(500).json({ error: e.message }); }
  }
});

// POST /:id/send — streaming SSE with abort support
router.post("/:id/send", async (req, res) => {
  const { text, model, temperature, maxTokens, stream: streamReq, topP, frequencyPenalty, presencePenalty, systemPrompt } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "empty message" });
  }
  const conv = stmts.convGet.get(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const provider = getProvider(conv.provider);
  const secret = getSecret(provider.id);
  if (!secret) {
    return res.status(409).json({ error: `Provider "${provider.id}" not configured. Save API key.` });
  }

  stmts.msgInsert.run(conv.id, "user", String(text));
  stmts.convTouch.run(conv.id);

  const chatCfg = settings.get("chat");
  const limit = Number(chatCfg.contextMessages) || 30;
  const history = stmts.msgFor.all(conv.id).slice(-limit).map((m) => ({ role: m.role, text: m.text }));

  const fullMessages = systemPrompt
    ? [{ role: "system", text: systemPrompt }, ...history]
    : history;

  const finalModel = model || chatCfg.model || provider.models?.[0] || "";
  const finalTemperature = temperature ?? chatCfg.temperature ?? 0.7;
  const finalMaxTokens = maxTokens ?? chatCfg.maxTokens ?? 1024;
  const streaming = streamReq !== false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} };

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    const onToken = (token) => { if (streaming) emit({ type: "token", text: token }); };
    const full = await provider.chat({
      secret, model: finalModel, messages: fullMessages,
      temperature: finalTemperature, maxTokens: finalMaxTokens, stream: streaming,
      onToken, signal: abortController.signal,
      topP, frequencyPenalty, presencePenalty,
    });
    stmts.msgInsert.run(conv.id, "assistant", full);
    logger.action("chat.completed", { id: conv.id, provider: provider.id, chars: full.length });
    emit({ type: "done", text: full });
  } catch (e) {
    if (e.name === "AbortError") {
      logger.action("chat.aborted", { id: conv.id });
      emit({ type: "error", message: "Generation stopped" });
    } else {
      logger.error("chat.error", { id: conv.id, error: e.message });
      emit({ type: "error", message: e.message });
    }
  } finally {
    try { res.end(); } catch {}
  }
});

module.exports = router;