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
  clearBadBuilds,
  clearFailure,
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
  IMAGE_COMPANIONS,
  SECTIONS,
  cancelDownload,
  customModels,
  downloadState,
  installed,
  installedSd,
  parseHfUrl,
  removeModel,
  repoFiles,
  startDownload,
  type DlItem,
  type Section,
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
    sdModels: installedSd(),
    custom: customModels(),
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

// Вернуть сборки, отключённые после сбоя, и забыть прошлые ошибки загрузки.
router.post("/reset-builds", (_req, res) => {
  clearBadBuilds();
  clearFailure();
  res.json({ ok: true });
});

router.delete("/build/:id", (req, res) => {
  if (!isBuildId(req.params.id)) return res.status(400).json({ error: "bad_build" });
  removeBuild(req.params.id);
  res.json({ ok: true });
});

/** Файлы страницы Hugging Face: клиент показывает их списком, пользователь выбирает кванты. */
router.get("/hf", async (req, res) => {
  const p = parseHfUrl(String(req.query.url ?? ""));
  if (!p) return res.status(400).json({ error: "bad_url" });
  try {
    res.json({ repo: p.repo, rev: p.rev, file: p.file ?? "", files: await repoFiles(p.repo, p.rev) });
  } catch (e) {
    res.status(502).json({ error: String((e as Error).message || e).slice(0, 200) });
  }
});

/**
 * Скачать модель. Три формы:
 *  {id}                              — из каталога (вместе с проектором, VAE и энкодером);
 *  {url, section?}                   — ссылка на файл `…/resolve/…/x.gguf`;
 *  {repo, rev?, files:[{file,role}], section} — выбранные файлы со страницы репозитория.
 * Файлы «своей» модели запоминаются вместе с разделом, чтобы лечь в нужную группу списка.
 */
router.post("/model", (req, res) => {
  const b = (req.body ?? {}) as {
    id?: string;
    url?: string;
    section?: string;
    repo?: string;
    rev?: string;
    files?: { file?: string; role?: string }[];
  };
  const section: Section = SECTIONS.includes(b.section as Section) ? (b.section as Section) : "other";
  const image = section === "image";
  let items: DlItem[] = [];
  if (b.id) {
    const m = CATALOG.find((c) => c.id === b.id);
    if (!m) return res.status(400).json({ error: "bad_model" });
    items = [
      { repo: m.repo, remote: m.file, dir: m.dir },
      ...(m.extra ?? []).map((e) => ({
        repo: e.repo ?? m.repo,
        remote: e.file,
        as: e.as,
        dir: e.dir ?? ("llama" as const),
      })),
    ];
  } else {
    let repo = "";
    let rev = "main";
    let picks: { file: string; role: string }[] = [];
    if (b.url) {
      const p = parseHfUrl(String(b.url));
      if (!p?.file) return res.status(400).json({ error: "bad_model" });
      repo = p.repo;
      rev = p.rev;
      picks = [{ file: p.file, role: /mmproj/i.test(p.file) ? "mmproj" : "model" }];
    } else if (b.repo && Array.isArray(b.files) && /^[\w.-]+\/[\w.-]+$/.test(b.repo)) {
      repo = b.repo;
      rev = b.rev || "main";
      picks = b.files
        .filter((f) => typeof f.file === "string" && /\.(gguf|safetensors)$/i.test(f.file))
        .map((f) => ({ file: String(f.file), role: String(f.role || "model") }));
    }
    if (!repo || !picks.length) return res.status(400).json({ error: "bad_model" });
    const base = repo.split("/")[1];
    for (const f of picks) {
      const name = f.file.split("/").pop() as string;
      const role = (["model", "mmproj", "vae", "encoder"].includes(f.role) ? f.role : "model") as
        | "model"
        | "mmproj"
        | "vae"
        | "encoder";
      // Проекторы с общими именами получают имя репозитория, как у каталожных моделей.
      const as =
        role === "mmproj" && /^mmproj-(?:f16|bf16|f32|q8_0)\.gguf$/i.test(name)
          ? `${base}.${name}`
          : undefined;
      items.push({
        repo,
        rev,
        remote: f.file,
        as,
        dir: image && role !== "encoder" ? "sd" : "llama",
        custom: { section, role },
      });
    }
    // Картинке нужны VAE и текстовый энкодер: если их нет среди выбранных — докачиваем стандартные.
    if (image)
      for (const c of IMAGE_COMPANIONS) {
        if (c.dir === "sd" && picks.some((f) => f.role === "vae")) continue;
        items.push({ repo: c.repo, remote: c.file, as: c.as, dir: c.dir });
      }
  }
  res.json(startDownload(items));
});

router.post("/model/cancel", (_req, res) => {
  cancelDownload();
  res.json({ ok: true });
});

router.delete("/model/:file", (req, res) => {
  if (!/\.(gguf|safetensors)$/i.test(req.params.file))
    return res.status(400).json({ error: "bad_file" });
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
    res.json(loadNow(String(req.body?.file ?? ""), req.body?.device as string | undefined));
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
