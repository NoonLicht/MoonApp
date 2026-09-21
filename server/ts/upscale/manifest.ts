import fs from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import config from "../config";
import logger from "../logger";
import { MAX_INTERP_MULT } from "../upscalePipeline";
import type {
  ManifestCache,
  ManifestInfo,
  ManifestModel,
  ManifestSyncResult,
  UpModelInfo,
} from "./types";
import { clip, num, numOpt } from "./util";
import { modelAlign } from "./tiling";
import { dropEngines, trtEngineFor } from "./trt";
import { clearSessions } from "./session";
import { BATCH_MAX } from "./params";
import { modelBatchLimit } from "./inference";

const { DIRS } = config;

let manifestCache: ManifestCache | null = null;

const MANIFEST_REPO = "NoonLicht/MoonApp";
const MANIFEST_BRANCH = "master";
const MANIFEST_PATHS = [
  `https://raw.githubusercontent.com/${MANIFEST_REPO}/${MANIFEST_BRANCH}/server/models.manifest.json`,
  `https://cdn.jsdelivr.net/gh/${MANIFEST_REPO}@${MANIFEST_BRANCH}/server/models.manifest.json`,
];
/** Потолок приёма из сети: каталог — это JSON на десятки килобайт. */
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
/** Сколько ждём ответ GitHub, прежде чем пробовать зеркало. */
const MANIFEST_TIMEOUT_MS = 15000;

/** Скачанный каталог (важнее встроенного) — лежит в storage, не в сборке. */
function userManifestFile(): string {
  return path.join(DIRS.storage, "models", "models.manifest.json");
}
/** Вшитый в сборку каталог — запасной вариант (офлайн/первый запуск). */
function bundledManifestFile(): string {
  // __dirname указывает на server/upscale/ (скомпилированный подмодуль),
  // а каталог models.manifest.json лежит рядом с server/upscale.js — на уровень выше.
  return path.join(__dirname, "..", "models.manifest.json");
}

/** Адреса для «Обновить каталог»: MOONAPP_MANIFEST_URL перекрывает основной. */
export function manifestUrls(): string[] {
  const own = String(process.env.MOONAPP_MANIFEST_URL || "").trim();
  return own ? [own, ...MANIFEST_PATHS] : [...MANIFEST_PATHS];
}

/** Строка не длиннее n (манифест приходит из сети — режем всё лишнее). */
const ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
// Имя файла — без разделителей пути: запись вида "../../secrets.json" увела бы
// загрузку модели из storage/models/upscale.
const FILE_RE = /^[a-zA-Z0-9._-]{1,90}\.onnx$/i;
const SHA_RE = /^[0-9a-f]{64}$/i;
const TAG_RE = /^[a-z0-9_-]{1,20}$/;
/** Провайдеры ONNX Runtime, которые имеет смысл просить у движка. */
const PROVIDER_RE = /^(cpu|cuda|dml|tensorrt|openvino|directml)$/i;

/** «Оптимальные настройки» модели — только известные числовые поля. */
function sanitizeRec(v: unknown): ManifestModel["rec"] {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  const put = (k: string, min: number, max: number): void => {
    const x = numOpt(r[k], min, max);
    if (x !== undefined) out[k] = x;
  };
  put("scale", 1, 8);
  put("tile", 0, 8192);
  put("overlap", 0, 1024);
  put("sharpen", 0, 100);
  put("denoise", 0, 100);
  put("interpMult", 2, MAX_INTERP_MULT);
  put("sceneCut", 0, 100);
  return Object.keys(out).length ? (out as ManifestModel["rec"]) : undefined;
}

/**
 * Проверка каталога перед использованием: манифест — «живой» файл из сети,
 * поэтому каждая запись проверяется и чистится (мусорные записи отбрасываются,
 * а не роняют страницу). Возвращаем то, чем можно безопасно работать.
 */
