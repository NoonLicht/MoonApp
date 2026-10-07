import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { TrJob, TrOptions, TrStatus } from "@/api/client";

const KEY = "moonapp.translate";

export interface TrSettings {
  src: string;
  tgt: string;
  provider: TrOptions["provider"];
  variant: TrOptions["variant"];
}

function load(uiLang: string): TrSettings {
  const base: TrSettings = { src: "auto", tgt: uiLang, provider: "auto", variant: "auto" };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<TrSettings> | null;
    const merged = { ...base, ...(raw || {}) };
    // TensorRT для переводчика не используется (см. server/ts/translate/engine.ts): это CUDA.
    if ((merged.provider as string) === "tensorrt") merged.provider = "cuda";
    return merged;
  } catch {
    return base;
  }
}

/** Настройки перевода (язык, провайдер, вариант модели) — запоминаются между запусками. */
export function useTrSettings(uiLang: string): [TrSettings, (patch: Partial<TrSettings>) => void] {
  const [s, setS] = useState<TrSettings>(() => load(uiLang));
  const set = useCallback((patch: Partial<TrSettings>) => {
    setS((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* хранилище недоступно — настройки просто не запомнятся */
      }
      return next;
    });
  }, []);
  return [s, set];
}

/** Состояние сервера перевода: рантайм, установленные варианты, загрузка модели. */
export function useTrStatus(): { status: TrStatus | null; error: string; refresh: () => void } {
  const [status, setStatus] = useState<TrStatus | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    api
      .trStatus()
      .then((s) => {
        setStatus(s);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const downloading = status?.download?.status === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const id = window.setInterval(refresh, 1200);
    return () => window.clearInterval(id);
  }, [downloading, refresh]);
  return { status, error, refresh };
}

/** Состояние вкладок живёт вне компонентов: переключение вкладок или страниц его не сбрасывает. */
export const memo: {
  jobs: Record<string, string>;
  text: string;
  file: File | null;
  image: File | null;
} = {
  jobs: {},
  text: "",
  file: null,
  image: null,
};

const TERMINAL = new Set(["done", "error", "cancelled"]);

/** Запуск задания и опрос его состояния до завершения. */
export function useJob(key: string): {
  job: TrJob | null;
  running: boolean;
  start: (fn: () => Promise<TrJob>) => Promise<void>;
  cancel: () => void;
  clear: () => void;
  error: string;
} {
  const [job, setJob] = useState<TrJob | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);
  const stop = (): void => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  // Вернувшись на вкладку (или после перемонтирования страницы), подхватываем задание:
  // перевод идёт на сервере независимо от того, открыта ли вкладка.
  useEffect(() => {
    const id = memo.jobs[key];
    if (!id) return;
    api
      .trJob(id)
      .then((j) => {
        setJob(j);
        if (!TERMINAL.has(j.status)) poll(id);
      })
      .catch(() => {
        delete memo.jobs[key];
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const poll = (id: string): void => {
    stop();
    timer.current = window.setInterval(() => {
      api
        .trJob(id)
        .then((j) => {
          setJob(j);
          if (TERMINAL.has(j.status)) stop();
        })
        .catch((e: Error) => {
          setError(e.message);
          stop();
        });
    }, 250);
  };

  const start = async (fn: () => Promise<TrJob>): Promise<void> => {
    setError("");
    try {
      const j = await fn();
      memo.jobs[key] = j.id;
      setJob(j);
      poll(j.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    job,
    running: !!job && !TERMINAL.has(job.status),
    start,
    cancel: () => {
      if (job) void api.trJobCancel(job.id);
    },
    clear: () => {
      stop();
      if (job) void api.trJobDelete(job.id).catch(() => {});
      delete memo.jobs[key];
      setJob(null);
    },
    error,
  };
}
