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

// GET /api/chat/models?provider=deepseek — динамический список моделей (кэш 10 минут)
const modelsCache = new Map(); // providerId → { at, models }
const MODELS_TTL = 10 * 60 * 1000;

router.get("/models", async (req, res) => {
  const { provider: providerId } = req.query;
  if (!providerId) return res.status(400).json({ error: "provider required" });
  const cached = modelsCache.get(providerId);
  if (cached && Date.now() - cached.at < MODELS_TTL) return res.json(cached.models);
  try {
    const provider = getProvider(providerId);
    const secret = getSecret(provider.id);
    if (!secret || typeof provider.listModels !== "function") {
      return res.json(provider.models || []);
    }
    const models = await provider.listModels(secret);
    if (Array.isArray(models) && models.length) modelsCache.set(providerId, { at: Date.now(), models });
    res.json(models.length ? models : (provider.models || []));
  } catch {
    try { res.json(getProvider(providerId).models || []); }
    catch (e) { res.status(500).json({ error: e.message }); }
  }
});

// PATCH /api/chat/:id — переименование / закрепление чата
router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!stmts.convGet.get(id)) return res.status(404).json({ error: "conversation not found" });
  const patch = {};
  if (typeof req.body?.title === "string" && req.body.title.trim()) patch.title = String(req.body.title).slice(0, 120);
  if (req.body?.pinned !== undefined) patch.pinned = req.body.pinned ? 1 : 0;
  stmts.convUpdate.run(id, patch);
  res.json(stmts.convGet.get(id));
});

// DELETE /api/chat/:id/messages/:msgid — усечь историю начиная с сообщения (регенерация/правка)
router.delete("/:id/messages/:msgid", (req, res) => {
  stmts.msgTruncateFrom.run(Number(req.params.id), Number(req.params.msgid));
  res.json({ ok: true });
});

// POST /:id/send — streaming SSE with abort support
router.post("/:id/send", async (req, res) => {
  const { text, model, temperature, maxTokens, stream: streamReq, topP, frequencyPenalty, presencePenalty, systemPrompt, images } = req.body || {};
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

  // Авто-название чата по первому сообщению
  let autoTitle = null;
  if (conv.title === "New chat") {
    autoTitle = String(text).replace(/\s+/g, " ").trim().slice(0, 48) || null;
    if (autoTitle) stmts.convUpdate.run(conv.id, { title: autoTitle });
  }

  const imgList = Array.isArray(images) ? images.filter((u) => /^data:image\//.test(u)).slice(0, 5) : [];
  stmts.msgInsert.run(conv.id, "user", String(text));
  stmts.convTouch.run(conv.id);

  const chatCfg = settings.get("chat");
  const limit = Number(chatCfg.contextMessages) || 30;
  const history = stmts.msgFor.all(conv.id).slice(-limit).map((m) => ({ role: m.role, text: m.text }));

  // Картинки прикрепляем к последнему (только что добавленному) user-сообщению
  if (imgList.length && history.length && history[history.length - 1].role === "user") {
    history[history.length - 1].images = imgList;
  }

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
  emit({ type: "meta", title: autoTitle || conv.title });

  const startedAt = Date.now();
  const abortController = new AbortController();
  // ВАЖНО: на Node 18+ событие 'close' у req срабатывает сразу после того, как
  // прочитано тело запроса (express.json), а НЕ при отключении клиента. Из-за
  // этого abort() убивал генерацию на первой же миллисекунде и в чат прилетало
  // «Generation stopped» у любого провайдера (проверено на Node v24: req
  // 'close' приходит на +1ms). Реальный признак ухода клиента — 'close' у
  // ответа при незавершённой записи (res.writableEnded === false).
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

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
    emit({
      type: "done", text: full,
      stats: { ms: Date.now() - startedAt, chars: full.length, tokensApprox: Math.round(full.length / 4) },
    });
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

// POST /:id/arena — один вопрос двум моделям параллельно (SSE, события помечены side: "a"|"b").
// persist=false — ответы НЕ пишутся в базу (пользователь выберет один через /choose).
router.post("/:id/arena", async (req, res) => {
  const { text, models, temperature, maxTokens, topP, frequencyPenalty, presencePenalty, systemPrompt, images, persist = true } = req.body || {};
  const [modelA, modelB] = Array.isArray(models) ? models : [];
  if (!text || !String(text).trim() || !modelA || !modelB) {
    return res.status(400).json({ error: "text and two models required" });
  }
  const conv = stmts.convGet.get(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const provider = getProvider(conv.provider);
  const secret = getSecret(provider.id);
  if (!secret) return res.status(409).json({ error: `Provider "${provider.id}" not configured. Save API key.` });

  let autoTitle = null;
  if (conv.title === "New chat") {
    autoTitle = String(text).replace(/\s+/g, " ").trim().slice(0, 48) || null;
    if (autoTitle) stmts.convUpdate.run(conv.id, { title: autoTitle });
  }

  const imgList = Array.isArray(images) ? images.filter((u) => /^data:image\//.test(u)).slice(0, 5) : [];
  stmts.msgInsert.run(conv.id, "user", String(text));
  stmts.convTouch.run(conv.id);

  const chatCfg = settings.get("chat");
  const limit = Number(chatCfg.contextMessages) || 30;
  const history = stmts.msgFor.all(conv.id).slice(-limit).map((m) => ({ role: m.role, text: m.text }));
  if (imgList.length && history.length && history[history.length - 1].role === "user") {
    history[history.length - 1].images = imgList;
  }
  const fullMessages = systemPrompt ? [{ role: "system", text: systemPrompt }, ...history] : history;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} };
  emit({ type: "meta", title: autoTitle || conv.title });

  const runSide = (side, mdl) => (async () => {
    const startedAt = Date.now();
    let full = "";
    try {
      full = await provider.chat({
        secret, model: mdl, messages: fullMessages,
        temperature: temperature ?? chatCfg.temperature ?? 0.7,
        maxTokens: maxTokens ?? chatCfg.maxTokens ?? 1024,
        stream: true, topP, frequencyPenalty, presencePenalty,
        onToken: (token) => emit({ type: "token", side, text: token }),
        signal: null,
      });
      if (persist) stmts.msgInsert.run(conv.id, "assistant", `[${side === "a" ? "A" : "B"} · ${mdl}]\n\n${full}`);
      emit({ type: "done", side, text: full, model: mdl, stats: { ms: Date.now() - startedAt, chars: full.length, tokensApprox: Math.round(full.length / 4) } });
    } catch (e) {
      emit({ type: "error", side, message: e.message });
    }
  })();

  await Promise.all([runSide("a", modelA), runSide("b", modelB)]);
  try { res.end(); } catch {}
});

// POST /:id/choose — сохранить выбранный в Arena ответ как ответ ассистента
router.post("/:id/choose", (req, res) => {
  const conv = stmts.convGet.get(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "empty text" });
  stmts.msgInsert.run(conv.id, "assistant", String(text));
  stmts.convTouch.run(conv.id);
  logger.action("chat.arenaChoose", { id: conv.id });
  res.json({ ok: true });
});

module.exports = router;