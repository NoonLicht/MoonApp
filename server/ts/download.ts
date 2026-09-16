/**
 * Скачивание файла на диск с прогрессом, отменой и потоковой записью.
 *
 * Зачем модуль: шесть мест качали файлы своей копией одного и того же цикла
 * (diarize.js, whisperEngine.js, convertEngine.js, ytdlp.js, zapret.js,
 * downloads.js). Пакеты бывают по 40 МБ и больше, поэтому писать надо потоком,
 * а не в память. Копии различались только User-Agent, лимитом размера и
 * текстами ошибок, — то есть поведением, которое обязано быть одинаковым:
 * таймаут, удаление недокачанного файла при ошибке, докачка без удержания
 * буфера в памяти.
 *
 * TS-исходник, как monitor.ts/jobStore.ts: собирается в server/download.js
 * командой `npm run compile:server`, require("./download") работает как раньше.
 */
import fs from "fs";
import path from "path";

export interface DownloadProgress {
  /** Всего байт по Content-Length (0, если сервер его не отдал). */
  total: number;
  /** Сколько уже записано на диск. */
  received: number;
}

export interface DownloadOptions {
  /** User-Agent запроса: источники (GitHub/CDN) пускают не всех. */
  userAgent: string;
  /** Таймаут на всё скачивание. По умолчанию 30 минут. */
  timeoutMs?: number;
  /** Прогресс: вызывается на каждом записанном пакете. */
  onProgress?: (p: DownloadProgress) => void;
  /** Отмена: проверяется перед каждым пакетом, true — прерываем и чистим файл. */
  shouldCancel?: () => boolean;
  /**
   * Куда писать файл. По умолчанию — destFile. Если задано, путь вычисляется
   * уже после ответа: имя берётся из адреса ПОСЛЕ редиректов (store качает
   * релизы GitHub, а они уходят на objects.githubusercontent.com).
   */
  resolveDest?: (finalUrl: string) => string;
  /** Дополнительные заголовки (Accept, Referer и т.п.) поверх User-Agent. */
  headers?: Record<string, string>;
  /**
   * Верхняя граница размера файла. Проверяется дважды: по Content-Length до
   * записи (чтобы не качать заведомо неподходящее) и по факту — если сервер
   * Content-Length не отдал. По умолчанию лимита нет.
   */
  maxBytes?: number;
  /**
   * Текст HTTP-ошибки. По умолчанию `download_http_<status>`: этот код
   * распознают панели лекций (LectureDiarizePanel/LectureEnginePanel).
   */
  httpErrorText?: (status: number) => string;
  /** Текст ошибки превышения лимита: байты и сам лимит. */
  tooLargeText?: (bytes: number, maxBytes: number) => string;
  /**
   * Префикс к ошибкам обрыва/записи (например «Загрузка прервана: »). HTTP-,
   * лимитные и отменённые ошибки он не затрагивает.
   */
  interruptedPrefix?: string;
}

/** Ошибка, которую downloadToFile породил сам: prefix её не переписывает. */
interface OwnError extends Error {
  own?: boolean;
}

/** Ошибка «для пользователя»: уже сформулирована вызывающим кодом. */
function own(message: string): OwnError {
  const err: OwnError = new Error(message);
  err.own = true;
  return err;
}

/** Байты в мегабайты для текстов ошибок о размере. */
export function mb(bytes: number): number {
  return Math.round(bytes / 1024 ** 2);
}

/**
 * Скачивает url в destFile, возвращает число записанных байт.
 * Недокачанный файл при обрыве/отмене удаляется — иначе он выглядел бы как
 * готовый и ломал последующие проверки целостности.
 */
export async function downloadToFile(
  url: string,
  destFile: string,
  opts: DownloadOptions,
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  // Infinity, если лимит не задан: сравнения ниже тогда всегда ложны.
  const maxBytes = opts.maxBytes ?? Infinity;
  const httpError = (status: number) =>
    own(opts.httpErrorText ? opts.httpErrorText(status) : `download_http_${status}`);
  const tooLarge = (bytes: number) =>
    own(
      opts.tooLargeText
        ? opts.tooLargeText(bytes, maxBytes)
        : `Скачанный файл больше допустимого размера (${bytes} > ${maxBytes} байт)`,
    );

  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": opts.userAgent, ...opts.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw httpError(res.status);

  // Имя файла может зависеть от адреса после редиректов — берём его уже здесь.
  const target = opts.resolveDest ? opts.resolveDest(res.url || url) : destFile;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const total = Number(res.headers.get("content-length") || 0);
  // Заведомо неподходящее отсекаем до записи: не тратим канал и диск.
  if (total > maxBytes) throw tooLarge(total);
  opts.onProgress?.({ total, received: 0 });

  const ws = fs.createWriteStream(target);
  // Ошибку записи отдаёт await-цепочка (ws.end/catch), но 'error' обязан быть
  // прослушан: иначе Node падает с uncaught exception, минуя наш catch.
  ws.on("error", () => {});
  let got = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      if (opts.shouldCancel?.()) throw own("cancelled");
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      got += buf.length;
      // Content-Length сервер мог не отдать — тогда ловим превышение по факту.
      if (got > maxBytes) throw tooLarge(got);
      opts.onProgress?.({ total, received: got });
      if (!ws.write(buf)) await new Promise<void>((r) => ws.once("drain", () => r()));
    }
  } catch (e) {
    try {
      ws.destroy();
      fs.rmSync(target, { force: true });
    } catch {
      /* файла может уже не быть */
    }
    const err = e as OwnError;
    // Свои ошибки (HTTP, лимит, отмена) уже готовы к показу — не трогаем.
    if (err.own || !opts.interruptedPrefix) throw e;
    throw new Error(opts.interruptedPrefix + err.message, { cause: e });
  }
  await new Promise<void>((resolve, reject) =>
    ws.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  return got;
}
