/**
 * API помощника для «Документов» и «Таблиц» (подключён к /api/llamacpp/assistant):
 *
 *  POST /turn         — {model?, messages, tools?, maxTokens?, think?} → поток NDJSON:
 *                       {t:"token",d} | {t:"thinking",d} | {t:"done",content,toolCalls,finish,model} | {t:"error",error}
 *  POST /web/search   — {q, lang?, limit?} → {provider, hits:[{title,url,snippet}]}
 *  POST /web/fetch    — {url, offset?, maxChars?} → {url, title, text, total, next}
 *  GET  /web/settings — {searxng, hasBrave};  POST /web/settings — {searxng?, braveKey?}
 */
import express from "express";
import { runTurn, type TurnMessage, type ToolSpec } from "./llm";
import { setWebSettings, webFetch, webSearch, webSettings } from "./web";

const router = express.Router();

router.post("/turn", async (req, res) => {
  const b = (req.body ?? {}) as {
    model?: string;
    messages?: TurnMessage[];
    tools?: ToolSpec[];
    maxTokens?: number;
    temperature?: number;
    think?: boolean;
  };
  if (!Array.isArray(b.messages) || !b.messages.length)
    return void res.status(400).json({ error: "messages_required" });
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const send = (o: unknown): void => {
    if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`);
  };
  try {
    const r = await runTurn(
      { ...b, messages: b.messages, signal: ac.signal },
      { token: (d) => send({ t: "token", d }), thinking: (d) => send({ t: "thinking", d }) },
    );
    send({ t: "done", ...r });
  } catch (e) {
    if (!ac.signal.aborted) send({ t: "error", error: String((e as Error).message || e).slice(0, 400) });
  }
  res.end();
});

const fail = (res: express.Response, e: unknown): void => {
  res.status(400).json({ error: String((e as Error).message || e).slice(0, 300) });
};

router.post("/web/search", async (req, res) => {
  try {
    const q = String(req.body?.q ?? "").trim();
    if (!q) return void res.status(400).json({ error: "q_required" });
    res.json(
      await webSearch(q, String(req.body?.lang ?? "en"), Math.min(10, Number(req.body?.limit) || 6)),
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post("/web/fetch", async (req, res) => {
  try {
    res.json(
      await webFetch(
        String(req.body?.url ?? ""),
        Number(req.body?.offset) || 0,
        Math.min(20000, Number(req.body?.maxChars) || 9000),
      ),
    );
  } catch (e) {
    fail(res, e);
  }
});

router.get("/web/settings", (_req, res) => res.json(webSettings()));
router.post("/web/settings", (req, res) => res.json(setWebSettings(req.body ?? {})));

export = router;
