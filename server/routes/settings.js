const express = require("express");
const settings = require("../settings");
const { setSecret, hasSecret } = require("../security");
const { PROVIDERS } = require("../providers");
const logger = require("../logger");
const logBundle = require("../logBundle");

const router = express.Router();

// Разворачивает патч настроек в плоские пары [путь, значение]: {store:{pageSize:60}}
// → ["store.pageSize", 60]. Нужно для подробного журнала изменений.
function flattenPatch(patch, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) out.push(...flattenPatch(v, path));
    else out.push([path, v]);
  }
  return out;
}

router.get("/", (req, res) => {
  res.json(settings.get());
});

router.patch("/", (req, res) => {
  const s = settings.set(req.body || {});
  // Логируем КАЖДОЕ изменённое значение с указанием страницы, к которой
  // относится секция: в отчёте «Собрать логи» видно, что и когда поменяли.
  // Секретные значения (masterKey и т.п.) маскируются.
  let logged = 0;
  for (const [path, value] of flattenPatch(req.body || {})) {
    if (logged++ >= 60) break;
    logger.action("settings.change", {
      page: logBundle.pagesForSection(path.split(".")[0])?.title || null,
      section: path.split(".")[0],
      path,
      value: /key|token|secret|password/i.test(path) ? `***(${String(value).length})` : value,
    });
  }
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