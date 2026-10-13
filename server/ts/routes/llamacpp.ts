/**
 * API встроенного llama.cpp (общий для переводчика, чата и других страниц).
 *
 *  GET    /api/llamacpp/status              — сборки, модели, загрузки, работающий сервер
 *  POST   /api/llamacpp/build               — {id} установить сборку; DELETE /build/:id — удалить
 *  POST   /api/llamacpp/build/cancel        — отменить установку
 *  POST   /api/llamacpp/model               — {id} из каталога или {url} на .gguf в Hugging Face
 *  POST   /api/llamacpp/model/cancel        — отменить загрузку; DELETE /model/:file — удалить
 *  POST   /api/llamacpp/stop                — выгрузить модель из памяти
 *  POST   /api/llamacpp/ocr?model=&device=  — тело: картинка; ответ: HTML-блоки Chandra OCR 2
 *  POST   /api/llamacpp/ocr/pdf             — тело: PDF; ответ {id, pages}; GET /ocr/pdf/:id/:page — страница PNG
 *  GET    /api/llamacpp/ocr/fetch?url=      — скачать картинку по ссылке (для вставки в заметки)
 */
import express from "express";
import {
  BUILD_IDS,
  LLAMA_TAG,
  badBuilds,
  catalog,
  installBuild,
  installedBuilds,
  isBuildId,
  removeBuild,
  serverInfo,
  setup,
  stopServer,
} from "../llamacpp/engine";
import { ttsProblem } from "../llamacpp/tts";
import {
  activity,
  routerSettings,
  setRouterSettings,
  warm,
  loadNow,
  pickModel,
  type Task,
} from "../llamacpp/router";
import { fetchRemoteImage, ocrImage, ocrModels } from "../llamacpp/ocr";
import { closePdf, openPdf, renderPdfPage } from "../llamacpp/ocrPdf";
import type { Device } from "../llamacpp/engine";
import {
  CATALOG,
  cancelDownload,
  downloadState,
  installed,
  parseHfUrl,
  removeModel,
  startDownload,
  type Remote,
} from "../llamacpp/models";

const router = express.Router();

router.get("/status", (_req, res) => {
  res.json({
    tag: LLAMA_TAG,
    platform: process.platform,
    builds: catalog().map((b) => ({
      id: b.id,
      sizeMb: b.sizeMb,
      installed: installedBuilds().includes(b.id),
    })),
    failedBuilds: badBuilds(),
    install: setup.snapshot(),
    catalog: CATALOG,
    models: installed(),
    download: downloadState(),
    server: serverInfo(),
    activity: activity(),
    router: routerSettings(),
    ttsProblem: ttsProblem(),
    ocrModels: ocrModels(),
  });
});

router.post("/build", (req, res) => {
  const id = String(req.body?.id ?? "");
  if (!isBuildId(id) || !BUILD_IDS.includes(id))
    return res.status(400).json({ error: "bad_build" });
  const r = installBuild(id);
  if (!r.ok) return res.status(r.error === "busy" ? 409 : 400).json({ error: r.error });
  res.json(setup.snapshot());
});

router.post("/build/cancel", (_req, res) => res.json(setup.cancel()));

router.delete("/build/:id", (req, res) => {
  if (!isBuildId(req.params.id)) return res.status(400).json({ error: "bad_build" });
  removeBuild(req.params.id);
  res.json({ ok: true });
});

router.post("/model", (req, res) => {
  const { id, url } = (req.body ?? {}) as { id?: string; url?: string };
  let src: { repo: string; rev: string; file: string; extra?: Remote[] } | null = null;
  if (id) {
    const m = CATALOG.find((c) => c.id === id);
    if (m)
      src = {
        repo: m.repo,
        rev: "main",
        file: m.file,
        extra: m.extra?.map((e) => ({ remote: e.file, as: e.as })),
      };
  } else if (url) {
    src = parseHfUrl(String(url));
  }
  if (!src) return res.status(400).json({ error: "bad_model" });
  res.json(startDownload(src.repo, src.rev, [src.file, ...(src.extra ?? [])]));
});

