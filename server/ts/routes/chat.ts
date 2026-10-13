import express from "express";
import { stmts } from "../db";
import settings from "../settings";
import { getProvider } from "../providers";
import { getSecret } from "../security";
import { runWithPage } from "../middleware/perPageProxy";
import logger from "../logger";
import * as semantic from "../semantic";
import { boundOf } from "../aiBindings";

const router = express.Router();

router.get("/", (req, res) => {
  res.json(stmts.convAll.all());
});

router.post("/", (req, res) => {
  const { provider = "openai", title = "New chat" } = req.body || {};
  const info = stmts.convInsert.run(provider, String(title));
  const conv = stmts.convGet.get(info.lastInsertRowid) as any;
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
  // Локальные модели (скачали/удалили файл) кэшировать нельзя: список читается с диска.
  const isLocal = providerId === "llamacpp" || providerId === "ollama";
  const cached = isLocal ? undefined : modelsCache.get(providerId);
  if (cached && Date.now() - cached.at < MODELS_TTL) return res.json(cached.models);
  try {
    const provider = getProvider(providerId as string);
    const secret = getSecret(provider.id);
    if (!secret || typeof provider.listModels !== "function") {
      return res.json(provider.models || []);
    }
    const models = await runWithPage(req.appPage, () => provider.listModels(secret));
    if (!isLocal && Array.isArray(models) && models.length)
      modelsCache.set(providerId, { at: Date.now(), models });
    res.json(models.length ? models : provider.models || []);
  } catch {
    try {
      res.json(getProvider(providerId as string).models || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
});

// PATCH /api/chat/:id — переименование / закрепление чата
router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!stmts.convGet.get(id)) return res.status(404).json({ error: "conversation not found" });
  const patch: Record<string, any> = {};
  if (typeof req.body?.title === "string" && req.body.title.trim())
    patch.title = String(req.body.title).slice(0, 120);
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
  const {
    text,
    model,
    temperature,
    maxTokens,
    stream: streamReq,
    topP,
    frequencyPenalty,
    presencePenalty,
    systemPrompt,
    images,
    provider: wantedProvider,
    continue: wantContinue,
  } = req.body || {};
  const isContinue = wantContinue === true;
  if (!isContinue && (!text || !String(text).trim())) {
    return res.status(400).json({ error: "empty message" });
  }
  const conv = stmts.convGet.get(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  // «Продолжить»: дописываем оборванный последний ответ ассистента, новый вопрос не создаётся.
  const lastMsg = isContinue
    ? ((stmts.msgFor.all(conv.id) as any[]).slice(-1)[0] as
        | { id: number; role: string; text: string }
        | undefined)
    : undefined;
  if (isContinue && (!lastMsg || lastMsg.role !== "assistant")) {
    return res.status(400).json({ error: "nothing_to_continue" });
  }

  // Провайдер сменили в селекторе — продолжаем этот же чат на новом, история сохраняется.
  if (typeof wantedProvider === "string" && wantedProvider && wantedProvider !== conv.provider) {
    try {
      getProvider(wantedProvider);
      stmts.convUpdate.run(conv.id, { provider: wantedProvider });
      conv.provider = wantedProvider;
    } catch {
      /* неизвестный провайдер — остаёмся на текущем */
    }
  }

  // Привязка «AI-чат» (Настройки → «Привязка моделей ИИ») главнее выбора в селекторе.
  const chatBound = boundOf("chat");
  const provider = getProvider(chatBound ? chatBound.provider : conv.provider);
  const secret = getSecret(provider.id);
  if (!secret) {
    return res
      .status(409)
      .json({ error: `Provider "${provider.id}" not configured. Save API key.` });
  }

  // Авто-название чата по первому сообщению
  let autoTitle = null;
  if (!isContinue && conv.title === "New chat") {
    autoTitle = String(text).replace(/\s+/g, " ").trim().slice(0, 48) || null;
    if (autoTitle) stmts.convUpdate.run(conv.id, { title: autoTitle });
  }

  const imgList = Array.isArray(images)
    ? images.filter((u) => /^data:image\//.test(u)).slice(0, 5)
    : [];
  if (!isContinue) stmts.msgInsert.run(conv.id, "user", String(text));
  stmts.convTouch.run(conv.id);

  const chatCfg = settings.get("chat");
  const limit = Number(chatCfg.contextMessages) || 30;
  const history: any[] = stmts.msgFor
    .all(conv.id)
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }));

  // Картинки прикрепляем к последнему (только что добавленному) user-сообщению
  if (imgList.length && history.length && history[history.length - 1].role === "user") {
    history[history.length - 1].images = imgList;
  }
  if (isContinue) {
    history.push({
      role: "user",
      text:
        "Продолжи свой предыдущий ответ ровно с того места, где он оборвался. " +
        "Не повторяй уже написанное и не добавляй вступлений.",
    });
  }

  const memo =
    chatCfg.memory && !isContinue ? await semantic.memoryFor(conv.id, String(text)) : "";
  const sys = [systemPrompt, memo].filter(Boolean).join("\n\n");
  const fullMessages = sys ? [{ role: "system", text: sys }, ...history] : history;

  // Имя локального .gguf-файла не имеет смысла облачному провайдеру (чат мог быть создан
  // на DeepSeek, а в селекторе осталась локальная модель) — берём его собственную модель.
  const isLocalFile = (m: unknown): boolean => /\.gguf$/i.test(String(m || ""));
  const pick = (m: unknown): string =>
    m && (provider.id === "llamacpp" || !isLocalFile(m)) ? String(m) : "";
  const finalModel =
    (chatBound ? chatBound.model : "") ||
    pick(model) ||
    pick(chatCfg.model) ||
    provider.models?.[0] ||
    "";
  const finalTemperature = temperature ?? chatCfg.temperature ?? 0.7;
  const finalMaxTokens = maxTokens ?? chatCfg.maxTokens ?? 1024;
  const streaming = streamReq !== false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (payload: any) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
/* клиент закрыл соединение — писать некуда */
}
  };
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
    let firstTokenAt = 0;
    const onToken = (token: any) => {
      if (!firstTokenAt) firstTokenAt = Date.now();
      if (streaming) emit({ type: "token", text: token });
    };
    const full = await runWithPage(req.appPage, () =>
      provider.chat({
        secret,
        model: finalModel,
        messages: fullMessages,
        temperature: finalTemperature,
        maxTokens: finalMaxTokens,
        stream: streaming,
        onToken,
        signal: abortController.signal,
        topP,
        frequencyPenalty,
        presencePenalty,
      }),
    );
    let saved = String(full);
    if (isContinue && lastMsg) {
      // Склейка: после законченного предложения — пробел, иначе (оборвано на слове) — встык.
      const prev = lastMsg.text;
      const glue = /[.!?:;)»"\n]$/.test(prev) && !/^[\s.,;:!?)\]]/.test(saved) ? " " : "";
      saved = prev + glue + saved;
      stmts.msgTruncateFrom.run(conv.id, lastMsg.id);
    }
    // Время генерации и оценка токенов (≈3.5 символа на токен) — показываются под сообщением
    let genMs = Date.now() - startedAt;
    if (isContinue && lastMsg) genMs += Number((lastMsg as { gen_ms?: number }).gen_ms) || 0;
    stmts.msgInsert.run(
      conv.id,
      "assistant",
      saved,
      genMs,
      Math.max(1, Math.round(saved.length / 3.5)),
    );
    logger.action("chat.completed", {
      id: conv.id,
      provider: provider.id,
      chars: full.length,
      continued: isContinue,
    });
    emit({
      type: "done",
      text: saved,
      stats: {
        ms: Date.now() - startedAt,
        // само «печатание» — без загрузки модели и разбора промпта (они у CPU занимают десятки секунд)
        genMs: firstTokenAt ? Date.now() - firstTokenAt : undefined,
        waitMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
        chars: full.length,
        tokensApprox: Math.round(full.length / 4),
      },
    });
  } catch (e: any) {
    if (e.name === "AbortError") {
      logger.action("chat.aborted", { id: conv.id });
      emit({ type: "error", message: "Generation stopped" });
    } else {
      logger.error("chat.error", { id: conv.id, error: e.message });
      emit({ type: "error", message: e.message });
    }
  } finally {
    try {
      res.end();
    } catch {
/* соединение уже закрыто клиентом */
}
  }
});

