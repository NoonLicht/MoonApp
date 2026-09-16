/**
 * Скачивание файла на диск с прогрессом, отменой и потоковой записью.
 *
 * Зачем модуль: diarize.js и whisperEngine.js держали по копии одной и той же
 * функции downloadTo (пакеты по 40 МБ, поэтому писать надо потоком, а не в
 * память). Копии различались только строкой User-Agent и тем, откуда читается
 * флаг отмены, — то есть поведением, которое обязано быть одинаковым: таймаут
 * 30 минут, удаление недокачанного файла при ошибке, докачка без удержания
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
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": opts.userAgent },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`download_http_${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  opts.onProgress?.({ total, received: 0 });

  const ws = fs.createWriteStream(destFile);
  let got = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      if (opts.shouldCancel?.()) throw new Error("cancelled");
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      got += buf.length;
      opts.onProgress?.({ total, received: got });
      if (!ws.write(buf)) await new Promise<void>((r) => ws.once("drain", () => r()));
    }
  } catch (e) {
    try {
      ws.destroy();
      fs.rmSync(destFile, { force: true });
    } catch {
      /* файла может уже не быть */
    }
    throw e;
  }
  await new Promise<void>((resolve, reject) =>
    ws.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  return got;
}
