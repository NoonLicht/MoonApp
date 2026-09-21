import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import type { HalfArrayCtor, OrtModule, OrtSession, OrtTensor, ReadySession } from "./types";
import { downloadModel, findModel } from "./manifest";
import { loadOrt, providerOrder } from "./runtime";
import { registerTrtEngine, trtDir, trtOptions, trtProfileSize } from "./trt";
import { activeJobCount } from "./jobs";

const { DIRS } = config;

const sessions = new Map<string, Promise<ReadySession>>();
// Готовые сессии отдельно: их нужно освобождать вручную. Без release() память
// устройства (видеокарты) остаётся занятой до выхода из приложения.
const loaded = new Map<string, ReadySession>();

/** Освободить сессию: release() отдаёт и видеопамять модели. */
function disposeSession(rs: ReadySession): void {
  // release() во время инференса рвёт сессию: тогда пачка, которая уже считается
  // в ONNX, падала бы с чужой ошибкой, а движок помечал бы модель «не умеет
  // пачку». Поэтому при активном run только помечаем сессию — release сделает
  // тот же run в finally (см. runGuarded).
  if ((rs.runs || 0) > 0) {
    rs.dead = true;
    logger.info("upscale.session_release_deferred", {
      session: rs.key,
      runs: rs.runs,
      provider: rs.provider,
    });
    return;
  }
  sessions.delete(rs.key);
  loaded.delete(rs.key);
  try {
    // release() асинхронный, но ждать его незачем: память освобождается в рантайме.
    void Promise.resolve(rs.session.release?.()).catch(() => {});
    logger.info("upscale.session_released", { session: rs.key, provider: rs.provider });
  } catch (e) {
    logger.warn("upscale.session_release_failed", {
      session: rs.key,
      error: String((e as Error).message).slice(0, 160),
    });
  }
}

/**
 * Один инференс под защитой от выгрузки: пока считаем, сессию не освобождают.
 *
 * Все session.run в движке идут через эту обёртку — иначе «Стоп» (он зовёт
 * clearSessions) мог выгрузить модель прямо во время захода ONNX.
 */
export async function runGuarded<T>(rs: ReadySession, fn: () => Promise<T>): Promise<T> {
  rs.runs = (rs.runs || 0) + 1;
  try {
    return await fn();
  } finally {
    rs.runs = Math.max(0, (rs.runs || 1) - 1);
    if (rs.runs === 0 && rs.dead) disposeSession(rs);
  }
}

/**
 * Выгрузить модели из памяти (в т.ч. из видеопамяти). Раньше кэш просто
 * очищался, а сессии оставались жить: модель продолжала занимать GPU, пока
 * процесс не завершится. Если задание сейчас считает — выгрузку откладываем,
 * её выполнит runJob сразу после окончания работы.
 */
export function clearSessions(): void {
  if (activeJobCount() > 0) return;
  for (const rs of [...loaded.values()]) disposeSession(rs);
  // Сессии, которые ещё создаются, освободим, как только они появятся.
  for (const [key, task] of [...sessions.entries()]) {
    void task.then((rs) => disposeSession(rs)).catch(() => sessions.delete(key));
  }
}

/**
 * Конструктор Float16Array (Node 22+). Через `globalThis`, потому что lib
 * TypeScript в проекте может не знать этот тип, а рантайм его знает.
 */
function halfCtor(): HalfArrayCtor | null {
  const c = (globalThis as unknown as { Float16Array?: HalfArrayCtor }).Float16Array;
  return typeof c === "function" ? c : null;
}

/**
 * Тип тензора из метаданных ORT: массив `{name,type}` (onnxruntime-node) или
 * словарь по имени. Пустая строка — «тип неизвестен», тогда считаем float32.
 */
export function tensorType(meta: unknown, name: string): string {
  if (Array.isArray(meta)) {
    const hit = (meta as { name?: string; type?: string }[]).find((m) => m && m.name === name);
    return String(hit?.type || "");
  }
  if (meta && typeof meta === "object") {
    const rec = meta as Record<string, { type?: string } | undefined>;
    return String(rec[name]?.type || "");
  }
  return "";
}

/**
 * Обёртка fp16-графа: ORT требует ровно тот тип тензора, что объявлен в модели.
 * Движок работает во float32, поэтому вход конвертируется в half, а выход —
 * обратно. Так fp16-экспорты (Anime4K и подобные) работают без правок вызывающего
 * кода, а сами вычисления идут в половинной точности на GPU.
 */
function wrapHalfSession(ort: OrtModule, session: OrtSession): OrtSession {
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    inputMetadata: session.inputMetadata,
    outputMetadata: session.outputMetadata,
    release: session.release ? () => session.release!() : undefined,
    async run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>> {
      const Ctor = halfCtor();
      if (!Ctor) throw new Error("float16_unsupported");
      const half: Record<string, OrtTensor> = {};
      for (const [name, t] of Object.entries(feeds)) {
        half[name] = new ort.Tensor("float16", new Ctor(t.data) as unknown as Float32Array, [
          ...t.dims,
        ]);
      }
      const res = await session.run(half);
      const out: Record<string, OrtTensor> = {};
      for (const [name, t] of Object.entries(res)) {
        out[name] = t.data instanceof Float32Array ? t : { ...t, data: new Float32Array(t.data) };
      }
      return out;
    },
  };
}

