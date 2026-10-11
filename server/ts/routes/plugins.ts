/**
 * Плагины — наборы навыков и шаблонов (логика — в plugins.ts).
 *
 *  GET    /api/plugins       — установленные плагины
 *  POST   /api/plugins       — { manifest } → установить/обновить
 *  DELETE /api/plugins/:id   — удалить
 */
import express from "express";
import path from "path";
import config from "../config";
import * as plugins from "../plugins";

const router = express.Router();

const pluginsDir = (): string => path.join(config.DIRS.storage, "plugins");

router.get("/", (_req, res) => {
  res.json({
    items: plugins.listPlugins(pluginsDir()).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      skills: p.skills.length,
      templates: p.templates.length,
    })),
  });
});

router.post("/", (req, res) => {
  try {
    const p = plugins.installPlugin(pluginsDir(), req.body?.manifest);
    res.status(201).json({ id: p.id, name: p.name });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.delete("/:id", (req, res) => {
  const ok = plugins.removePlugin(pluginsDir(), req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

export = router;
