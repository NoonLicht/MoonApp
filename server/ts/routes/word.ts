/**
 * API страницы «Документы» (текстовый редактор на ядре WordCraft, server/ts/office/wordCore.ts).
 *
 *  GET    /api/word/status                 — есть ли ядро и где его искали
 *  GET    /api/word/sessions               — открытые документы
 *  POST   /api/word/sessions               — { template? } новый документ
 *  POST   /api/word/open                   — multipart { file } открыть файл (docx, doc, odt, rtf, html, md, txt…)
 *  POST   /api/word/upload                 — multipart { file } → { path }: файл для команд ядра с параметром path
 *  DELETE /api/word/sessions/:id           — закрыть документ
 *  GET    /api/word/:id/state              — страницы, каретка, выделение, форматирование под кареткой
 *  POST   /api/word/:id/click              — { page, x, y, extend?, count? } клик по странице (пункты)
 *  POST   /api/word/:id/key                — { key, ctrl?, alt?, shift? }
 *  POST   /api/word/:id/type               — { text }
 *  POST   /api/word/:id/run                — { command, params? } любая команда ядра → { result, state }
 *  GET    /api/word/:id/clip               — буфер обмена ядра { text, html } после Копировать/Вырезать
 *  POST   /api/word/:id/call               — { method, params } безопасные запросы данных (структура документа…)
 *  GET    /api/word/:id/commands           — список команд ядра
 *  GET    /api/word/:id/page/:n            — страница как PNG (?scale=1.5)
 *  GET    /api/word/:id/export?format=     — сохранить и скачать (docx, pdf, odt, rtf, html, md, txt)
 */
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import logger from "../logger";
import { removePath } from "../fsUtil";
import * as core from "../office/wordCore";

const router = express.Router();
const IN_DIR = path.join(core.OFFICE_DIR, "in");
const OUT_DIR = path.join(core.OFFICE_DIR, "out");

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(IN_DIR, { recursive: true });
      cb(null, IN_DIR);
    },
    filename: (_req, file, cb) => {
      const base = path.basename(String(file.originalname || "doc")).replace(/[\\/:*?"<>|]+/g, "_");
      cb(null, `${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const FORMATS = ["docx", "pdf", "odt", "rtf", "html", "md", "txt", "tex"];

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
    res.json(
      await core.open({
        template: String(req.body?.template || "blank"),
        region: req.body?.region ? String(req.body.region) : undefined,
        lang: req.body?.lang ? String(req.body.lang) : undefined,
      }),
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post("/open", upload.single("file"), async (req, res) => {
  const f = req.file;
  if (!f) return void res.status(400).json({ error: "no_file" });
  try {
    const name = String(f.originalname || path.basename(f.path)).replace(/^\d+_/, "");
    res.json({ ...(await core.open({ file: f.path, name })), name });
  } catch (e) {
    removePath(f.path);
    fail(res, e);
  }
});

/** Загрузить файл на сервер и вернуть его путь: команды ядра с параметром `path` (объект, текст из файла, шрифт, список получателей…). */
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
  "/:id/click",
  forward("view.click", (b) => b),
);
router.post(
  "/:id/key",
  forward("view.key", (b) => b),
);
router.post(
  "/:id/type",
  forward("view.type", (b) => ({ text: String(b.text ?? "") })),
);
router.post(
  "/:id/run",
  forward("view.run", (b) => ({ command: String(b.command || ""), params: b.params ?? {} })),
);

router.get(
  "/:id/clip",
  forward("view.clip", () => ({})),
);

/** Метод ядра напрямую (данные для панелей). Только чтение/служебные: правки идут через /run. */
const QUERY_METHODS = new Set([
  "document.inspect",
  "document.text",
  "document.layout",
  "view.clip",
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

router.get("/:id/page/:n", async (req, res) => {
  try {
    const n = Math.max(1, Number(req.params.n) || 1);
    const scale = Math.min(4, Math.max(0.2, Number(req.query.scale) || 1.5));
    const r = (await core.call(req.params.id, "ui.render", { page: n, scale })) as {
      png: string;
      pages: number;
    };
    res.set("Content-Type", "image/png");
    res.set("X-Pages", String(r.pages));
    res.set("Cache-Control", "no-store");
    res.send(Buffer.from(r.png, "base64"));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/:id/export", async (req, res) => {
  try {
    const format = FORMATS.includes(String(req.query.format)) ? String(req.query.format) : "docx";
    const s = core.get(req.params.id);
    if (!s) throw new Error("session_not_found");
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stem =
      String(req.query.name || s.name || "document")
        .replace(/\.[^.]+$/, "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 80) || "document";
    const file = path.join(OUT_DIR, `${Date.now()}_${stem}.${format}`);
    if (format === "pdf")
      await core.call(s.id, "engine.execute", {
        command: "file.exportPdf",
        params: { path: file },
      });
    else
      await core.call(s.id, "engine.execute", { command: "file.saveAs", params: { path: file } });
    logger.action("word.export", { format });
    res.download(file, `${stem}.${format}`, () => removePath(file));
  } catch (e) {
    fail(res, e);
  }
});

export = router;
