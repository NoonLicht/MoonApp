/**
 * Тексты песен для караоке (логика — в lyrics.ts).
 *
 *  GET /api/lyrics?artist=&title=&duration= → { synced: [{ t, text }], plain }
 */
import express from "express";
import * as ly from "../lyrics";
import { runWithPage, pageFetch } from "../middleware/perPageProxy";

const router = express.Router();

router.get("/", async (req, res) => {
  const artist = String(req.query.artist ?? "").slice(0, 200);
  const title = String(req.query.title ?? "").slice(0, 200);
  if (!title.trim()) return res.status(400).json({ error: "title_required" });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await runWithPage("music", () =>
      pageFetch(ly.lrclibUrl(artist, title, Number(req.query.duration) || null), {
        signal: ctl.signal,
        headers: { "User-Agent": "MoonApp/1.0" },
      }),
    );
    if (r.status === 404) return res.json({ synced: [], plain: "" });
    if (!r.ok) return res.status(502).json({ error: `lrclib_${r.status}` });
    res.json(ly.pickLyrics((await r.json()) as ly.LrclibResponse));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  } finally {
    clearTimeout(timer);
  }
});

export = router;
