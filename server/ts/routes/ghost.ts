/**
 * Ghost Context (логика — в ghostContext.ts).
 *
 *  GET  /api/ghost/active   — { title, process } активного окна (только Windows)
 *  POST /api/ghost/context  — { title?, text?, exclude? } → { query, groups }
 *
 * Работает только при settings.ghost.enabled; иначе возвращает пустой результат.
 */
import express from "express";
import { execFile } from "child_process";
import settings from "../settings";
import * as semantic from "../semantic";
import * as g from "../ghostContext";
import * as extras from "../ghostExtras";
import * as ghostAi from "../ghostAi";

const router = express.Router();

const enabled = (): boolean => settings.get("ghost")?.enabled === true;
const aiOn = (): boolean => settings.get("ghost")?.ai !== false;

router.get("/active", (_req, res) => {
  if (!enabled() || process.platform !== "win32") return res.json({ title: "", process: "" });
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", g.ACTIVE_WINDOW_PS],
    { timeout: 5000, windowsHide: true },
    (err, stdout) => {
      const w = err ? null : g.parseActiveWindow(stdout);
      res.json(w ?? { title: "", process: "" });
    },
  );
});

router.post("/context", async (req, res) => {
  if (!enabled()) return res.json({ query: "", groups: [] });
  try {
    const query = g.buildQuery({
      title: String(req.body?.title ?? ""),
      text: String(req.body?.text ?? ""),
    });
    const sel = String(req.body?.text ?? "");
    if (!query) {
      // Без темы остаются «фоновые» подсказки: сроки, расписание, время.
      return res.json({ query: "", groups: await extras.collect("", sel) });
    }
    const hits = await semantic.search(query, { sources: g.GHOST_SOURCES, limit: 48 });
    const ex = req.body?.exclude;
    const exclude =
      ex && typeof ex.source === "string" && typeof ex.ref === "string"
        ? { source: ex.source, ref: ex.ref }
        : undefined;
    // Строго по смыслу: порог выше «чужой» зоны эмбеддингов (0.55–0.67).
    let pool = g.groupHits(hits, { exclude, minScore: 0.75, perSource: 4 });
    if (aiOn()) {
      // Нейросеть чата отбирает действительно относящееся и объясняет связь.
      const flat = pool.flatMap((x) => x.items);
      const judged = await ghostAi.judge(sel.trim() || query, flat, req.appPage);
      if (judged) pool = g.groupHits(judged, { perSource: 3 });
    }
    const groups = [
      ...pool,
      ...(await extras.collect(query, sel)),
    ];
    res.json({ query, groups });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