export function sanitizeManifest(raw: unknown): ManifestModel[] {
  const list = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  const out: ManifestModel[] = [];
  const seen = new Set<string>();
  // Потолок на случай, если по ссылке оказался «не тот» файл.
  for (const item of list.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const id = clip(m.id, 64).trim();
    const file = clip(m.file, 100).trim();
    if (!ID_RE.test(id) || !FILE_RE.test(file) || seen.has(id)) continue;
    seen.add(id);
    const url = clip(m.url, 500).trim();
    const sha256 = clip(m.sha256, 64).trim();
    const tags = Array.isArray(m.tags)
      ? m.tags.filter((x) => TAG_RE.test(String(x))).slice(0, 8)
      : [];
    out.push({
      id,
      file,
      label: clip(m.label, 120).trim() || id,
      kind: m.kind === "interp" ? "interp" : "upscale",
      scale: num(m.scale, 1, 8, 1),
      mult: numOpt(m.mult, 2, MAX_INTERP_MULT),
      arch: clip(m.arch, 40),
      // Пустая строка в манифесте — это «ещё не измеряли», а не «поля нет»:
      // сохраняем как есть, чтобы скачанный каталог не отличался от исходного.
      inputSig: typeof m.inputSig === "string" ? clip(m.inputSig, 60) : undefined,
      sizeMb: num(m.sizeMb, 0, 200000, 0),
      license: clip(m.license, 40),
      bgr: m.bgr === true,
      tile: numOpt(m.tile, 0, 8192),
      overlap: numOpt(m.overlap, 0, 1024),
      // Требование к кратности сторон входа (CUGAN): движок выравнивает тайл.
      align: numOpt(m.align, 2, 64),
      // Рекомендация провайдера: cpu/cuda/dml/… (иначе — общий список настроек).
      provider: PROVIDER_RE.test(String(m.provider ?? ""))
        ? String(m.provider).toLowerCase()
        : undefined,
      // Факт о пачке: 1 — граф ждёт ровно один вход, N>1 — предел. Поле должно
      // переживать sync каталога с GitHub, иначе настройка пачки «вернётся» к
      // моделям, которые её не принимают.
      batch: numOpt(m.batch, 1, BATCH_MAX),
      // Только http(s): file:// и data: в каталоге — это уже не модель с GitHub.
      url: /^https?:\/\//i.test(url) ? url : "",
      sha256: SHA_RE.test(sha256) ? sha256.toLowerCase() : "",
      tags: tags.map(String),
      rec: sanitizeRec(m.rec),
      _measured: typeof m._measured === "string" ? clip(m._measured, 400) : undefined,
      _hint: typeof m._hint === "string" ? clip(m._hint, 400) : undefined,
    });
  }
  return out;
}

export function loadManifest(): ManifestModel[] {
  for (const file of [userManifestFile(), bundledManifestFile()]) {
    if (!fs.existsSync(file)) continue;
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const key = `${file}|${mtime}`;
      if (manifestCache?.key === key) return manifestCache.models;
      const models = sanitizeManifest(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!models.length) {
        // Пустой или испорченный каталог не должен оставить UI без моделей:
        // падаем на следующий источник (вшитый каталог).
        logger.warn("upscale.manifest_empty", { file });
        continue;
      }
      manifestCache = { key, file, mtime, models };
      return models;
    } catch (e) {
      // Битая правка манифеста не должна ломать страницу: пробуем следующий
      // источник, а если и его нет — отдаём последний удачный список.
      logger.warn("upscale.manifest", {
        file,
        error: String((e as Error).message).slice(0, 200),
      });
    }
  }
  if (!manifestCache) manifestCache = { key: "", file: "", mtime: 0, models: [] };
  return manifestCache.models;
}

/** Откуда взят каталог и когда обновлялся — для панели «Модели ONNX». */
export function manifestInfo(): ManifestInfo {
  const models = loadManifest();
  const src = manifestCache?.file || bundledManifestFile();
  let updatedAt = "";
  try {
    if (manifestCache?.mtime) updatedAt = new Date(manifestCache.mtime).toISOString();
  } catch {
    /* нет файла — нет даты */
  }
  return {
    source: src === userManifestFile() ? "remote" : "bundled",
    path: src,
    url: manifestUrls()[0],
    count: models.length,
    updatedAt,
  };
}

