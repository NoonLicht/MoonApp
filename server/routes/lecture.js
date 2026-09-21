"use strict";

/**
 * API Lecture Recorder (whisper.cpp + VAD).
 *
 *  GET    /api/lecture/engine              — статус whisper.cpp (сборка, модель, GPU)
 *  GET    /api/lecture/engine/setup        — каталог моделей/сборок + детект GPU + прогресс
 *  POST   /api/lecture/engine/model        — { id, action: select|download|remove }
 *  POST   /api/lecture/engine/build        — { id, action: select|download } (CPU/BLAS/CUDA)
 *  POST   /api/lecture/engine/gpu          — { mode: auto|off, deviceId }
 *  POST   /api/lecture/engine/bin          — { path } ручной путь к whisper-cli.exe
 *  POST   /api/lecture/engine/cancel       — отменить текущее скачивание
 *  POST   /api/lecture/engine/verify       — self-test: прогон модели на тестовом WAV
 *  GET    /api/lecture/sessions            — список лекций
 *  POST   /api/lecture/sessions            — создать сессию { title, sampleRate, channels }
 *  GET    /api/lecture/:id                 — статус: чанки, очередь, VAD-статистика
 *  PATCH  /api/lecture/:id                 — заметки лекции { notes }
 *  POST   /api/lecture/:id/ingest          — PCM Int16 (octet-stream) → raw.wav + VAD
 *  PATCH  /api/lecture/chunks/:chunkId     — click-to-edit текста чанка { text }
 *  POST   /api/lecture/:id/markers         — маркер важного { atMs, label } (Ctrl+B/F2)
 *  POST   /api/lecture/:id/stop            — финализация сессии
 *  DELETE /api/lecture/:id                 — удалить сессию и файлы
 *  GET    /api/lecture/:id/export?format=  — md | srt | vtt
 *  GET    /api/lecture/:id/audio           — fail-safe raw WAV
 *  GET    /api/lecture/chunks/:chunkId/audio — WAV чанка
 *  POST   /api/lecture/:id/conspectus      — AI-конспект (чанками, провайдер чата)
 *  GET    /api/lecture/:id/conspectus      — прогресс сборки конспекта
 *  GET    /api/lecture/conspectus/settings — режим запуска (smart/auto/manual) + провайдер
 *  POST   /api/lecture/conspectus/settings — { providerId, model, trigger, autoMinChars, systemPrompt, presetId, maxTokens, … }
 *  POST   /api/lecture/conspectus/presets  — сохранить свой пресет { id?, label, systemPrompt }
 *  DELETE /api/lecture/conspectus/presets/:id — удалить свой пресет
 *  GET    /api/lecture/providers           — провайдеры конспекта: id, ярлык, hasKey
 *  GET    /api/lecture/providers/:id/models — живой список моделей провайдера
 *  GET    /api/lecture/diarize/setup       — пакет диаризации: установлено / задача
 *  POST   /api/lecture/diarize/install     — { id: bin|seg|emb|all } скачать пакет
 *  POST   /api/lecture/diarize/remove      — удалить пакет
 *  POST   /api/lecture/diarize/cancel      — отменить скачивание
 *  POST   /api/lecture/diarize/settings    — { enabled, track, threshold, speakers }
 *  POST   /api/lecture/:id/diarize         — разобрать говорящих в лекции
 *  GET    /api/lecture/:id/diarize         — прогресс разбора говорящих
 */

const express = require("express");
const fs = require("fs");
const lecture = require("../lecture");
const diarize = require("../diarize");
const whisperEngine = require("../whisperEngine");
const logger = require("../logger");

const router = express.Router();

// express.raw для PCM-потока: льём кусочками по ~0.5 c (16 КБ), лимит с запасом.
function rawParser(limitMb = 8) {
  return express.raw({ type: () => true, limit: `${limitMb}mb` });
}

router.get("/engine", (req, res) => res.json(lecture.engineStatus()));

/* ------------------------- Настройка движка -------------------------
 * Модели (tiny … large-v3), сборки (CPU / OpenBLAS / CUDA) и устройство
 * (видеокарта или процессор).
 *
 * ВАЖНО: все роуты отвечают ОДНИМ И ТЕМ ЖЕ объектом setupInfo() — в нём есть
 * каталог моделей и сборок, активная сборка, детект GPU и прогресс текущего
 * скачивания (task). Поэтому UI после любого действия просто перезаписывает
 * состояние, а прогресс опрашивает GET /engine/setup, пока task.state = working.
 */
