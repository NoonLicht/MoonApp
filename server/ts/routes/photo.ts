/**
 * API страницы «Фото и видео».
 *
 *  GET    /api/photo/models             — каталог моделей + состояние загрузки
 *  POST   /api/photo/models/download    — { id } скачать модель
 *  POST   /api/photo/models/cancel      — отменить загрузку
 *  DELETE /api/photo/models/:id         — удалить модель
 *  POST   /api/photo/bg-remove          — multipart { file, mode, color, model } → { name, url }
 *  GET    /api/photo/file/:name         — результат (картинка из storage/photo/out)
 *  GET    /api/photo/tools              — InvSR / Deep-Live-Cam: установлено ли, размеры, состояние установки
 *  POST   /api/photo/tools/install      — { id, device } поставить изолированное окружение
 *  POST   /api/photo/tools/cancel       — отменить установку
 *  DELETE /api/photo/tools/:id          — удалить окружение
 *  POST   /api/photo/invsr              — multipart { file, steps, tile, colorFix } → job
 *  POST   /api/photo/faceswap           — multipart { source, target, device, enhance, manyFaces, mouthMask, quality } → job
 *  GET    /api/photo/jobs               — список заданий
 *  GET    /api/photo/jobs/:id           — состояние задания
 *  POST   /api/photo/jobs/:id/cancel    — остановить
 *  POST   /api/photo/faceswap/live      — { on, device } окно Deep-Live-Cam с камерой
 */
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import logger from "../logger";
import { removePath } from "../fsUtil";
import * as store from "../photo/modelStore";
import * as bg from "../photo/bgRemove";
import * as py from "../photo/pyTool";
import * as jobs from "../photo/jobs";
import * as invsr from "../photo/invsr";
import * as swap from "../photo/faceSwap";

const router = express.Router();
const IN_DIR = path.join(store.PHOTO_DIR, "in");

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(IN_DIR, { recursive: true });
      cb(null, IN_DIR);
    },
    filename: (_req, file, cb) => {
      const ext =
        path
          .extname(String(file.originalname || ""))
          .toLowerCase()
          .replace(/[^.a-z0-9]/g, "") || ".png";
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const fail = (res: express.Response, e: unknown, status = 400): void => {
  const message = String((e as Error)?.message || e);
  res.status(status).json({ error: message });
};

router.get("/models", (_req, res) => {
  res.json({ models: store.list(), task: store.taskSnapshot() });
});

router.post("/models/download", (req, res) => {
  try {
    res.json(store.download(String(req.body?.id || "")));
  } catch (e) {
    fail(res, e, (e as Error).message === "busy" ? 409 : 400);
  }
});

router.post("/models/cancel", (_req, res) => res.json(store.cancel()));

router.delete("/models/:id", (req, res) => {
  try {
    bg.unload();
    store.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/bg-remove", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return fail(res, new Error("no_file"));
  const mode = String(req.body?.mode || "cutout");
  const name = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
  try {
    fs.mkdirSync(bg.OUT_DIR, { recursive: true });
    const r = await bg.removeBackground(file.path, path.join(bg.OUT_DIR, name), {
      model: String(req.body?.model || "birefnet-lite"),
      mode: mode === "mask" || mode === "color" ? mode : "cutout",
      color: String(req.body?.color || ""),
    });
    logger.action("photo.bgremove", { provider: r.provider, sec: r.sec, mode });
    res.json({ name, url: `/api/photo/file/${name}`, provider: r.provider, sec: r.sec });
  } catch (e) {
    const code = (e as Error).message;
    fail(res, e, code === "model_not_installed" || code === "runtime_missing" ? 409 : 500);
  } finally {
    removePath(file.path);
  }
});

const toolId = (v: unknown): py.ToolId => {
  if (v === "invsr" || v === "faceswap") return v;
  throw new Error("unknown_tool");
};

router.get("/tools", async (_req, res) => {
  const out = [];
  for (const id of ["invsr", "faceswap"] as const) {
    const def = py.TOOLS[id];
    const st = await py.check(id);
    out.push({
      id,
      title: def.title,
      license: def.license,
      note: def.note,
      python: def.python,
      sizeMb: { cuda: def.sizeMb("cuda"), cpu: def.sizeMb("cpu") },
      ready: st.ready,
      missing: st.missing,
      installed: py.pyInstalled(id),
    });
  }
  res.json({ tools: out, install: py.snapshot(), liveRunning: swap.liveRunning() });
});

router.get("/tools/install", (_req, res) => res.json(py.snapshot()));

router.post("/tools/install", (req, res) => {
  try {
    res.json(py.install(toolId(req.body?.id), req.body?.device === "cpu" ? "cpu" : "cuda"));
  } catch (e) {
    fail(res, e, (e as Error).message === "busy" ? 409 : 400);
  }
});

router.post("/tools/cancel", (_req, res) => res.json(py.cancel()));

router.delete("/tools/:id", (req, res) => {
  try {
    if (jobs.busy()) throw new Error("busy");
    swap.stopLive();
    py.remove(toolId(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, (e as Error).message === "busy" ? 409 : 400);
  }
});

const uploadMany = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "source", maxCount: 1 },
  { name: "target", maxCount: 1 },
]);