/** Скачать текст по адресу: таймаут и потолок размера (каталог, не медиа). */
async function fetchManifestText(url: string, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ac.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    if (Number(res.headers.get("content-length") || 0) > MANIFEST_MAX_BYTES) {
      throw new Error("manifest_too_big");
    }
    const text = await res.text();
    if (text.length > MANIFEST_MAX_BYTES) throw new Error("manifest_too_big");
    return text;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // Причина остаётся в cause: по ней в логе видно, сеть это или HTTP-код.
    if (/abort/i.test(msg)) throw new Error("timeout", { cause: e });
    throw new Error(msg, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

/** Результат «Обновить каталог»: что изменилось по сравнению с прежним списком. */
export async function syncManifest(
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<ManifestSyncResult> {
  const own = String(opts.url || "").trim();
  const urls = own ? [own] : manifestUrls();
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || MANIFEST_TIMEOUT_MS);
  const errors: string[] = [];
  let last: Error = new Error("manifest_fetch");
  for (const url of urls) {
    try {
      const text = await fetchManifestText(url, timeoutMs);
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("manifest_invalid");
      }
      const models = sanitizeManifest(doc);
      if (!models.length) throw new Error("manifest_empty");

      // «До» берём из текущего каталога: панель покажет, что изменилось.
      const before = new Map(loadManifest().map((m) => [m.id, m] as const));
      const dest = userManifestFile();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".tmp";
      const updatedAt = new Date().toISOString();
      // Ключи манифеста (_note, _verified) сохраняем, models — проверенные.
      const out = { ...doc, models, _source: url, _updatedAt: updatedAt };
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, dest);
      manifestCache = null; // каталог перечитается из нового файла

      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];
      const after = new Map(models.map((m) => [m.id, m] as const));
      for (const id of after.keys()) if (!before.has(id)) added.push(id);
      for (const [id, m] of before) {
        const n = after.get(id);
        if (!n) {
          removed.push(id);
          continue;
        }
        if (
          n.url !== m.url ||
          n.sha256 !== m.sha256 ||
          n.scale !== m.scale ||
          n.file !== m.file ||
          JSON.stringify(n.rec || {}) !== JSON.stringify(m.rec || {}) ||
          JSON.stringify(n.tags || []) !== JSON.stringify(m.tags || [])
        ) {
          changed.push(id);
        }
      }
      logger.action("upscale.manifest_synced", {
        url,
        count: models.length,
        added: added.length,
        removed: removed.length,
      });
      return {
        ok: true,
        url,
        source: "remote",
        path: dest,
        count: models.length,
        added,
        removed,
        changed,
        updatedAt,
      };
    } catch (e) {
      // Наши коды (manifest_*/http_*/timeout) отдаём как есть — UI их переводит,
      // а сетевые сбои (fetch failed, ENOTFOUND) сводим к одному переводу.
      let msg = String((e as Error)?.message || e);
      if (!/^(http_\d+|manifest_|timeout)/.test(msg)) msg = "manifest_fetch";
      last = new Error(msg);
      errors.push(`${url}: ${String((e as Error)?.message || e).slice(0, 120)}`);
    }
  }
  logger.warn("upscale.manifest_sync_failed", { errors: errors.join(" | ").slice(0, 400) });
  throw last;
}

export function findModel(id: string): ManifestModel | null {
  return loadManifest().find((m) => m.id === id) || null;
}

