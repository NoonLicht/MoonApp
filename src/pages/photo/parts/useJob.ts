import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { PhotoJob } from "@/api/apiPhoto";

/**
 * Задание внешнего инструмента: запуск, опрос раз в 1.2 с, отмена, результат как blob.
 * `start` принимает функцию, которая отправляет запрос и возвращает созданное задание.
 */
export function useJob(): {
  job: PhotoJob | null;
  result: Blob | null;
  error: string;
  busy: boolean;
  start: (send: () => Promise<PhotoJob>) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
} {
  const [job, setJob] = useState<PhotoJob | null>(null);
  const [result, setResult] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const running = job?.state === "running";
  const id = job?.id;

  useEffect(() => {
    if (!running || !id) return;
    const timer = setInterval(async () => {
      try {
        const j = await api.photoJob(id);
        if (!alive.current) return;
        setJob(j);
        if (j.state === "done" && j.out) {
          const blob = await api.photoFile(j.out);
          if (alive.current) setResult(blob);
        } else if (j.state === "error") {
          setError(j.error || "error");
        }
      } catch (e) {
        if (alive.current) setError(String((e as Error).message));
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [running, id]);

  const start = useCallback(async (send: () => Promise<PhotoJob>) => {
    setError("");
    setResult(null);
    try {
      setJob(await send());
    } catch (e) {
      setJob(null);
      setError(String((e as Error).message));
    }
  }, []);

  const cancel = useCallback(async () => {
    if (id) await api.photoJobCancel(id).catch(() => undefined);
    setJob((j) => (j && j.state === "running" ? { ...j, state: "cancelled" } : j));
  }, [id]);

  const reset = useCallback(() => {
    setJob(null);
    setResult(null);
    setError("");
  }, []);

  return { job, result, error, busy: running, start, cancel, reset };
}
