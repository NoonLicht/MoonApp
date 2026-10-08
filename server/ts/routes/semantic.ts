/**
 * API семантического поиска (EmbeddingGemma через llama.cpp).
 *
 *  GET  /api/semantic/status                         — модель, сколько проиндексировано, ход индексации
 *  POST /api/semantic/sync                           — запустить (до)индексацию заметок и закладок
 *  GET  /api/semantic/search?q=&sources=note,bookmark&limit=
 *  GET  /api/semantic/related?source=&ref=&limit=    — похожие на заметку/закладку
 *  GET  /api/semantic/links?q=&exclude=              — подсказка заметок для [[ссылки]] по тексту
 *  GET  /api/semantic/suggest?ref=                   — теги и папка для заметки по соседям
 *  GET  /api/semantic/duplicates?source=&threshold=  — почти одинаковые заметки/закладки
 *  GET  /api/semantic/clusters?source=               — группы по темам
 */
import express from "express";
import * as semantic from "../semantic";
import * as vault from "../myspace-vault";

const router = express.Router();

const parseSources = (v: unknown): semantic.SemSource[] | undefined => {
  const list = String(v || "")
    .split(",")
    .filter((s): s is semantic.SemSource => semantic.ALL_SOURCES.includes(s as semantic.SemSource));
  return list.length ? list : undefined;
};
const oneSource = (v: unknown): semantic.SemSource =>
  semantic.ALL_SOURCES.includes(String(v) as semantic.SemSource)
    ? (String(v) as semantic.SemSource)
    : "note";
const num = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const fail = (res: express.Response, e: unknown): void => {
  const msg = String((e as Error).message || e);
  res
    .status(msg.startsWith("embed_model_missing") || msg === "build_missing" ? 409 : 500)
    .json({ error: msg.slice(0, 300) });
};

router.get("/status", (_req, res) => res.json(semantic.status()));

router.post("/sync", (_req, res) => {
  try {
    res.json(semantic.syncAll());
  } catch (e) {
    fail(res, e);
  }
});

router.get("/search", async (req, res) => {
  try {
    const hits = await semantic.search(String(req.query.q || ""), {
      sources: parseSources(req.query.sources),
      limit: num(req.query.limit, 12, 1, 50),
    });
    res.json(hits);
  } catch (e) {
    fail(res, e);
  }
});

router.get("/related", (req, res) => {
  const source = oneSource(req.query.source);
  res.json(
    semantic.related(source, String(req.query.ref || ""), {
      sources: parseSources(req.query.sources),
      limit: num(req.query.limit, 6, 1, 30),
    }),
  );
});

router.get("/links", async (req, res) => {
  try {
    const exclude = String(req.query.exclude || "");
    const hits = await semantic.search(String(req.query.q || ""), { sources: ["note"], limit: 8 });
    res.json(hits.filter((h) => h.ref !== exclude).slice(0, 5));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/suggest", (req, res) => {
  const ref = String(req.query.ref || "");
  const own = vault.readFile(ref);
  const near = semantic.related("note", ref, { sources: ["note"], limit: 8 });
  const have = new Set((own?.tags ?? []).map((t) => t.toLowerCase()));
  const tags = new Map<string, number>();
  const folders = new Map<string, number>();
  for (const h of near) {
    const f = vault.readFile(h.ref);
    if (!f) continue;
    for (const t of f.tags) {
      if (!have.has(t.toLowerCase())) tags.set(t, (tags.get(t) ?? 0) + h.score);
    }
    const dir = h.ref.includes("/") ? h.ref.slice(0, h.ref.lastIndexOf("/")) : "";
    folders.set(dir, (folders.get(dir) ?? 0) + h.score);
  }
  const top = <T>(m: Map<T, number>, n: number): T[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map((e) => e[0]);
  res.json({ tags: top(tags, 5), folder: top(folders, 1)[0] ?? "", near: near.slice(0, 3) });
});

router.get("/duplicates", (req, res) => {
  const source = oneSource(req.query.source);
  res.json(semantic.duplicates(source, num(req.query.threshold, 0.93, 0.7, 0.999)));
});

router.get("/clusters", (req, res) => {
  const source = oneSource(req.query.source);
  res.json(semantic.clusters(source, num(req.query.threshold, 0.8, 0.5, 0.97)));
});

/** Закладки по смыслу: «что я уже сохранял по теме» при добавлении новой. */
router.get("/bookmarks/similar", async (req, res) => {
  try {
    const q = [req.query.title, req.query.url].filter(Boolean).join(" ");
    const hits = await semantic.search(q, { sources: ["bookmark"], limit: 6 });
    const known = new Set(semantic.readBookmarks().map((b) => b.id));
    res.json(hits.filter((h) => known.has(h.ref)));
  } catch (e) {
    fail(res, e);
  }
});

/** Группы по смыслу для произвольных текстов (автораскладка стикеров, quickNotes). */
router.post("/group", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const texts = Array.isArray(req.body?.texts) ? req.body.texts.map(String).slice(0, 400) : [];
    res.json(await semantic.groupTexts(texts, num(req.body?.threshold, 0.7, 0.5, 0.95)));
  } catch (e) {
    fail(res, e);
  }
});

/** Категория траты по комментарию. */
router.get("/classify", async (req, res) => {
  try {
    res.json(await semantic.classifyExpense(String(req.query.q || "")));
  } catch (e) {
    fail(res, e);
  }
});

/** Заметки, подходящие к доске/стикеру/лекции (для прикрепления и сопоставления). */
router.get("/notes-for", async (req, res) => {
  try {
    res.json(
      await semantic.search(String(req.query.q || ""), {
        sources: ["note"],
        limit: num(req.query.limit, 5, 1, 20),
      }),
    );
  } catch (e) {
    fail(res, e);
  }
});

/** Оценка близости запроса к списку текстов (для поиска по настройкам). */
router.post("/rank", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const texts = Array.isArray(req.body?.texts) ? req.body.texts.map(String).slice(0, 600) : [];
    res.json(await semantic.rankTexts(String(req.body?.query || ""), texts));
  } catch (e) {
    fail(res, e);
  }
});

/** Проект и теги для новой задачи по похожим. */
router.get("/task-meta", async (req, res) => {
  try {
    res.json(await semantic.suggestTaskMeta(String(req.query.q || "")));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/movies/recommend", (_req, res) => res.json(semantic.recommendMovies()));

/** Сходство списка книг с избранным. */
router.post("/books/similar", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const books = Array.isArray(req.body?.books) ? req.body.books.slice(0, 200) : [];
    res.json(await semantic.booksSimilarity(books));
  } catch (e) {
    fail(res, e);
  }
});

export default router;