/** Каталог для UI: + путь на диске и признак «файл скачан». */
export function listModels(): UpModelInfo[] {
  return loadManifest().map((m) => {
    const p = path.join(DIRS.upscaleModels, m.file);
    const onnxOnDisk = fs.existsSync(p);
    return {
      id: m.id,
      label: m.label,
      kind: modelKind(m),
      scale: m.scale,
      mult: interpMult(m),
      // Предел множителя плавности: у CAIN он 2 (момент времени модель не
      // принимает), у RIFE/IFRNet — до MAX_INTERP_MULT.
      multMax: interpMultMax(m),
      arch: m.arch,
      inputSig: String(m.inputSig || ""),
      // Факт о пачке из каталога: 1 — граф ждёт ровно один кадр (пачка невозможна),
      // 0 — неизвестно, N>1 — предел. UI по нему прячет настройку пачки, а движок
      // для моделей с batch=1 вообще не копит очередь.
      batch: modelBatchLimit(m),
      align: modelAlign(m),
      provider: String(m.provider || ""),
      trtEngine: trtEngineFor(m.id),
      file: m.file,
      sizeMb: m.sizeMb,
      license: m.license,
      url: m.url,
      path: p,
      // «Готова к работе»: файл на диске или собранный движок TensorRT (ONNX
      // после сборки убирается, а граф движок докачает сам при первом запуске).
      available: onnxOnDisk || !!trtEngineFor(m.id),
      onnxOnDisk,
      tags: (m.tags || []).map(String),
      rec: m.rec || {},
      measured: String(m._measured || ""),
      sha256: String(m.sha256 || ""),
      hint: String(m._hint || ""),
      downloading: downloadProgress(m.id),
    };
  });
}

/** Прогресс текущей загрузки (null — модель не качается прямо сейчас). */
function downloadProgress(id: string): UpModelInfo["downloading"] {
  const st = downloads.get(id);
  if (!st || st.state !== "working") return null;
  return {
    gotMb: Math.round((st.got / 1048576) * 10) / 10,
    totalMb: st.total ? Math.round((st.total / 1048576) * 10) / 10 : 0,
    percent: st.total ? Math.min(99, Math.round((st.got / st.total) * 100)) : 0,
  };
}

/** Загрузки моделей: прогресс виден в UI (как у панели движка лекций). */
const downloads = new Map<string, { got: number; total: number; state: string; error: string }>();

/** Состояние загрузок для панели моделей. */
export function downloadStates(): Record<string, { state: string; error: string }> {
  const out: Record<string, { state: string; error: string }> = {};
  for (const [id, st] of downloads) out[id] = { state: st.state, error: st.error };
  return out;
}

/**
 * Удаление скачанной модели: файл уходит с диска, сессия — из кэша (иначе
 * ONNX держал бы дескриптор и файл не удалился на Windows).
 */
export function removeModel(id: string): { ok: boolean; removed: boolean } {
  const m = findModel(id);
  if (!m) throw new Error("model_unknown");
  const p = path.join(DIRS.upscaleModels, m.file);
  clearSessions();
  // Вместе с моделью уходят её движки: иначе они занимали бы место и попадали
  // в реестр как «движок есть» у удалённой модели.
  dropEngines(id);
  const removed = fs.existsSync(p);
  if (removed) fs.rmSync(p, { force: true });
  // Модель, установленная из архива (Qualcomm), состоит из нескольких файлов:
  // граф + внешние веса. Их список лежит рядом (индекс) — убираем и его.
  const index = p + ".files.json";
  try {
    if (fs.existsSync(index)) {
      const files = JSON.parse(fs.readFileSync(index, "utf8")) as unknown;
      if (Array.isArray(files)) {
        for (const f of files) {
          // Только имена в той же папке: индекс не должен никуда уводить.
          if (typeof f !== "string" || f === m.file || path.basename(f) !== f) continue;
          fs.rmSync(path.join(DIRS.upscaleModels, f), { force: true });
        }
      }
      fs.rmSync(index, { force: true });
    }
  } catch (e) {
    logger.warn("upscale.remove_files", { id, error: String((e as Error).message).slice(0, 160) });
  }
  logger.action("upscale.model_removed", { id, removed });
  return { ok: true, removed };
}

