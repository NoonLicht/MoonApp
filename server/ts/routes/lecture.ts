/**
 * API Lecture Recorder (GigaAM / Whisper GGUF + VAD).
 *
 *  GET    /api/lecture/engine              — статус распознавания (GigaAM / Whisper GGUF)
 *  GET/POST /api/lecture/engine/whisper    — модели Whisper GGUF (скачать, выбрать, GPU)
 *  GET/POST /api/lecture/engine/gigaam     — GigaAM v3 (скачать, выбрать движок)
 *  GET    /api/lecture/engine/setup        — каталог моделей/сборок + детект GPU + прогресс
 *  POST   /api/lecture/engine/model        — { id, action: select|download|remove }
 *  POST   /api/lecture/engine/build        — { id, action: select|download } (CPU/BLAS/CUDA)
 *  POST   /api/lecture/engine/gpu          — { mode: auto|off, deviceId }
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

import { askLecture, summarizeMissed } from "../lectureAsk";
import * as foresight from "../foresight";
import { buildChapters } from "../lectureChapters";
import { stmts } from "../db";
import express from "express";
import fs from "fs";
import * as lecture from "../lecture";
import * as diarize from "../diarize";
import * as asrGguf from "../asrGguf";
import * as gigaamEngine from "../gigaamEngine";
import logger from "../logger";

const router = express.Router();

// express.raw для PCM-потока: льём кусочками по ~0.5 c (16 КБ), лимит с запасом.
function rawParser(limitMb = 8) {
  return express.raw({ type: () => true, limit: `${limitMb}mb` });
}

router.get("/engine", (req, res) => res.json(lecture.engineStatus()));

/* ------------------------- Whisper GGUF -------------------------
 * GET  /engine/whisper — модели (Base/Small/Medium/Large × кванты), активная, прогресс
 * POST /engine/whisper { action, id?, mode? } — download | cancel | remove | select | gpu
 * Все ответы — один и тот же объект asrGguf.info(), UI просто перезаписывает состояние.
 */
router.get("/engine/whisper", (req, res) => res.json(asrGguf.info()));

