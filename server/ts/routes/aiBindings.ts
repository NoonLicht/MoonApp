/**
 * Привязка модели к каждой ИИ-функции (Настройки → «Привязка моделей ИИ»).
 *
 *  GET  /api/ai-bindings        — { features, bindings, providers }
 *  PUT  /api/ai-bindings/:id    — { auto?, provider?, model? } → привязка функции
 *  POST /api/ai-bindings/reset  — все функции обратно в «авто»
 */
import express from "express";
import { PROVIDERS } from "../providers";
import { getSecret } from "../security";
import * as b from "../aiBindings";

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({
    features: b.FEATURES,
    bindings: b.getBindings(),
    providers: (PROVIDERS as { id: string; label: string; local?: boolean; stub?: boolean }[])
      .filter((p) => !p.stub)
      .map((p) => ({
        id: p.id,
        label: p.label,
        local: !!p.local || p.id === "ollama",
        configured: !!getSecret(p.id),
      })),
  });
});

router.put("/:id", (req, res) => {
  try {
    res.json(b.setBinding(String(req.params.id), req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.post("/reset", (_req, res) => {
  b.resetBindings();
  res.json({ ok: true });
});

export = router;
