const express = require("express");
const settings = require("../settings");
const { setSecret, hasSecret, listSecrets, allowedSecretNames } = require("../security");
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

/* ==================== Экспорт и импорт настроек ====================
 * Перенос настроек между компьютерами: ОДИН json-файл со всеми секциями
 * settings.json (настройки всех страниц — чат, лекции, видео, музыка, сжатие,
 * обход, Web Archive и т.д.; список секций — DEFAULTS в server/settings.js),
 * плюс локальные настройки интерфейса страниц из localStorage (сервер их не
 * видит, поэтому клиент присылает снимок в теле), плюс по флагу ключи API.
 *
 * Данные (заметки, задачи, история чатов, подписки прокси) файл НЕ содержит —
 * для них есть резервные копии (server/backup.js): это разные вещи.
 */

/** Плоский объект (не массив, не null) — базовая проверка входного JSON. */
function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// POST /api/settings/export { includeSecrets?, ui? } → файл moonapp-settings-*.json
router.post("/export", (req, res) => {
  try {
    const includeSecrets = req.body?.includeSecrets === true;
    const payload = {
      app: "MoonApp",
      kind: "moonapp-settings",
      format: 1,
      appVersion: logBundle.appVersion(),
      exportedAt: new Date().toISOString(),
      // Эффективные значения: дефолты, перекрытые сохранёнными настройками.
      settings: settings.get(),
      // Настройки интерфейса страниц из localStorage клиента (сырые строки).
      ui: isPlainObject(req.body?.ui) ? req.body.ui : {},
    };
    if (includeSecrets) payload.secrets = listSecrets();

    const name = `moonapp-settings-${new Date().toISOString().slice(0, 10)}.json`;
    logger.action("settings.export", {
      sections: Object.keys(payload.settings).length,
      secrets: includeSecrets ? Object.keys(payload.secrets).length : 0,
    });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Имя файла — только ASCII: Content-Disposition с кириллицей Node отклоняет.
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    logger.error("settings.export.error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/settings/import { файл экспорта } → применить настройки (и ключи)
router.post("/import", (req, res) => {
  try {
    const body = req.body || {};
    // Принимаем и наш файл экспорта ({ settings: {...} }), и «сырой» settings.json
    // прямо из storage: обе формы — это одно и то же по смыслу.
    const raw = isPlainObject(body.settings) ? body.settings : body;
    if (!isPlainObject(raw)) return res.status(400).json({ error: "bad_format" });

    const { settings: result, applied, skipped } = settings.importAll(raw);
    const appliedPaths = flattenPatch(applied).map(([p]) => p);

    // Ключи API — только по явному согласию (importSecrets) и только известные
    // имена: иначе файл мог бы дописать в secrets.json произвольную запись.
    const secrets = isPlainObject(body.secrets) ? body.secrets : null;
    const keysSkipped = [];
    let keysApplied = 0;
    if (secrets) {
      if (body.importSecrets === true) {
        const allowed = new Set(allowedSecretNames());
        for (const [name, value] of Object.entries(secrets)) {
          if (!allowed.has(name) || typeof value !== "string" || !value.trim()) { keysSkipped.push(name); continue; }
          setSecret(name, value.trim());
          keysApplied++;
        }
      } else {
        // Ключи в файле есть, но галочка «импортировать ключи» снята.
        keysSkipped.push(...Object.keys(secrets));
      }
    }

    logger.action("settings.import", {
      applied: appliedPaths.length, skipped: skipped.length, keys: keysApplied, from: body.appVersion || null,
    });
    res.json({
      ok: true,
      settings: result,
      applied: appliedPaths.length,
      // Пути, которые не применились: неизвестный ключ или чужой тип значения.
      skipped,
      keysApplied,
      keysSkipped,
      // Локальные настройки страниц применяет клиент: localStorage — его зона.
      ui: isPlainObject(body.ui) ? body.ui : {},
      sourceVersion: typeof body.appVersion === "string" ? body.appVersion : "",
    });
  } catch (e) {
    logger.error("settings.import.error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
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