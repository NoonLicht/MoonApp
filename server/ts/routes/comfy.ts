/**
 * /api/comfy — ComfyUI во вкладке «Фото и видео».
 *
 *  GET  /status                         — состояние установки и процесса
 *  POST /install {flavor}               — скачать и распаковать портативную сборку (≈1.5–2 ГБ)
 *  POST /install/cancel                 — отменить установку
 *  POST /gguf-node                      — поставить узлы ComfyUI-GGUF (GGUF-модели и энкодеры)
 *  DELETE /install                      — удалить сборку (модели и результаты остаются)
 *  POST /start {cpu?} · POST /stop      — запуск и остановка собственного процесса
 *  GET  /models · POST /models/download · POST /models/cancel · DELETE /models?folder=&file=
 *  GET  /hf?url=                        — файлы репозитория Hugging Face
 *  GET/PUT/DELETE /workflows[/:id]      — свои воркфлоу (любой JSON ComfyUI: граф или API-формат)
 *  POST /assist {request, current?}     — локальная модель собирает воркфлоу
 *  ALL  /ui/*                           — прокси к ComfyUI (редактор и API)
 */
import express from "express";
import fs from "fs";
import path from "path";
import {
  comfyRoot,
  comfySetup,
  comfyStatus,
  freeLlamaGpu,
  installComfy,
  installGgufNode,
  isFlavor,
  isInstalled,
  removeComfy,
  startComfy,
  stopComfy,
} from "../comfy/engine";
import {
  cancelDownload,
  downloadState,
  listModels,
  parseHfUrl,
  RECOMMENDED,
  removeModel,
  repoModelFiles,
  startDownload,
  type DlJob,
} from "../comfy/models";
import { assistWorkflow, type ApiGraph } from "../comfy/assist";
import { uiProxy } from "../comfy/proxy";

const router = express.Router();
const fail = (res: express.Response, e: unknown, code = 400): void => {
  res.status(code).json({ error: String((e as Error).message || e).slice(0, 300) });
};

router.get("/status", (_req, res) => res.json(comfyStatus()));

router.post("/install", (req, res) => {
  const flavor = String(req.body?.flavor ?? "nvidia");
  if (!isFlavor(flavor)) return void res.status(400).json({ error: "bad_flavor" });
  const r = installComfy(flavor);
  if (!r.ok) return void res.status(r.error === "busy" || r.error === "running" ? 409 : 400).json({ error: r.error });
  res.json(comfySetup.snapshot());
});
router.post("/install/cancel", (_req, res) => res.json(comfySetup.cancel()));
router.post("/gguf-node", (_req, res) => {
  const r = installGgufNode();
  if (!r.ok) return void res.status(r.error === "busy" || r.error === "running" ? 409 : 400).json({ error: r.error });
  res.json(comfySetup.snapshot());
});
router.delete("/install", (_req, res) => {
  removeComfy();
  res.json({ ok: true });
});

router.post("/start", async (req, res) => {
  const r = await startComfy({ cpu: !!req.body?.cpu });
  if (!r.ok) return void res.status(400).json({ error: r.error });
  res.json(comfyStatus());
});
router.post("/stop", (_req, res) => {
  stopComfy();
  res.json({ ok: true });
});

// ───────────── модели ─────────────

router.get("/models", (_req, res) =>
  res.json({ models: listModels(), recommended: RECOMMENDED, download: downloadState() }),
);

router.get("/hf", async (req, res) => {
  const p = parseHfUrl(String(req.query.url ?? ""));
  if (!p) return void res.status(400).json({ error: "bad_hf_url" });
  try {
    res.json({ repo: p.repo, rev: p.rev, file: p.file ?? null, files: await repoModelFiles(p.repo, p.rev) });
  } catch (e) {
    fail(res, e, 502);
  }
});

router.post("/models/download", (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  let jobs: DlJob[];
  if (typeof b.recommended === "string") {
    const rec = RECOMMENDED.find((x) => x.id === b.recommended);
    if (!rec) return void res.status(400).json({ error: "unknown_model" });
    jobs = [{ repo: rec.repo, rev: "main", file: rec.file, folder: rec.folder, as: rec.as }];
  } else if (typeof b.repo === "string" && Array.isArray(b.files)) {
    jobs = (b.files as unknown[]).map((f) => ({
      repo: b.repo as string,
      rev: typeof b.rev === "string" ? b.rev : "main",
      file: String(f),
      folder: String(b.folder) as DlJob["folder"],
    }));
  } else return void res.status(400).json({ error: "bad_request" });
  const r = startDownload(jobs);
  if (!r.ok) return void res.status(r.error === "busy" ? 409 : 400).json({ error: r.error });
  res.json(downloadState());
});
router.post("/models/cancel", (_req, res) => {
  cancelDownload();
  res.json({ ok: true });
});
router.delete("/models", (req, res) => {
  if (!removeModel(String(req.query.folder ?? ""), String(req.query.file ?? "")))
    return void res.status(400).json({ error: "bad_file" });
  res.json({ ok: true });
});

// ───────────── свои воркфлоу ─────────────

const wfDir = (): string => path.join(comfyRoot(), "workflows");
const wfId = (v: string): string | null => (/^[\w.\- ]{1,80}$/.test(v) && !v.startsWith(".") ? v : null);

router.get("/workflows", (_req, res) => {
  try {
    const out = fs
      .readdirSync(wfDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ id: f.slice(0, -5), at: fs.statSync(path.join(wfDir(), f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    res.json({ workflows: out });
  } catch {
    res.json({ workflows: [] });
  }
});
router.get("/workflows/:id", (req, res) => {
  const id = wfId(req.params.id);
  if (!id) return void res.status(400).json({ error: "bad_id" });
  try {
    res.type("application/json").send(fs.readFileSync(path.join(wfDir(), `${id}.json`), "utf8"));
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});
router.put("/workflows/:id", (req, res) => {
  const id = wfId(req.params.id);
  if (!id) return void res.status(400).json({ error: "bad_id" });
  if (!req.body || typeof req.body !== "object") return void res.status(400).json({ error: "bad_workflow" });
  fs.mkdirSync(wfDir(), { recursive: true });
  fs.writeFileSync(path.join(wfDir(), `${id}.json`), JSON.stringify(req.body), "utf8");
  res.json({ ok: true });
});
router.delete("/workflows/:id", (req, res) => {
  const id = wfId(req.params.id);
  if (!id) return void res.status(400).json({ error: "bad_id" });
  fs.rmSync(path.join(wfDir(), `${id}.json`), { force: true });
  res.json({ ok: true });
});

// ───────────── помощник ─────────────

router.post("/assist", async (req, res) => {
  const b = (req.body ?? {}) as { request?: string; current?: ApiGraph; model?: string };
  const request = String(b.request ?? "").trim();
  if (!request) return void res.status(400).json({ error: "request_required" });
  if (!isInstalled()) return void res.status(400).json({ error: "not_installed" });
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    res.json(await assistWorkflow({ request, current: b.current, model: b.model, signal: ac.signal }));
  } catch (e) {
    if (!ac.signal.aborted) fail(res, e, 502);
  }
});

/** Перед запуском графа: выгрузить чат-модели, чтобы ComfyUI получил видеопамять. */
router.post("/prepare", async (_req, res) => {
  await freeLlamaGpu();
  res.json({ ok: true });
});

router.use("/ui", uiProxy);

export default router;
