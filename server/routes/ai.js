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
const flibusta = require("../flibusta");
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

/**
 * Рекомендация книги по избранному/закладкам (Flibusta) — тот же приём, что и
 * с фильмами: модель предлагает название+автора, дальше ищем в самой Flibusta,
 * чтобы открыть настоящую карточку, а не просто текст.
 */
router.post("/books/recommend", async (req, res) => {
  try {
    const fav = flibusta.myBooks("fav");
    const bm = flibusta.myBooks("bm");
    const seen = new Set();
    const lines = [];
    for (const b of [...fav, ...bm]) {
      if (seen.has(b.bid)) continue;
      seen.add(b.bid);
      lines.push(`${b.title} — ${b.author}${b.genres?.length ? ` (${b.genres.join(", ")})` : ""}`);
    }
    if (lines.length === 0) return res.status(400).json({ error: "empty_library" });

    const system =
      "Ты — рекомендательная система книг. Тебе дают список книг из избранного/" +
      "закладок пользователя. Проанализируй вкус (жанры, авторы, тон) и посоветуй " +
      "ОДНУ конкретную книгу, которой нет в списке. Ответь СТРОГО в формате " +
      '"Название — Автор", без кавычек, пояснений и нумерации — одна строка.';
    const user = `Избранное:\n${lines.slice(0, 200).join("\n")}`;

    const result = await ai.runFeature("books", { system, user, maxTokens: 60 });
    const raw = result.text.trim().split("\n")[0].replace(/^["'«»]+|["'«»]+$/g, "").trim();
    if (!raw) return res.status(502).json({ error: "empty_response" });
    const [titlePart, authorPart] = raw.split("—").map((s) => (s || "").trim());

    const found = await flibusta.searchBooks({ q: titlePart || raw, authorQ: authorPart || "", size: 10 });
    const match = found.books?.[0] || null;
    if (!match) return res.status(404).json({ error: "not_found", title: raw });
    res.json({ ok: true, title: raw, mode: result.mode, model: result.model, book: match });
  } catch (e) {
    logger.warn("ai.books.recommend failed", { err: String(e.message || e) });
    const msg = String(e.message || e);
    if (["ai_feature_off", "ai_no_api_key", "ai_no_local_model"].includes(msg)) {
      return res.status(400).json({ error: msg });
    }
    res.status(500).json({ error: "recommend_failed", detail: msg });
  }
});

/** Обёртка над runFeature для простых одноразовых текстовых действий:
 *  описание игры, объяснение снапшота монитора, категоризация транзакции,
 *  подсказка настроек конвертации, суммаризация заметки. Промпты (system)
 *  собираются на бэкенде — со страницы приходят только сырые данные. */
async function runSimple(res, feature, system, user, maxTokens) {
  try {
    const result = await ai.runFeature(feature, { system, user, maxTokens: maxTokens || 300 });
    res.json({ ok: true, text: result.text.trim(), mode: result.mode, model: result.model });
  } catch (e) {
    const msg = String(e.message || e);
    if (["ai_feature_off", "ai_no_api_key", "ai_no_local_model"].includes(msg)) {
      return res.status(400).json({ error: msg });
    }
    logger.warn(`ai.${feature} failed`, { err: msg });
    res.status(500).json({ error: "ai_failed", detail: msg });
  }
}

router.post("/games/describe", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "bad_name" });
  runSimple(
    res,
    "games",
    "Ты помогаешь заполнить карточку игры/приложения в личном лаунчере. По названию " +
      "исполняемого файла или игры дай короткое (1-2 предложения) описание на русском: " +
      "жанр/суть приложения. Если не уверен, что это за программа — честно скажи " +
      '"неизвестное приложение" и не выдумывай подробности. Только текст описания, без кавычек.',
    `Название: ${name}`,
    120,
  );
});

router.post("/monitor/explain", (req, res) => {
  const snapshot = String(req.body?.snapshot || "").trim();
  if (!snapshot) return res.status(400).json({ error: "bad_snapshot" });
  runSimple(
    res,
    "monitor",
    "Ты помогаешь понять показания системного монитора (CPU/GPU/память/диски) простыми " +
      "словами на русском. Тебе дают текущие цифры — коротко (2-4 предложения) скажи, " +
      "есть ли повод для беспокойства и что именно нагружено, без общих советов вида " +
      '"обратитесь к специалисту". Если всё в норме — так и скажи одной фразой.',
    snapshot,
    250,
  );
});

router.post("/budget/categorize", (req, res) => {
  const description = String(req.body?.description || "").trim();
  const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
  if (!description) return res.status(400).json({ error: "bad_description" });
  runSimple(
    res,
    "budget",
    "Ты категоризируешь банковскую транзакцию личного бюджета. Тебе дают описание " +
      "операции и список уже существующих категорий пользователя. Ответь СТРОГО одним " +
      "названием категории — выбери подходящую из списка, а если ни одна не подходит, " +
      "предложи новую короткую (1-2 слова) категорию на русском. Только название, без пояснений.",
    `Описание операции: ${description}\nСуществующие категории: ${categories.join(", ") || "нет"}`,
    30,
  );
});

router.post("/convert/suggest", (req, res) => {
  const fileName = String(req.body?.fileName || "").trim();
  const kind = String(req.body?.kind || "").trim();
  if (!fileName) return res.status(400).json({ error: "bad_file_name" });
  runSimple(
    res,
    "convert",
    "Ты советуешь настройки конвертации медиафайла. По имени файла и типу контента " +
      "(видео/аудио/изображение) дай короткую (2-3 предложения) рекомендацию на русском: " +
      "какой формат/кодек и качество разумны для такого контента. Без общих фраз, по делу.",
    `Файл: ${fileName}${kind ? `\nТип: ${kind}` : ""}`,
    200,
  );
});

router.post("/notes/summarize", (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "bad_text" });
  runSimple(
    res,
    "notes",
    "Ты суммируешь заметку пользователя в 2-4 коротких предложениях на русском — " +
      "только суть, без вступлений вида «в этой заметке говорится».",
    text.slice(0, 8000),
    250,
  );
});

module.exports = router;