router.post("/model/cancel", (_req, res) => {
  cancelDownload();
  res.json({ ok: true });
});

router.delete("/model/:file", (req, res) => {
  if (!/\.gguf$/i.test(req.params.file)) return res.status(400).json({ error: "bad_file" });
  if (serverInfo()?.file === req.params.file) stopServer();
  removeModel(req.params.file);
  res.json({ ok: true });
});

router.post("/stop", (req, res) => {
  const file = typeof req.body?.file === "string" ? req.body.file : undefined;
  stopServer(file);
  res.json({ ok: true });
});

// Что сейчас загружено/грузится — для индикатора в «Умном поиске».
router.get("/activity", (_req, res) => res.json(activity()));

router.get("/settings", (_req, res) => res.json(routerSettings()));
router.post("/settings", (req, res) => res.json(setRouterSettings(req.body ?? {})));

// Ручная загрузка модели с выбором устройства (панель «Умный поиск»).
router.post("/load", (req, res) => {
  try {
    res.json(
      loadNow(
        String(req.body?.file ?? ""),
        req.body?.device as string | undefined,
        typeof req.body?.layers === "number" ? req.body.layers : undefined,
      ),
    );
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) });
  }
});

const TASKS: Task[] = ["command", "summary", "translate", "chat", "vision"];
// Прогрев: клиент сообщает, что пользователь зашёл на страницу, которой нужна модель.
router.post("/warm", (req, res) => {
  const task = String(req.body?.task ?? "");
  if (task === "stt") {
    // GigaAM работает через ONNX Runtime, не через llama.cpp — прогреваем его сессию.
    const g = require("../gigaamEngine") as typeof import("../gigaamEngine");
    return res.json({ file: "gigaam", started: g.warmup() });
  }
  if (!TASKS.includes(task as Task)) return res.status(400).json({ error: "bad_task" });
  res.json(warm(task as Task));
});

router.get("/pick", (req, res) => {
  const task = String(req.query.task ?? "chat") as Task;
  res.json({ file: TASKS.includes(task) ? pickModel(task) : null });
});

const DEVICES = ["auto", "cpu", "gpu", "vulkan", "cuda"];

router.post("/ocr", express.raw({ type: "image/*", limit: "40mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length)
    return res.status(400).json({ error: "image_required" });
  const device = String(req.query.device || "auto");
  if (!DEVICES.includes(device)) return res.status(400).json({ error: "bad_device" });
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const out = await ocrImage({
      image: req.body,
      mime: String(req.headers["content-type"] || "image/png").split(";")[0],
      model: req.query.model ? String(req.query.model) : undefined,
      device: device as Device,
      signal: ac.signal,
    });
    res.json(out);
  } catch (e) {
    if (ac.signal.aborted) return;
    const msg = String((e as Error).message || e);
    res
      .status(msg.startsWith("ocr_model_missing") || msg === "build_missing" ? 409 : 500)
      .json({ error: msg.slice(0, 400) });
  }
});

router.post(
  "/ocr/pdf",
  express.raw({ type: "application/pdf", limit: "300mb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      return res.status(400).json({ error: "pdf_required" });
    try {
      res.json(await openPdf(req.body));
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message || e).slice(0, 200) });
    }
  },
);

router.get("/ocr/pdf/:id/:page", async (req, res) => {
  try {
    const png = await renderPdfPage(
      String(req.params.id),
      Number(req.params.page),
      Number(req.query.width) || 1800,
    );
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    const msg = String((e as Error).message || e);
    res.status(msg === "pdf_expired" ? 404 : 400).json({ error: msg.slice(0, 200) });
  }
});

router.delete("/ocr/pdf/:id", (req, res) => {
  closePdf(String(req.params.id));
  res.json({ ok: true });
});

router.get("/ocr/fetch", async (req, res) => {
  try {
    const { data, mime } = await fetchRemoteImage(String(req.query.url || ""));
    res.setHeader("Content-Type", mime);
    res.send(data);
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message || e).slice(0, 200) });
  }
});

export = router;
