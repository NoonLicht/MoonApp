/**
 * Типизированный доступ main-процесса к серверным модулям.
 *
 * Серверный код компилируется в server/*.js (см. tsconfig.server.json), поэтому
 * путь "../server/..." верен только в рантайме (electron/main.js → ../server),
 * а из исходников electron/ts/ он не резолвится. Вместо этого описываем ровно
 * ту часть API, которую main-процесс реально вызывает.
 */
import type http from "http";

export interface ServerModules {
  "../server": {
    startServer(port: number, opts?: { token?: string }): http.Server;
  };
  "../server/logger": {
    log?(level: string, event: string, data?: unknown): void;
  };
  "../server/config": {
    DIRS: { tmp: string };
  };
  "../server/screenshots": {
    saveFromTemp(
      tmpPath: string,
      opts: { type: string; ext: string; mime: string; width?: number; height?: number },
    ): unknown;
  };
  "../server/trackerScraper": {
    bindChromiumSession(ses: unknown): void;
  };
  "../server/taskRegistry": {
    killAllActive(): number;
  };
  "../server/audioCaptureLinux": {
    startSystemAudioCapture(): Promise<{ ok: boolean; error?: string }>;
    stopSystemAudioCapture(): Promise<string | null>;
  };
  "../server/monitor": {
    stopLhm(): void;
  };
}

/** Подгружает серверный модуль по рантайм-пути (относительно electron/*.js). */
export function serverModule<K extends keyof ServerModules>(name: K): ServerModules[K] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(name);
}
