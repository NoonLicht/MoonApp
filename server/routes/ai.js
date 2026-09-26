"use strict";

/**
 * API ИИ-функций удобства (единый переключатель на страницах): DeepSeek API /
 * локальная ONNX-модель / выкл — см. server/aiRuntime.js.
 *
 *  GET    /api/ai/settings                — режим всех фич + есть ли ключ DeepSeek
 *  PUT    /api/ai/settings/:feature       — сменить режим/модель ОДНОЙ фичи
 *  GET    /api/ai/local-models            — каталог + что установлено + статус
 *  POST   /api/ai/local-models/:id/load   — скачать (если нужно) и загрузить в память
 *  DELETE /api/ai/local-models/:id        — удалить с диска
 *  POST   /api/ai/movies/recommend        — рекомендация фильма по своей библиотеке
 */

const express = require("express");
const ai = require("../aiRuntime");
const security = require("../security");
const { stmts } = require("../db");
const tmdb = require("../tmdb");
const logger = require("../logger");

const router = express.Router();

router.get("/settings", (req, res) => {
  res.json({ features: ai.getAiSettings(), hasApiKey: security.hasSecret("deepseek") });
});

router.put("/settings/:feature", (req, res) => {
  try {
    const setting = ai.setFeatureSetting(req.params.feature, {
      mode: req.body?.mode,
      localModel: req.body?.localModel,
    });
    res.json({ ok: true, setting });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

router.get("/local-models", (req, res) => {
  res.json({ models: ai.listLocalModels() });
});

router.post("/local-models/:id/load", async (req, res) => {
  try {
    await ai.warmLocalModel(req.params.id);
    res.json({ ok: true, status: ai.getLoadStatus(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), status: ai.getLoadStatus(req.params.id) });
  }
});

router.get("/local-models/:id/status", (req, res) => {
  res.json(ai.getLoadStatus(req.params.id));
});

router.delete("/local-models/:id", (req, res) => {
  ai.deleteLocalModel(req.params.id);
  res.json({ ok: true });
});

/**
 * Рекомендация фильма/сериала по личной библиотеке: модель получает список
 * "название — оценка", отвечает ровно одним названием, дальше ищем его в TMDB
 * (тот же поиск, что и обычная строка поиска на странице) — так в модалке
 * оказывается настоящая карточка с постером, а не просто текст от модели.
 */
router.post("/movies/recommend", async (req, res) => {
  try {
    const ratings = stmts.mrAll.all();
    const watchlist = stmts.mwAll.all();
    if (ratings.length === 0 && watchlist.length === 0) {
      return res.status(400).json({ error: "empty_library" });
    }
    const seen = new Set();
    const lines = [];
    for (const r of ratings) {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${r.title} — оценка ${r.rating}/10`);
    }
    for (const w of watchlist) {
      const key = `${w.kind}:${w.id}`;
      if (seen.has(key) || !w.title) continue;
      seen.add(key);
      lines.push(`${w.title} — в списке "${w.status}", без оценки`);
    }

    const system =
      "Ты — рекомендательная система фильмов и сериалов. Тебе дают список уже " +
      "просмотренного пользователем с оценками. Проанализируй вкус (жанры, тон, " +
      "эпоху) и посоветуй ОДНО конкретное название, которого нет в списке. " +
      "Ответь СТРОГО названием фильма/сериала на языке оригинала или широко " +
      "известным международным названием — без кавычек, пояснений, года и " +
      "форматирования. Только название, одна строка.";
    const user = `Просмотрено:\n${lines.slice(0, 200).join("\n")}`;

    const result = await ai.runFeature("movies", { system, user, maxTokens: 60 });
    const title = result.text
      .trim()
      .split("\n")[0]
      .replace(/^["'«»]+|["'«»]+$/g, "")
      .trim();
    if (!title) return res.status(502).json({ error: "empty_response" });

    const found = await tmdb.search(title, "multi", 1);
    const match = found.items?.[0] || null;
    if (!match) {
      return res.status(404).json({ error: "not_found_in_tmdb", title });
    }
    res.json({ ok: true, title, mode: result.mode, model: result.model, movie: match });
  } catch (e) {
    logger.warn("ai.movies.recommend failed", { err: String(e.message || e) });
    const msg = String(e.message || e);
    if (msg === "ai_feature_off") return res.status(400).json({ error: "ai_feature_off" });
    if (msg === "ai_no_api_key") return res.status(400).json({ error: "ai_no_api_key" });
    if (msg === "ai_no_local_model") return res.status(400).json({ error: "ai_no_local_model" });
    res.status(500).json({ error: "recommend_failed", detail: msg });
  }
});

module.exports = router;
