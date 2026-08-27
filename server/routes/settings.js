const express = require("express");
const settings = require("../settings");
const { setSecret, hasSecret } = require("../security");
const { PROVIDERS } = require("../providers");
const logger = require("../logger");

const router = express.Router();

router.get("/", (req, res) => {
  res.json(settings.get());
});

router.patch("/", (req, res) => {
  const s = settings.set(req.body || {});
  logger.action("settings.update", Object.keys(req.body || {}));
  res.json(s);
});

// Список провайдеров + статус наличия ключа
router.get("/providers", (req, res) => {
  res.json(PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models,
    stub: !!p.stub,
    configured: hasSecret(p.id),
  })));
});

// Сохранить ключ провайдера (клиент шлёт plaintext один раз, дальше он в зашифрованном виде)
router.post("/providers/:id/key", (req, res) => {
  const p = PROVIDERS.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "unknown provider" });
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "missing key" });
  setSecret(p.id, String(key));
  logger.action("provider.key_saved", { id: p.id });
  res.json({ ok: true, configured: true });
});

module.exports = router;