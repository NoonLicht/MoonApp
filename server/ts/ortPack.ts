/**
 * GPU-пак: скачивание и установка в storage/ort-gpu/<платформа-архитектура>.
 *
 * Зачем отдельный модуль: пак — это 1,5 ГБ (CUDA) и ещё 1 ГБ (TensorRT), качать его
 * в рамках HTTP-запроса нельзя. Поэтому установка идёт в фоне, прогресс читает UI
 * опросом (как states у моделей), а движок (server/ts/upscale.ts) просто видит уже
 * установленный биндинг.
 *
 * Две ступени:
 *   1) cuda      — биндинг + ONNX Runtime с CUDA + библиотеки CUDA/cuDNN;
 *   2) tensorrt  — провайдер TensorRT + библиотеки TensorRT (включая ресурсы сборщика).
 * Вторую ступень можно не ставить: CUDA-провайдер работает и без неё.
 *
 * Ссылки берутся из индекса `gpu-packs.json` в релизе репозитория MoonApp-Ort-GPU;
 * адрес индекса можно переопределить (MOONAPP_GPU_PACK_INDEX или параметром запроса) —
 * так пак ставится из локального архива/зеркала без пересборки приложения.
 *
 * TS-исходник, как server/ts/upscale.ts: компилируется в server/ortPack.js.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import config from "./config";
import logger from "./logger";
import { downloadToFile } from "./download";

const { DIRS } = config;

/** Индекс паков: версия и две ступени. */
export interface PackIndex {
  version: string;
  /** Версия ONNX Runtime в паке (для подписи в UI). */
  ort: string;
  cuda: string;
  tensorrt?: string;
  /** Что нужно от железа — показываем пользователю до скачивания. */
  requires?: string;
  steps: PackStep[];
}

/** Одна ступень пака: архив и его характеристики. */
export interface PackStep {
  id: string;
  /** Подпись для кнопки: «CUDA (ускорение)», «TensorRT (максимум)». */
  title: string;
  file: string;
  mb: number;
  url: string;
  /** Хеш архива: если задан — проверяем после скачивания. */
  sha256?: string;
}

/** Прогресс установки одной ступени (для опроса из UI). */
export interface PackState {
  step: string;
  state: "idle" | "download" | "unpack" | "done" | "error";
  percent: number;
  gotMb: number;
  totalMb: number;
  error: string;
}

/** Адрес индекса паков по умолчанию: релизный репозиторий проекта. */
const DEFAULT_INDEX =
  "https://raw.githubusercontent.com/NoonLicht/MoonApp-Ort-GPU/main/gpu-packs.json";
/** Потолок архива ступени: защита от «попали не на тот файл». */
const MAX_PACK_MB = 4096;

export function indexUrl(): string {
  return process.env.MOONAPP_GPU_PACK_INDEX || DEFAULT_INDEX;
}

/** Каталог пака — тот же, что читает движок (upscale.ts → packDir). */
export function packDir(): string {
  return path.join(DIRS.storage, "ort-gpu", `${process.platform}-${process.arch}`);
}

/** Куда качаем архивы (внутри storage, чтобы не занимать системный временный каталог). */
function cacheDir(): string {
  return path.join(DIRS.storage, "ort-gpu", ".cache");
}

const states = new Map<string, PackState>();
/** Отмена текущей установки (одна ступень за раз). */
let cancelFlag = false;
/** Признак занятости: второй параллельный установщик не нужен. */
let busy = "";

export function packStates(): Record<string, PackState> {
  return Object.fromEntries(states);
}

/** Текущее состояние: занято ли и чем. */
export function packBusy(): string {
  return busy;
}

/** Отмена установки: загрузчик увидит флаг и уберёт недокачанный архив. */
export function cancelPackInstall(): { ok: boolean } {
  if (!busy) return { ok: false };
  cancelFlag = true;
  return { ok: true };
}

/** sha256 файла потоком: архивы по 1,5 ГБ в память не берём. */
function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(file);
    rs.on("error", reject);
    rs.on("data", (c) => hash.update(c));
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Индекс паков: скачиваем и проверяем. Ошибка формулируется как код
 * (`pack_index_failed`) — UI переводит её в понятный текст.
 *
 * Относительные ссылки в индексе считаются от его адреса: так индекс и архивы
 * можно положить рядом (релиз, зеркало, локальная папка на HTTP).
 */