router.post("/engine/whisper", (req, res) => {
  try {
    const { action, id, mode } = req.body || {};
    const key = String(id || "");
    if (action === "download") asrGguf.download(key);
    else if (action === "cancel") asrGguf.cancelDownload();
    else if (action === "remove") asrGguf.remove(key);
    else if (action === "select") {
      asrGguf.selectModel(key);
      asrGguf.selectEngine("whisper");
    } else if (action === "gpu") asrGguf.setGpuMode(mode);
    else throw new Error("unknown_action");
    res.json(asrGguf.info());
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GigaAM v3 — движок распознавания речи по умолчанию (ONNX, без сборок и GPU).
 * GET  /engine/gigaam            — статус: скачана ли модель, прогресс, выбранный движок
 * POST /engine/gigaam { action } — download | cancel | remove | use-gigaam | use-whisper
 */
router.get("/engine/gigaam", (req, res) => res.json(gigaamEngine.info()));

router.post("/engine/gigaam", (req, res) => {
  try {
    const action = String(req.body?.action || "");
    if (action === "download") gigaamEngine.download();
    else if (action === "cancel") gigaamEngine.cancelTask();
    else if (action === "remove") gigaamEngine.remove();
    else if (action === "use-gigaam") gigaamEngine.selectEngine("gigaam");
    else if (action === "use-whisper") gigaamEngine.selectEngine("whisper");
    else throw new Error("unknown_action");
    res.json(gigaamEngine.info());
  } catch (e: any) {
    res.status(400).json({ error: e.message });
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
  } catch (e: any) {
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
    res.json(
      lecture.ingest(Number(req.params.id), req.body, req.query.track as string | undefined),
    );
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------- Аудиовход: микрофон, гейн, VAD ------------------------- */

router.get("/audio", (req, res) => res.json(lecture.audioSettings()));

router.post("/audio", (req, res) => {
  try {
    res.json(lecture.setAudioSettings(req.body || {}));
  } catch (e: any) {
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
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Пресеты системного промпта (встроенные + свои) для панели «ИИ-конспект».
router.post("/conspectus/presets", (req, res) => {
  try {
    res.json(lecture.saveConspectusPreset(req.body || {}));
  } catch (e: any) {
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
  } catch (e: any) {
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
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/diarize/remove", (req, res) => {
  try {
    res.json(diarize.removePackage(String(req.body?.id || "")));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/diarize/cancel", (req, res) => res.json(diarize.cancelTask()));

// Настройки: авто-разбор после записи, дорожка, порог, число говорящих.
router.post("/diarize/settings", (req, res) => {
  try {
    res.json(diarize.setDiarizeSettings(req.body || {}));
  } catch (e: any) {
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
  } catch (e: any) {
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
  } catch (e: any) {
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
  } catch (e: any) {
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
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/:id/markers", (req, res) => {
  try {
    res
      .status(201)
      .json(lecture.addMarker(Number(req.params.id), Number(req.body?.atMs) || 0, req.body?.label));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/:id/stop", (req, res) => {
  try {
    res.json(lecture.stopSession(Number(req.params.id)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const ok = lecture.deleteSession(Number(req.params.id));
    foresight.forget(Number(req.params.id));
    res.json({ ok });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Foresight: вопросы встречи с ответами из личной базы знаний и «заметки → полный текст».
const foresightFail = (res: express.Response, e: any): void => {
  const msg = String(e?.message || e);
  res.status(/empty_/.test(msg) ? 400 : /not_found/.test(msg) ? 404 : 500).json({ error: msg });
};

router.get("/:id/foresight", (req, res) => {
  res.json({ cards: foresight.cardsOf(Number(req.params.id)) });
});

router.post("/:id/foresight/scan", (req, res) => {
  try {
    res.json(foresight.scan(Number(req.params.id), req.appPage ?? null));
  } catch (e) {
    foresightFail(res, e);
  }
});

router.post("/:id/foresight/ask", (req, res) => {
  try {
    const card = foresight.ask(
      Number(req.params.id),
      String(req.body?.question ?? ""),
      req.appPage ?? null,
    );
    res.json({ card, cards: foresight.cardsOf(Number(req.params.id)) });
  } catch (e) {
    foresightFail(res, e);
  }
});

router.post("/:id/foresight/expand", async (req, res) => {
  try {
    const markdown = await foresight.expandNotes(
      Number(req.params.id),
      String(req.body?.notes ?? ""),
      req.appPage ?? null,
    );
    res.json({ markdown });
  } catch (e) {
    foresightFail(res, e);
  }
});

router.delete("/:id/foresight/:cardId", (req, res) => {
  res.json({ ok: foresight.dismiss(Number(req.params.id), req.params.cardId) });
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
  } catch (e: any) {
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
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Вопрос по записи: ответ модели со ссылками на таймкоды и сами отрывки-источники.
router.post("/:id/ask", async (req, res) => {
  try {
    res.json(
      await askLecture(Number(req.params.id), String(req.body?.question ?? ""), {
        appPage: req.appPage,
      }),
    );
  } catch (e: any) {
    const msg = String(e?.message || e);
    res
      .status(/empty_question/.test(msg) ? 400 : /not_found/.test(msg) ? 404 : 500)
      .json({ error: msg });
  }
});

// Главы лекции: смысловые части по расшифровке (без модели).
router.get("/:id/chapters", (req, res) => {
  const id = Number(req.params.id);
  if (!stmts.lectureGet.get(id)) return res.status(404).json({ error: "session_not_found" });
  const rows = stmts.chunkFor.all(id) as unknown as {
    start_ms: number;
    end_ms: number;
    text: string;
  }[];
  res.json({ items: buildChapters(rows) });
});

// «Я пропустил»: пересказ интервала лекции (минуты от начала записи).
router.post("/:id/missed", async (req, res) => {
  try {
    const fromMs = Math.max(0, Number(req.body?.fromMin) || 0) * 60_000;
    const toMs = Math.max(0, Number(req.body?.toMin) || 0) * 60_000;
    res.json(await summarizeMissed(Number(req.params.id), fromMs, toMs, { appPage: req.appPage }));
  } catch (e: any) {
    const msg = String(e?.message || e);
    res
      .status(/bad_range/.test(msg) ? 400 : /not_found/.test(msg) ? 404 : 500)
      .json({ error: msg });
  }
});

// Прогресс сборки конспекта: страница опрашивает его, пока идёт POST выше —
// длинная лекция требует десятков запросов к модели, и «просто спиннер» врёт.
router.get("/:id/conspectus", (req, res) => {
  res.json(lecture.conspectusState(Number(req.params.id)));
});

export = router;