/** Вид модели: старое поле kind не задано — значит апскейлер. */
export function modelKind(m: ManifestModel): "upscale" | "interp" {
  return m.kind === "interp" ? "interp" : "upscale";
}

/** Во сколько раз интерполятор увеличивает число кадров (по умолчанию ×2). */
export function interpMult(m: ManifestModel): number {
  if (modelKind(m) !== "interp") return 1;
  const v = Math.round(Number(m.mult ?? 2));
  return Number.isFinite(v) && v > 1 ? Math.min(MAX_INTERP_MULT, v) : 2;
}

/** Только интерполяторы — для выпадающего списка «Модель плавности» в UI. */
export function interpModels(): UpModelInfo[] {
  return listModels().filter((m) => m.kind === "interp");
}

/**
 * Сколько кадров модель умеет выдать на каждый исходный.
 *
 * Схема с `timestep` (RIFE, IFRNet) считает ЛЮБОЙ момент времени, поэтому ×2/×3/×4
 * работают без каскадов; CAIN интерполирует ровно середину пары и момент не
 * принимает — для неё максимум ×2 (при ×3 движок вернул бы один и тот же средний
 * кадр дважды, то есть испортил бы результат, оставаясь «формально верным»).
 *
 * `rec.interpMult` в манифесте — это рекомендация, а не предел: у всех
 * интерполяторов она равна 2, хотя RIFE/IFRNet умеют больше.
 */
export function interpMultMax(model?: ManifestModel | null): number {
  if (!model) return MAX_INTERP_MULT;
  const sig = String(model.inputSig || "");
  if (sig === "cain-concat" || String(model.arch || "") === "cain") return 2;
  return MAX_INTERP_MULT;
}

/** Только апскейлеры — интерполятор нельзя выбрать как модель апскейла. */
export function upscaleModels(): UpModelInfo[] {
  return listModels().filter((m) => m.kind === "upscale");
}

// ================== ONNXRUNTIME-NODE ==================
// Загружаем динамически: пакет опциональный (нативная библиотека), и его
// отсутствие НЕ должно ронять сервер — просто все задания апскейла вернут
// понятную ошибку «runtime_missing», а UI подскажет поставить зависимости.
export function extractZipEntries(zip: Buffer): { name: string; data: Buffer }[] {
  // Концевая запись каталога (EOCD): ищем в хвосте — комментарий к архиву может
  // занимать до 64 КиБ.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 66000); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip_invalid");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("zip_invalid");
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const rawSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localAt = zip.readUInt32LE(p + 42);
    const full = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (full.endsWith("/")) continue; // директория
    // Имя — только basename: путь из архива не должен уводить запись наружу.
    const name = full.split(/[\\/]/).pop() || "";
    if (!name || name === "." || name === ".." || seen.has(name)) throw new Error("zip_invalid");
    if (compSize === 0xffffffff || localAt === 0xffffffff) throw new Error("zip_invalid");
    if (zip.readUInt32LE(localAt) !== 0x04034b50) throw new Error("zip_invalid");
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const data = zip.subarray(dataAt, dataAt + compSize);
    const raw = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!raw) throw new Error("zip_invalid");
    if (rawSize && raw.length !== rawSize) throw new Error("zip_invalid");
    seen.add(name);
    out.push({ name, data: raw });
  }
  return out;
}

/**
 * Достать ONNX-модель из zip-архива (так раздают модели Qualcomm). Если модель
 * идёт с внешними весами (`*.data`), для работы нужны и они — см. installModel.
 */
export function extractOnnxFromZip(zip: Buffer): Buffer {
  const onnx = extractZipEntries(zip).find((e) => /\.onnx$/i.test(e.name));
  if (!onnx) throw new Error("zip_no_onnx");
  return onnx.data;
}

/**
 * Загрузка модели из UI (POST /models/download): URLs берём из манифеста, файл
 * пишем в storage/models/upscale через .part и переименовываем после успеха.
 * Если ссылка ведёт на .zip (так раздаёт Qualcomm), внутри ищем `.onnx`, а
 * sha256 считаем по самой модели, а не по архиву.
 */
