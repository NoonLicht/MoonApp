/**
 * API отключаемых страниц (Настройки → «Страницы»).
 *  GET /api/features            — состояние: профили, список страниц, что остановится/останется
 *  PUT /api/features            — { profile } или { disabled: string[] }
 */
import express from "express";
import * as features from "../features";

const router = express.Router();

router.get("/", (_req, res) => res.json(features.summary()));

router.put("/", (req, res) => {
  const body = (req.body ?? {}) as { profile?: unknown; disabled?: unknown };
  if (typeof body.profile === "string") {
    if (!(body.profile in features.PROFILES)) return res.status(400).json({ error: "bad_profile" });
    features.applyProfile(body.profile);
  } else if (Array.isArray(body.disabled)) {
    features.setDisabledPages(body.disabled.map(String));
  } else {
    return res.status(400).json({ error: "bad_request" });
  }
  res.json(features.summary());
});

export default router;