export async function fetchIndex(url = indexUrl()): Promise<PackIndex> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "MoonApp" },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    // cause сохраняем: в логе видно и нашу формулировку, и исходную причину (DNS, TLS).
    throw new Error(`pack_index_failed: ${String((e as Error).message || e).slice(0, 200)}`, {
      cause: e,
    });
  }
  if (!res.ok) throw new Error(`pack_index_failed: HTTP ${res.status}`);
  let raw: Partial<PackIndex>;
  try {
    raw = (await res.json()) as Partial<PackIndex>;
  } catch {
    throw new Error("pack_index_failed: не JSON");
  }
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!steps.length) throw new Error("pack_index_failed: нет ступеней");
  const base = new URL(url);
  return {
    version: String(raw.version || ""),
    ort: String(raw.ort || ""),
    cuda: String(raw.cuda || ""),
    tensorrt: raw.tensorrt ? String(raw.tensorrt) : "",
    requires: raw.requires ? String(raw.requires) : "",
    steps: steps.map((s) => {
      const id = String(s?.id || "");
      const url2 = String(s?.url || "");
      if (!id || !url2) throw new Error("pack_index_failed: ступень без id/url");
      const file = path.basename(String(s?.file || url2));
      return {
        id,
        title: String(s?.title || id),
        file,
        mb: Number(s?.mb) || 0,
        url: new URL(url2, base).toString(),
        sha256: s?.sha256 ? String(s.sha256).toLowerCase() : "",
      };
    }),
  };
}

/** Что обязано появиться в каталоге пака после распаковки ступени. */
export function requiredFiles(stepId: string): string[] {
  if (stepId === "tensorrt") return ["onnxruntime_providers_tensorrt.dll", "nvinfer_10.dll"];
  return ["onnxruntime_binding.node", "onnxruntime.dll", "onnxruntime_providers_cuda.dll"];
}

/**
 * Локальный источник пака: путь или file:// — тогда скачивание не нужно
 * (свой архив, зеркало в локальной сети, тест без HTTP-сервера).
 */
function localPath(src: string): string {
  try {
    const p = src.startsWith("file://") ? fileURLToPath(src) : src;
    return p && fs.existsSync(p) && fs.statSync(p).isFile() ? p : "";
  } catch {
    return "";
  }
}

/**
 * Признак «файл занят другим процессом»: Windows отвечает EPERM/EBUSY/EACCES или
 * «Отказано в доступе». Такой случай отличается от «битого архива» и требует не
 * повтора, а перезапуска приложения (пак удерживает загруженный рантайм).
 */
function inUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const s = `${e?.code || ""} ${e?.message || String(err)}`;
  return /eprem|ebusy|eacces|access is denied|отказано в доступе|permission denied/i.test(s);
}

/** Список файлов внутри zip: состав проверяем ДО распаковки. */
function listZip(zip: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "tar",
      ["-t", "-f", zip],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, out, errOut) => {
        if (err)
          reject(new Error(`pack_unpack_failed: ${String(errOut || err.message).slice(0, 200)}`));
        else
          resolve(
            String(out)
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
          );
      },
    );
  });
}

/** Распаковка zip системным tar (bsdtar умеет zip и файлы >2 ГБ). */
function untar(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-x", "-f", zip, "-C", dest], { windowsHide: true }, (err, _out, errOut) => {
      if (err)
        reject(new Error(`pack_unpack_failed: ${String(errOut || err.message).slice(0, 200)}`));
      else resolve();
    });
  });
}

/** Размер установленного пака (МБ) — показываем в UI, чтобы было видно, что удаляем. */
export function packSizeMb(): number {
  const dir = packDir();
  if (!fs.existsSync(dir)) return 0;
  let sum = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) sum += fs.statSync(p).size;
  }
  return Math.round(sum / 1048576);
}

/**
 * Установка ступени: скачивание → проверка sha256 → распаковка → проверка состава.
 *
 * Архив после успешной распаковки удаляем: 1,5 ГБ в кэше никому не нужны, а
 * переустановка начинается тем же способом. При обрыве/отмене недокачанный файл
 * удаляет сам загрузчик (`downloadToFile`).
 */