const filesOf = (req: express.Request): Record<string, Express.Multer.File[]> =>
  (req.files as Record<string, Express.Multer.File[]>) || {};

/** Убрать загруженные входы после завершения задания. */
const dropLater = (job: jobs.PhotoJob, files: string[]): void => {
  const t = setInterval(() => {
    if (job.state === "running") return;
    clearInterval(t);
    files.forEach(removePath);
  }, 2000);
  t.unref?.();
};

router.post("/invsr", uploadMany, async (req, res) => {
  const f = filesOf(req).file?.[0];
  if (!f) return fail(res, new Error("no_file"));
  try {
    const st = await invsr.ready();
    if (!st.ready) throw new Error("tool_not_installed");
    const job = invsr.start({
      input: f.path,
      steps: Number(req.body?.steps),
      tile: Number(req.body?.tile),
      colorFix: ["wavelet", "ycbcr"].includes(String(req.body?.colorFix)) ? req.body.colorFix : "",
    });
    dropLater(job, [f.path]);
    res.json(jobs.view(job));
  } catch (e) {
    removePath(f.path);
    const code = (e as Error).message;
    fail(res, e, code === "busy" || code === "tool_not_installed" ? 409 : 500);
  }
});

router.post("/faceswap", uploadMany, async (req, res) => {
  const src = filesOf(req).source?.[0];
  const tgt = filesOf(req).target?.[0];
  if (!src || !tgt) {
    [src, tgt].forEach((x) => x && removePath(x.path));
    return fail(res, new Error("no_file"));
  }
  try {
    const st = await swap.ready();
    if (!st.ready) throw new Error("tool_not_installed");
    const flag = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "on";
    const job = swap.start({
      source: src.path,
      target: tgt.path,
      device: req.body?.device === "cpu" ? "cpu" : "cuda",
      enhance: flag(req.body?.enhance),
      manyFaces: flag(req.body?.manyFaces),
      mouthMask: flag(req.body?.mouthMask),
      quality: Number(req.body?.quality),
    });
    dropLater(job, [src.path, tgt.path]);
    res.json(jobs.view(job));
  } catch (e) {
    removePath(src.path);
    removePath(tgt.path);
    const code = (e as Error).message;
    fail(res, e, code === "busy" || code === "tool_not_installed" ? 409 : 500);
  }
});

router.post("/faceswap/live", async (req, res) => {
  try {
    if (req.body?.on === false) {
      swap.stopLive();
      return void res.json({ running: false });
    }
    const st = await swap.ready();
    if (!st.ready) throw new Error("tool_not_installed");
    swap.startLive(req.body?.device === "cpu" ? "cpu" : "cuda");
    res.json({ running: swap.liveRunning() });
  } catch (e) {
    fail(res, e, (e as Error).message === "tool_not_installed" ? 409 : 500);
  }
});

router.get("/jobs", (_req, res) => res.json({ jobs: jobs.list() }));

router.get("/jobs/:id", (req, res) => {
  const j = jobs.view(jobs.get(req.params.id));
  if (!j) return void res.status(404).json({ error: "not_found" });
  res.json(j);
});

router.post("/jobs/:id/cancel", (req, res) => res.json({ ok: jobs.cancel(req.params.id) }));

router.get("/file/:name", (req, res) => {
  const name = path.basename(String(req.params.name));
  const file = path.join(bg.OUT_DIR, name);
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file))
    return void res.status(404).json({ error: "not_found" });
  if (req.query.download) res.download(file, name);
  else res.sendFile(file);
});

export = router;
