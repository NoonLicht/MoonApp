/**
 * Правила «если → то» (горячие папки с цепочкой действий).
 *
 *  GET    /api/automation-rules          — правила и журнал выполнения
 *  POST   /api/automation-rules          — создать/обновить правило
 *  DELETE /api/automation-rules/:id      — удалить
 *  POST   /api/automation-rules/:id/run  — { file } прогнать цепочку над файлом из папки правила
 */
import express from "express";
import path from "path";
import * as rules from "../automationRules";

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({ rules: rules.listRules(), log: rules.getRunLog() });
});

router.post("/", (req, res) => {
  try {
    res.status(201).json(rules.saveRule(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.delete("/:id", (req, res) => {
  const ok = rules.deleteRule(req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.post("/:id/run", async (req, res) => {
  const rule = rules.listRules().find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: "not_found" });
  const file = String(req.body?.file ?? "");
  const rel = path.relative(rule.folder, file);
  // Только файлы из папки самого правила — иначе это был бы способ двигать любые файлы.
  if (!file || !path.isAbsolute(file) || rel.startsWith("..") || path.isAbsolute(rel)) {
    return res.status(400).json({ error: "file_outside_rule_folder" });
  }
  res.json(await rules.processFile(rule, file));
});

export = router;