/** Размер профиля TensorRT для этого запроса (0 — первый провайдер не TensorRT). */
function trtProfileFor(pref: string, modelId: string, tile: number): number {
  const m = findModel(modelId);
  return providerOrder(pref, m)[0] === "tensorrt" ? trtProfileSize(m, tile) : 0;
}

export function getSession(
  modelId: string,
  pref: string,
  threads: number,
  tile = 0,
): Promise<ReadySession> {
  // У TensorRT вход задан жёстким профилем, поэтому сессии с разными тайлами
  // несовместимы («Static dimension mismatch»): профиль — часть ключа кэша.
  const profile = trtProfileFor(pref, modelId, tile);
  const key = `${modelId}|${pref}|${threads}|${profile}`;
  const cached = sessions.get(key);
  if (cached) return cached;

  const task = (async (): Promise<ReadySession> => {
    const ort = loadOrt();
    if (!ort) throw new Error("runtime_missing");
    const m = findModel(modelId);
    if (!m) throw new Error("model_unknown");
    const file = path.join(DIRS.upscaleModels, m.file);
    if (!fs.existsSync(file)) {
      // Модель «тензорная»: ONNX убран после сборки движка (место), но граф нужен
      // ORT для старта сессии — качаем его сами, движок после этого берётся из кэша.
      if (!m.url) throw new Error("model_missing");
      logger.info("upscale.model_refetch", { model: modelId });
      await downloadModel(modelId, { force: true });
      if (!fs.existsSync(file)) throw new Error("model_missing");
    }

    let lastErr: unknown = null;
    for (const provider of providerOrder(pref, m)) {
      try {
        const session = await ort.InferenceSession.create(file, {
          executionProviders: [provider],
          graphOptimizationLevel: "all",
          // ORT иначе пишет в консоль свои INFO/WARNING (в том числе про
          // «nodes were not assigned to the preferred execution providers» —
          // это норма: shape-операции он всегда уводит на CPU). Оставляем
          // только ошибки, чтобы журнал сервера не тонул в чужом выводе.
          logSeverityLevel: 3,
          ...(threads > 0 ? { intraOpNumThreads: threads } : {}),
          // На CPU граф ещё и распараллеливается между независимыми узлами
          // (executionMode: "parallel"), а не только внутри одного узла
          // (intraOpNumThreads): interOpNumThreads — тот же threads, отдельного
          // бюджета потоков под межузловой параллелизм не заводим. На GPU-
          // провайдерах (cuda/tensorrt/dml) не трогаем: там «parallel» может
          // не дать выигрыша или конфликтовать с планировщиком провайдера.
          ...(provider === "cpu" && threads > 0
            ? { executionMode: "parallel" as const, interOpNumThreads: threads }
            : {}),
          // TensorRT собирает движок под GPU и кэширует его на диске: те же
          // опции, что и при сборке кнопкой, иначе кэш не переиспользуется.
          ...(provider === "tensorrt" ? trtOptions(m, tile, trtDir(profile, modelId)) : {}),
        });
        const ready: ReadySession = (() => {
          const inType = tensorType(session.inputMetadata, session.inputNames[0]);
          const outType = tensorType(session.outputMetadata, session.outputNames[0]);
          const fp16 = inType === "float16" || outType === "float16";
          if (fp16) logger.info("upscale.session_fp16", { model: modelId, provider });
          return {
            session: fp16 ? wrapHalfSession(ort, session) : session,
            provider,
            bgr: !!m.bgr,
            scale: m.scale,
            fp16,
            key,
          };
        })();
        loaded.set(key, ready);
        logger.info("upscale.session", { model: modelId, provider });
        // Движок мог появиться именно сейчас (первый прогон): отмечаем в реестре,
        // чтобы панель моделей показала «движок готов».
        if (provider === "tensorrt") registerTrtEngine(modelId, profile, trtDir(profile, modelId));
        return ready;
      } catch (e) {
        // Аппаратный провайдер может быть недоступен на этой машине — идём дальше.
        lastErr = e;
        logger.warn("upscale.session_fallback", {
          model: modelId,
          provider,
          error: String((e as Error).message).slice(0, 160),
        });
      }
    }
    throw new Error(
      `session_create_failed: ${String((lastErr as Error)?.message || lastErr).slice(0, 200)}`,
    );
  })();

  sessions.set(key, task);
  task.catch(() => sessions.delete(key));
  return task;
}

// ================== ТАЙЛИНГ (чистая математика, тестируется) ==================