export async function downloadModel(
  id: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; path: string; sizeMb: number }> {
  const m = findModel(id);
  if (!m) throw new Error("model_unknown");
  if (!m.url) throw new Error("model_no_url");
  const dest = path.join(DIRS.upscaleModels, m.file);
  const running = downloads.get(id);
  if (running?.state === "working") throw new Error("download_busy");
  if (fs.existsSync(dest) && !opts.force) {
    return { ok: true, path: dest, sizeMb: Math.round(fs.statSync(dest).size / 1048576) };
  }
  const st = { got: 0, total: 0, state: "working", error: "" };
  downloads.set(id, st);
  try {
    const res = await fetch(m.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = res.body;
    if (!body) throw new Error("no_body");
    st.total = Number(res.headers.get("content-length") || 0);
    const part = dest + ".part";
    const out = fs.createWriteStream(part);
    // Ссылка на архив (Qualcomm) — внутри .onnx: хеш считаем по распакованной
    // модели, поэтому в потоке его не считаем.
    const zipped = /\.zip($|[?#])/i.test(m.url);
    // sha256 из манифеста: без проверки битый или подменённый файл выглядел бы
    // как «модель скачана» и падал бы позже, в середине задания.
    const hash = m.sha256 && !zipped ? crypto.createHash("sha256") : null;
    let got = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        st.got = got;
        if (hash) hash.update(value);
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((r) => out.once("drain", () => r()));
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    if (hash && hash.digest("hex") !== m.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error("sha256_mismatch");
    }
    if (zipped) {
      let entries: { name: string; data: Buffer }[];
      try {
        entries = extractZipEntries(fs.readFileSync(part));
      } catch (e) {
        fs.rmSync(part, { force: true });
        const msg = String((e as Error).message || e);
        throw new Error(msg === "zip_no_onnx" ? "zip_no_onnx" : "zip_invalid", { cause: e });
      }
      fs.rmSync(part, { force: true });
      const onnx = entries.find((e) => /\.onnx$/i.test(e.name));
      if (!onnx) throw new Error("zip_no_onnx");
      // Граф кладём под именем из манифеста, остальные файлы (внешние веса
      // `*.data`, метаданные) — рядом: ONNX Runtime ищет их по той же папке.
      // Прошлый набор файлов убираем: у другой версии модели могут быть свои веса.
      const oldIndex = dest + ".files.json";
      try {
        const old = fs.existsSync(oldIndex)
          ? (JSON.parse(fs.readFileSync(oldIndex, "utf8")) as unknown)
          : [];
        if (Array.isArray(old)) {
          for (const f of old) {
            if (typeof f === "string" && path.basename(f) === f) {
              fs.rmSync(path.join(DIRS.upscaleModels, f), { force: true });
            }
          }
        }
      } catch {
        /* испорченный индекс не мешает установке: он будет перезаписан */
      }
      const written: string[] = [];
      got = 0;
      for (const e of entries) {
        const name = /\.onnx$/i.test(e.name) ? m.file : e.name;
        if (written.includes(name)) continue;
        const target = path.join(DIRS.upscaleModels, name);
        fs.writeFileSync(target + ".tmp", e.data);
        fs.renameSync(target + ".tmp", target);
        written.push(name);
        got += e.data.length;
      }
      // Индекс файлов модели: по нему «Удалить» уберёт и веса, а не только граф.
      fs.writeFileSync(dest + ".files.json", JSON.stringify(written) + "\n", "utf8");
    } else {
      fs.renameSync(part, dest);
    }
    clearSessions(); // новая модель — старая сессия ни к чему
    st.state = "done";
    logger.action("upscale.model_downloaded", { id, sizeMb: +(got / 1048576).toFixed(1) });
    return { ok: true, path: dest, sizeMb: +(got / 1048576).toFixed(1) };
  } catch (e) {
    st.state = "error";
    st.error = String((e as Error).message || e).slice(0, 200);
    throw e;
  }
}

