/**
 * API RSS-ридера.
 *
 *  GET    /api/rss/feeds                      — ленты со счётчиками непрочитанного
 *  POST   /api/rss/feeds { url }              — подписаться (лента загружается сразу)
 *  DELETE /api/rss/feeds/:id                  — отписаться
 *  POST   /api/rss/refresh { feedId? }        — обновить все ленты или одну
 *  GET    /api/rss/items?feed=&unread=&saved=&q=&limit=
 *  PATCH  /api/rss/items/:id { read?, saved? }
 *  POST   /api/rss/items/read-all { feedId? }
 *  POST   /api/rss/items/:id/read-later       — в закладки с текстом статьи
 *  POST   /api/rss/digest { scope, language, feedId? } — ИИ-сводка
 *  POST   /api/rss/opml/import { opml }       — импорт подписок
 *  GET    /api/rss/opml/export                — экспорт подписок
 */
import express from "express";
import * as rss from "../rss";

const router = express.Router();

const fail = (res: express.Response, e: unknown, status = 400) =>
  res.status(status).json({ error: (e as Error).message || "error" });

router.get("/feeds", (_req, res) => res.json(rss.listFeeds()));

router.post("/feeds", async (req, res) => {
  try {
    res.status(201).json(await rss.addFeed(req.body && req.body.url));
  } catch (e) {
    fail(res, e);
  }
});

router.delete("/feeds/:id", (req, res) => {
  if (!rss.removeFeed(req.params.id)) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.post("/refresh", async (req, res) => {
  try {
    const r = await rss.refresh(req.body && req.body.feedId ? String(req.body.feedId) : undefined);
    if (r.added) rss.reindexSemantic();
    res.json(r);
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get("/items", (req, res) => {
  const q = req.query;
  res.json(
    rss.listItems({
      feedId: q.feed ? String(q.feed) : undefined,
      unread: q.unread === "1" || q.unread === "true",
      saved: q.saved === "1" || q.saved === "true",
      q: q.q ? String(q.q) : undefined,
      limit: q.limit ? parseInt(String(q.limit), 10) : undefined,
    }),
  );
});

router.get("/items/:id/article", async (req, res) => {
  try {
    res.json(await rss.fetchArticle(req.params.id));
  } catch (e) {
    fail(res, e, (e as Error).message === "not_found" ? 404 : 502);
  }
});

router.get("/settings", (_req, res) => res.json(rss.publicSettings()));

router.put("/settings", (req, res) => {
  rss.setSettings(req.body);
  res.json(rss.publicSettings());
});

router.delete("/items", (_req, res) => res.json(rss.clearStore()));

router.get("/search", async (req, res) => {
  const q = req.query;
  try {
    res.json(
      await rss.searchItems(String(q.q || ""), {
        feedId: q.feed ? String(q.feed) : undefined,
        unread: q.unread === "1" || q.unread === "true",
        saved: q.saved === "1" || q.saved === "true",
        limit: 200,
      }),
    );
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get("/items/:id", (req, res) => {
  const it = rss.getItem(req.params.id);
  if (!it) return res.status(404).json({ error: "not_found" });
  res.json(it);
});

router.post("/items/read-all", (req, res) => {
  res.json({ marked: rss.markAllRead(req.body && req.body.feedId ? String(req.body.feedId) : undefined) });
});

router.patch("/items/:id", (req, res) => {
  const it = rss.patchItem(req.params.id, req.body || {});
  if (!it) return res.status(404).json({ error: "not_found" });
  res.json(it);
});

router.post("/items/:id/read-later", async (req, res) => {
  try {
    res.json(await rss.saveForLater(req.params.id));
  } catch (e) {
    fail(res, e, (e as Error).message === "not_found" ? 404 : 500);
  }
});

router.post("/translate/unload", (_req, res) => {
  rss.unloadLocal();
  res.json({ ok: true });
});

router.post("/translate", async (req, res) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    res.json(await rss.translateItems(ids, String(b.lang || ""), rss.normEngine(b.engine)));
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/items/:id/article-translate", async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await rss.translateArticle(req.params.id, String(b.lang || ""), rss.normEngine(b.engine)));
  } catch (e) {
    fail(res, e, (e as Error).message === "not_found" ? 404 : 502);
  }
});

router.get("/digest/last", (_req, res) => {
  res.json(rss.getLastDigest());
});

router.post("/digest", async (req, res) => {
  try {
    const b = req.body || {};
    const scope = b.scope === "saved" || b.scope === "all" ? b.scope : "unread";
    res.json(await rss.digest(scope, String(b.language || "Russian"), b.feedId ? String(b.feedId) : undefined));
  } catch (e) {
    const code = (e as Error).message.split(":")[0];
    fail(res, e, code === "no_items" ? 404 : 502);
  }
});

router.post("/opml/import", async (req, res) => {
  try {
    const opml = req.body && req.body.opml;
    if (typeof opml !== "string" || !opml.trim()) return res.status(400).json({ error: "missing_opml" });
    res.json(await rss.importOpml(opml));
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get("/opml/export", (_req, res) => {
  res.type("text/x-opml").send(rss.exportOpml());
});

export = router;
