/**
 * API страницы «Таблицы» (электронные таблицы на ядре GridCraft, server/ts/office/sheetCore.ts).
 *
 *  GET    /api/sheet/status               — есть ли ядро и где его искали
 *  GET    /api/sheet/sessions             — открытые книги
 *  POST   /api/sheet/sessions             — { sample? } новая книга
 *  POST   /api/sheet/open                 — multipart { file, password? } открыть xlsx, xls, xlsb, ods, csv, tsv, json…
 *  POST   /api/sheet/upload               — multipart { file } → { path }: файл для команд ядра с параметром path
 *  DELETE /api/sheet/sessions/:id         — закрыть книгу
 *  GET    /api/sheet/:id/state            — листы, выделение, строка формул, форматирование под ячейкой
 *  POST   /api/sheet/:id/grid             — { x, y, w, h } окно сетки: геометрия, ячейки с оформлением, объекты
 *  POST   /api/sheet/:id/run              — { command, params? } любая команда ядра → { result, state }
 *  POST   /api/sheet/:id/call             — { method, params } безопасные запросы данных
 *  GET    /api/sheet/:id/commands         — список команд ядра
 *  GET    /api/sheet/:id/export?format=   — сохранить и скачать (xlsx, csv, tsv, json, html, pdf)
 */
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import logger from "../logger";
import { removePath } from "../fsUtil";
import * as core from "../office/sheetCore";

const router = express.Router();
const IN_DIR = path.join(core.OFFICE_DIR, "sheet-in");
const OUT_DIR = path.join(core.OFFICE_DIR, "sheet-out");

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(IN_DIR, { recursive: true });
      cb(null, IN_DIR);
    },
    filename: (_req, file, cb) => {
      const base = path.basename(String(file.originalname || "book")).replace(/[\\/:*?"<>|]+/g, "_");
      cb(null, `${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

const FORMATS = ["xlsx", "csv", "tsv", "json", "html", "pdf"];

const fail = (res: express.Response, e: unknown): void => {
  const message = String((e as Error)?.message || e);
  const status =
    message === "session_not_found" ? 404 : message === "core_not_installed" ? 409 : 500;
  res.status(status).json({ error: message });
};

router.get("/status", (_req, res) => res.json(core.status()));
router.get("/sessions", (_req, res) => res.json({ sessions: core.list() }));

router.post("/sessions", async (req, res) => {
  try {
    res.json(await core.open({ sample: req.body?.sample ? String(req.body.sample) : undefined }));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/open", upload.single("file"), async (req, res) => {
  const f = req.file;
  if (!f) return void res.status(400).json({ error: "no_file" });
  try {
    const name = String(f.originalname || path.basename(f.path)).replace(/^\d+_/, "");
    const password = req.body?.password ? String(req.body.password) : undefined;
    res.json({ ...(await core.open({ file: f.path, name, password })), name });
  } catch (e) {
    removePath(f.path);
    fail(res, e);
  }
});

router.post("/upload", upload.single("file"), (req, res) => {
  const f = req.file;
  if (!f) return void res.status(400).json({ error: "no_file" });
  res.json({ path: f.path, name: String(f.originalname || path.basename(f.path)) });
});

router.delete("/sessions/:id", (req, res) => res.json({ ok: core.close(req.params.id) }));

/** Простой проброс: метод ядра → результат. */
const forward =
  (method: string, pick: (b: Record<string, unknown>) => unknown) =>
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      res.json(await core.call(req.params.id as string, method, pick(req.body || {})));
    } catch (e) {
      fail(res, e);
    }
  };

router.get("/:id/state", async (req, res) => {
  try {
    res.json(await core.call(req.params.id, "view.state"));
  } catch (e) {
    fail(res, e);
  }
});
router.post(
  "/:id/grid",
  forward("view.grid", (b) => b),
);
router.post(
  "/:id/run",
  forward("view.run", (b) => ({ command: String(b.command || ""), params: b.params ?? {} })),
);

/** Метод ядра напрямую (данные для панелей). Правки идут только через /run. */
const QUERY_METHODS = new Set([
  "document.inspect",
  "sheet.read",
  "cell.get",
  "view.image",
  "view.pos",
  "view.state",
  "engine.commands",
]);
router.post("/:id/call", async (req, res) => {
  try {
    const method = String(req.body?.method || "");
    if (!QUERY_METHODS.has(method))
      return void res.status(400).json({ error: "method_not_allowed" });
    res.json(await core.call(req.params.id, method, req.body?.params ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

let commandsCache: unknown = null;
router.get("/:id/commands", async (req, res) => {
  try {
    commandsCache ??= await core.call(req.params.id, "engine.commands");
    res.json(commandsCache);
  } catch (e) {
    fail(res, e);
  }
});

router.get("/:id/export", async (req, res) => {
  try {
    const format = FORMATS.includes(String(req.query.format)) ? String(req.query.format) : "xlsx";
    const s = core.get(req.params.id);
    if (!s) throw new Error("session_not_found");
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stem =
      String(req.query.name || s.name || "book")
        .replace(/\.[^.]+$/, "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 80) || "book";
    const file = path.join(OUT_DIR, `${Date.now()}_${stem}.${format}`);
    if (format === "pdf")
      await core.call(s.id, "engine.execute", {
        command: "file.exportPdf",
        params: { path: file, sheets: req.query.sheets === "all" ? "all" : "active" },
      });
    else if (format === "csv")
      await core.call(s.id, "engine.execute", { command: "file.exportCsv", params: { path: file } });
    else
      await core.call(s.id, "engine.execute", {
        command: "file.saveAs",
        params: { path: file },
      });
    logger.action("sheet.export", { format });
    res.download(file, `${stem}.${format}`, () => removePath(file));
  } catch (e) {
    fail(res, e);
  }
});

export = router;