router.get("/engine/setup", async (req, res) => {
  try {
    // Детект GPU (nvidia-smi) кэширован в whisperEngine; ?gpu=0 — отдать кэш.
    if (req.query.gpu !== "0") await whisperEngine.detectGpu();
    res.json(whisperEngine.setupInfo());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Модель: action = select (по умолчанию) | download | remove
router.post("/engine/model", (req, res) => {
  try {
    const { id, action } = req.body || {};
    const key = String(id || "");
    if (action === "download") whisperEngine.downloadModel(key);
    else if (action === "remove") whisperEngine.removeModel(key);
    else whisperEngine.selectModel(key);
    res.json(whisperEngine.setupInfo());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Сборка движка: action = select (по умолчанию) | download
router.post("/engine/build", (req, res) => {
  try {
    const { id, action } = req.body || {};
    const key = String(id || "");
    if (action === "download") whisperEngine.installBuild(key);
    else whisperEngine.selectBuild(key || "auto");
    res.json(whisperEngine.setupInfo());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Устройство счёта: { mode: "auto" | "off", deviceId } (off = флаг -ng у CUDA)
router.post("/engine/gpu", (req, res) => {
  try {
    res.json(whisperEngine.setGpuMode(req.body?.mode, req.body?.deviceId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Ручной путь к whisper-cli.exe (пустая строка = вернуться к автопоиску сборок)
router.post("/engine/bin", (req, res) => {
  try {
    res.json(whisperEngine.setCustomBin(req.body?.path));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Отмена скачивания: флаг читает поток загрузки в whisperEngine.
router.post("/engine/cancel", (req, res) => {
  try {
    whisperEngine.cancelTask();
    res.json(whisperEngine.setupInfo());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Self-test: прогон активной модели на синтетическом WAV (до 3 минут).
 * Показывает РЕАЛЬНЫЙ итог: поднялся ли CUDA (или посчитал CPU) и что ответил
 * драйвер — наличие ggml-cuda.dll этого не гарантирует.
 */
router.post("/engine/verify", async (req, res) => {
  try {
    await whisperEngine.verify();
    res.json(whisperEngine.setupInfo());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/sessions", (req, res) => res.json(require("../db").stmts.lectureAll.all()));

router.post("/sessions", (req, res) => {
  try {
    const s = lecture.createSession(
      req.body?.title,
      Number(req.body?.sampleRate) || 16000,
      req.body?.channels,
    );
    logger.action("lecture.api.create", { id: s.id });
    res.status(201).json(s);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Приём PCM чанка. Фронт шлёт ~0.5 c 16 кГц моно (≈16 КБ) с Content-Type
// application/octet-stream, поэтому тело читаем сырым (лимит с запасом, но
// маленький: 8 МБ хватает с избытком и ограничивает злоупотребление).
router.post("/:id/ingest", rawParser(), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "empty_pcm" });
    // ?track=sys — дорожка системного звука (эфир лектора), mic — микрофон.
    res.json(lecture.ingest(Number(req.params.id), req.body, req.query.track));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------- Аудиовход: микрофон, гейн, VAD ------------------------- */

router.get("/audio", (req, res) => res.json(lecture.audioSettings()));

router.post("/audio", (req, res) => {
  try {
    res.json(lecture.setAudioSettings(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------- ИИ-конспект: провайдер и режим запуска -------------------------
 * Провайдера конспекта можно выбрать явно (по умолчанию DeepSeek) или оставить
 * «как в чате». Ключ берётся из настроек провайдеров (страница настроек чата),
 * поэтому список отдаёт признак hasKey — панель показывает его бейджем, иначе
 * пользователь узнавал бы об отсутствии ключа только при сборке конспекта.
 */
router.get("/conspectus/settings", (req, res) => res.json(lecture.conspectusSettings()));

router.post("/conspectus/settings", (req, res) => {
  try {
    res.json(lecture.setConspectusSettings(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Пресеты системного промпта (встроенные + свои) для панели «ИИ-конспект».
router.post("/conspectus/presets", (req, res) => {
  try {
    res.json(lecture.saveConspectusPreset(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/conspectus/presets/:id", (req, res) => {
  res.json(lecture.deleteConspectusPreset(req.params.id));
});

// Список провайдеров (id, ярлык, каталог моделей, hasKey).
router.get("/providers", (req, res) => res.json(lecture.conspectusProviders()));

// Живой список моделей провайдера (при отсутствии сети — каталог провайдера).
router.get("/providers/:id/models", async (req, res) => {
  try {
    res.json(await lecture.providerModels(req.params.id, req.appPage));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------- Разделение говорящих (sherpa-onnx) -------------------------
 * Внутри дорожки диаризация различает голоса: на семинаре видно, кто из студентов
 * отвечал. Пакет (бинарь + две модели, ~64 МБ) скачивается по кнопке, прогресс
 * идёт в task — как у движка распознавания.
 */
router.get("/diarize/setup", (req, res) => res.json(diarize.setupInfo()));

// Установка: id пакета (bin|seg|emb) или "all" — поставить недостающие.
router.post("/diarize/install", (req, res) => {
  try {
    const id = String(req.body?.id || "all");
    res.json(id === "all" ? diarize.installAllAsync() : diarize.installPackageAsync(id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/diarize/remove", (req, res) => {
  try {
    res.json(diarize.removePackage(String(req.body?.id || "")));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/diarize/cancel", (req, res) => res.json(diarize.cancelTask()));

// Настройки: авто-разбор после записи, дорожка, порог, число говорящих.
router.post("/diarize/settings", (req, res) => {
  try {
    res.json(diarize.setDiarizeSettings(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * «Проверить пропуски»: повторная расшифровка участков, которые VAD/Whisper
 * потеряли (тишина/шум/ручной порог). Работает по raw.wav остановленной лекции;
 * прогресс читается из GET /:id (поле recheck).
 */
router.post("/:id/recheck", (req, res) => {
  try {
    res.json(lecture.startRecheck(Number(req.params.id), req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id/recheck", (req, res) => res.json(lecture.recheckState(Number(req.params.id))));

/* Разделение говорящих: запуск и прогресс (долгая задача — минуты CPU). */
router.post("/:id/diarize", (req, res) => {
  try {
    const id = Number(req.params.id);
    const st = lecture.getStatus(id);
    if (!st) return res.status(404).json({ error: "session_not_found" });
    // Во время записи аудио ещё пишется: разбор по неполному файлу дал бы
    // «половину говорящих», поэтому просим сначала остановить запись.
    if (st.live) return res.status(400).json({ error: "session_live" });
    res.json(diarize.startDiarize(id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id/diarize", (req, res) => res.json(diarize.diarizeState(Number(req.params.id))));

router.get("/:id", (req, res) => {
  const st = lecture.getStatus(Number(req.params.id));
  if (!st) return res.status(404).json({ error: "not_found" });
  res.json(st);
});

router.patch("/chunks/:chunkId", (req, res) => {
  try {
    res.json(lecture.updateChunkText(Number(req.params.chunkId), req.body?.text));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Заметки лекции (кнопка «Сохранить заметки»). Раньше такого роута не было, и
// фронт сохранял заметки через маркер — текст заметок вообще не сохранялся.
router.patch("/:id", (req, res) => {
  try {
    if (typeof req.body?.notes !== "string")
      return res.status(400).json({ error: "notes_required" });
    res.json(lecture.setNotes(Number(req.params.id), req.body.notes));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/:id/markers", (req, res) => {
  try {
    res
      .status(201)
      .json(lecture.addMarker(Number(req.params.id), Number(req.body?.atMs) || 0, req.body?.label));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/:id/stop", (req, res) => {
  try {
    res.json(lecture.stopSession(Number(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    res.json({ ok: lecture.deleteSession(Number(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id/export", (req, res) => {
  try {
    // Подписи говорящих приходят с клиента (?lecturer=&audience=): пользователь
    // читает экспорт на своём языке, а сервер не знает выбранного языка.
    const labels = {
      mode: req.query.labels === "off" ? "off" : "dual",
      mic: String(req.query.mic || ""),
      sys: String(req.query.sys || ""),
    };
    const out = lecture.exportContent(
      Number(req.params.id),
      String(req.query.format || "md"),
      labels,
    );
    res.setHeader("Content-Type", `${out.mime}; charset=utf-8`);
    // Имя файла с русским названием лекции нельзя класть в заголовок «как есть»:
    // Node отвечает 400 (см. lecture.contentDisposition).
    res.setHeader("Content-Disposition", lecture.contentDisposition(out.name));
    res.send(out.body);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id/audio", (req, res) => {
  // ?track=sys — WAV системного звука (эфир), по умолчанию микрофон.
  const p = lecture.rawAudioPath(Number(req.params.id), String(req.query.track || "mic"));
  if (!p) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(p).pipe(res);
});

router.get("/chunks/:chunkId/audio", (req, res) => {
  const p = lecture.chunkAudioPath(Number(req.params.chunkId));
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(p).pipe(res);
});

router.post("/:id/conspectus", async (req, res) => {
  try {
    // appPage нужен провайдеру чата (per-page proxy), как в /api/chat.
    // replace: true — кнопка «Регенерировать»: заметки перезаписываются заново
    // собранным конспектом, а не дополняются (см. server/lecture.js).
    res.json(
      await lecture.generateConspectus(Number(req.params.id), {
        appPage: req.appPage,
        replace: req.body?.replace === true,
      }),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Прогресс сборки конспекта: страница опрашивает его, пока идёт POST выше —
// длинная лекция требует десятков запросов к модели, и «просто спиннер» врёт.
router.get("/:id/conspectus", (req, res) => {
  res.json(lecture.conspectusState(Number(req.params.id)));
});

module.exports = router;