export async function installStep(step: PackStep): Promise<{ ok: boolean; files: string[] }> {
  if (busy) throw new Error("pack_busy");
  busy = step.id;
  cancelFlag = false;
  const totalMb = step.mb || 0;
  const setState = (patch: Partial<PackState>): void => {
    const prev = states.get(step.id) || {};
    states.set(step.id, {
      step: step.id,
      state: "download",
      percent: 0,
      gotMb: 0,
      totalMb,
      error: "",
      ...prev,
      ...patch,
    } as PackState);
  };

  const zip = path.join(cacheDir(), step.file);
  try {
    setState({ state: "download", percent: 0, gotMb: 0, totalMb, error: "" });
    // Источник может быть локальным (свой архив/зеркало в сети без интернета):
    // тогда не качаем, а копируем — путь берётся из url (path или file://).
    const localSource = localPath(step.url);
    const bytes = localSource
      ? ((): number => {
          fs.mkdirSync(cacheDir(), { recursive: true });
          fs.copyFileSync(localSource, zip);
          return fs.statSync(zip).size;
        })()
      : await downloadToFile(step.url, zip, {
          userAgent: "MoonApp",
          timeoutMs: 60 * 60 * 1000,
          maxBytes: MAX_PACK_MB * 1048576,
          interruptedPrefix: "Загрузка прервана: ",
          onProgress: ({ total, received }) =>
            setState({
              state: "download",
              gotMb: Math.round(received / 1048576),
              totalMb: total ? Math.round(total / 1048576) : totalMb,
              percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
            }),
          shouldCancel: () => cancelFlag,
        });

    if (step.sha256) {
      const hash = await sha256Of(zip);
      if (hash !== step.sha256)
        throw new Error(
          `pack_sha_mismatch: ожидался ${step.sha256.slice(0, 12)}…, получен ${hash.slice(0, 12)}…`,
        );
    }

    setState({ state: "unpack", percent: 100, gotMb: Math.round(bytes / 1048576) });
    // Состав сверяем ДО распаковки: в каталоге могут лежать файлы прошлой ступени,
    // и проверка «файл существует» пропустила бы вообще чужой архив.
    const entries = await listZip(zip);
    const names = new Set(entries.map((e) => path.basename(e)));
    const absent = requiredFiles(step.id).filter((f) => !names.has(f));
    if (absent.length) throw new Error(`pack_files_missing: ${absent.join(", ")}`);

    fs.mkdirSync(packDir(), { recursive: true });
    await untar(zip, packDir());

    // И контрольный взгляд на диск: распаковка могла оборваться.
    const missing = requiredFiles(step.id).filter((f) => !fs.existsSync(path.join(packDir(), f)));
    if (missing.length) throw new Error(`pack_files_missing: ${missing.join(", ")}`);

    fs.rmSync(zip, { force: true });
    setState({ state: "done", percent: 100 });
    logger.action("upscale.pack_installed", { step: step.id, mb: Math.round(bytes / 1048576) });
    return { ok: true, files: requiredFiles(step.id) };
  } catch (e) {
    // Занятые файлы — это «перезапустите приложение», а не «битый архив»: такие
    // ошибки Windows отдаёт как EPERM/«доступ запрещён», и повтором они не лечатся.
    const msg = inUse(e)
      ? "pack_in_use: файлы пака заняты запущенным приложением — перезапустите его и повторите"
      : String((e as Error).message || e).slice(0, 300);
    // Неудачную попытку не оставляем в кэше: при локальном источнике архив уже
    // скопирован, а при сетевом его убрал загрузчик — повторный rmSync безвреден.
    try {
      fs.rmSync(zip, { force: true });
    } catch {
      /* файла может не быть */
    }
    setState({ state: "error", error: msg });
    logger.warn("upscale.pack_failed", { step: step.id, error: msg });
    throw new Error(msg, { cause: e });
  } finally {
    busy = "";
    cancelFlag = false;
  }
}

/** Удаление пака: возвращает освобождённые мегабайты. */
export function removePack(): { ok: boolean; mb: number } {
  const mb = packSizeMb();
  try {
    // Постоянный захват — это загруженный пак, о нём и сообщаем отдельно.
    // Удаляем РОВНО пак и кэш архивов: раньше здесь стоял родительский каталог, и
    // вместе с паком пропадали соседи (например раздаточные архивы в ort-gpu/dist).
    fs.rmSync(packDir(), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    fs.rmSync(cacheDir(), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  } catch (e) {
    if (inUse(e)) {
      throw new Error(
        "pack_in_use: файлы пака заняты запущенным приложением — перезапустите его и удалите пак",
        { cause: e },
      );
    }
    throw e;
  }
  states.clear();
  logger.action("upscale.pack_removed", { mb });
  return { ok: true, mb };
}