// POST /:id/compact — сжать историю: сводка вместо переписки (команда /compact)
// body: { model?, provider?, focus? } → { messages }
router.post("/:id/compact", async (req, res) => {
  const conv = stmts.convGet.get(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const wanted = req.body?.provider;
  if (typeof wanted === "string" && wanted && wanted !== conv.provider) {
    try {
      getProvider(wanted);
      stmts.convUpdate.run(conv.id, { provider: wanted });
      conv.provider = wanted;
    } catch {
      /* неизвестный провайдер — остаёмся на текущем */
    }
  }
  const compactBound = boundOf("chat");
  const provider = getProvider(compactBound ? compactBound.provider : conv.provider);
  const secret = getSecret(provider.id);
  if (!secret) return res.status(409).json({ error: `Provider "${provider.id}" not configured.` });

  const msgs = (stmts.msgFor.all(conv.id) as any[]).filter((m) => m.role !== "system");
  if (msgs.length < 2) return res.status(400).json({ error: "nothing_to_compact" });

  // Хвост переписки в разумных пределах: сводка не должна упираться в окно модели
  let transcript = msgs
    .map((m) => `${m.role === "user" ? "Пользователь" : "Ассистент"}: ${m.text}`)
    .join("\n\n");
  if (transcript.length > 24000) transcript = "…\n" + transcript.slice(-24000);
  const focus = String(req.body?.focus || "").trim();
  const instruction =
    "Сожми переписку ниже в краткую сводку, чтобы продолжить диалог без потери контекста. " +
    "Сохрани: цель пользователя, принятые решения, важные факты, имена, числа, пути, код и " +
    "незавершённые задачи. Без вступлений, списком или короткими абзацами, на языке переписки." +
    (focus ? `\nОсобое внимание: ${focus}.` : "");

  const chatCfg = settings.get("chat");
  const local = (m: unknown): boolean => /\.gguf$/i.test(String(m || ""));
  const pick = (m: unknown): string =>
    m && (provider.id === "llamacpp" || !local(m)) ? String(m) : "";
  const model =
    (compactBound ? compactBound.model : "") ||
    pick(req.body?.model) ||
    pick(chatCfg.model) ||
    provider.models?.[0] ||
    "";
  try {
    const summary = String(
      await runWithPage(req.appPage, () =>
        provider.chat({
          secret,
          model,
          messages: [
            { role: "system", text: instruction },
            { role: "user", text: transcript },
          ],
          temperature: 0.2,
          maxTokens: 1200,
          stream: false,
          onToken: () => undefined,
        }),
      ),
    ).trim();
    if (!summary) return res.status(502).json({ error: "empty_summary" });
    stmts.msgTruncateFrom.run(conv.id, (msgs[0] as any).id);
    stmts.msgInsert.run(conv.id, "user", `[Сводка предыдущего диалога]\n${summary}`);
    stmts.msgInsert.run(conv.id, "assistant", "Принято, продолжаем с учётом сводки.");
    stmts.convTouch.run(conv.id);
    logger.action("chat.compact", { id: conv.id, from: msgs.length, chars: summary.length });
    res.json({ messages: stmts.msgFor.all(conv.id) });
  } catch (e: any) {
    logger.error("chat.compact", { id: conv.id, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/arena — один вопрос двум моделям параллельно (SSE, события помечены side: "a"|"b").
// persist=false — ответы НЕ пишутся в базу (пользователь выберет один через /choose).
router.post("/:id/arena", async (req, res) => {
  const {
    text,
    models,
    temperature,
    maxTokens,
    topP,
    frequencyPenalty,
    presencePenalty,
    systemPrompt,
    images,
    persist = true,
  } = req.body || {};
  const [modelA, modelB] = Array.isArray(models) ? models : [];
  if (!text || !String(text).trim() || !modelA || !modelB) {
    return res.status(400).json({ error: "text and two models required" });
  }
  const conv = stmts.convGet.get(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const provider = getProvider(conv.provider);
  const secret = getSecret(provider.id);
  if (!secret)
    return res
      .status(409)
      .json({ error: `Provider "${provider.id}" not configured. Save API key.` });

  let autoTitle = null;
  if (conv.title === "New chat") {
    autoTitle = String(text).replace(/\s+/g, " ").trim().slice(0, 48) || null;
    if (autoTitle) stmts.convUpdate.run(conv.id, { title: autoTitle });
  }

  const imgList = Array.isArray(images)
    ? images.filter((u) => /^data:image\//.test(u)).slice(0, 5)
    : [];
  stmts.msgInsert.run(conv.id, "user", String(text));
  stmts.convTouch.run(conv.id);

  const chatCfg = settings.get("chat");
  const limit = Number(chatCfg.contextMessages) || 30;
  const history: any[] = stmts.msgFor
    .all(conv.id)
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }));
  if (imgList.length && history.length && history[history.length - 1].role === "user") {
    history[history.length - 1].images = imgList;
  }
  const memo = chatCfg.memory ? await semantic.memoryFor(conv.id, String(text)) : "";
  const sys = [systemPrompt, memo].filter(Boolean).join("\n\n");
  const fullMessages = sys ? [{ role: "system", text: sys }, ...history] : history;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (payload: any) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
/* клиент закрыл соединение — писать некуда */
}
  };
  emit({ type: "meta", title: autoTitle || conv.title });

  const runSide = (side: any, mdl: any) =>
    (async () => {
      const startedAt = Date.now();
      try {
        const full = await runWithPage(req.appPage, () =>
          provider.chat({
            secret,
            model: mdl,
            messages: fullMessages,
            temperature: temperature ?? chatCfg.temperature ?? 0.7,
            maxTokens: maxTokens ?? chatCfg.maxTokens ?? 1024,
            stream: true,
            topP,
            frequencyPenalty,
            presencePenalty,
            onToken: (token: any) => emit({ type: "token", side, text: token }),
            signal: undefined,
          }),
        );
        if (persist)
          stmts.msgInsert.run(
            conv.id,
            "assistant",
            `[${side === "a" ? "A" : "B"} · ${mdl}]\n\n${full}`,
          );
        emit({
          type: "done",
          side,
          text: full,
          model: mdl,
          stats: {
            ms: Date.now() - startedAt,
            chars: full.length,
            tokensApprox: Math.round(full.length / 4),
          },
        });
      } catch (e: any) {
        emit({ type: "error", side, message: e.message });
      }
    })();

  await Promise.all([runSide("a", modelA), runSide("b", modelB)]);
  try {
    res.end();
  } catch {
/* соединение уже закрыто клиентом */
}
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

export = router;
