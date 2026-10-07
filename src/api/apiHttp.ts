/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { getCurrentPage, logEvent } from "@/lib/telemetry";
import type { TrackerErrorDetails } from "@/api/types";

export const BASE = "";

export function tokenHeaders(): Record<string, string> {
  const t = window.appBridge?.getToken?.();
  return t ? { "x-moonapp-token": t } : {};
}

/** Имя файла из Content-Disposition (учитывает filename* с UTF-8). */
export function filenameFromDisposition(res: Response): string {
  const cd = res.headers.get("content-disposition") || "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* как есть */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1] ? plain[1].trim() : "";
}

/**
 * Заголовок X-App-Page: какой страницей инициирован запрос. По нему бэкенд
 * решает, идти во внешнюю сеть напрямую или через прокси (per-page правила,
 * см. server/middleware/perPageProxy.js + таблицу proxy_page_rules).
 * На уровне Chromium такая фильтрация невозможна — все страницы SPA делят один
 * origin, поэтому разграничение живёт на бэкенде.
 */
export function pageHeaders(): Record<string, string> {
  return { "X-App-Page": getCurrentPage() };
}

export async function req<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const t0 = Date.now();
  const ts = () => Date.now() - t0;
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${url}`, {
      method,
      headers: {
        ...tokenHeaders(),
        ...pageHeaders(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Сетевой сбой (сервер не отвечает) — в общий журнал для диагностики.
    logEvent("error", "api.fail", { method, path: url, ms: ts(), error: (e as Error).message });
    throw e;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code: string | undefined;
    let details: TrackerErrorDetails | null = null;
    try {
      const j = await res.json();
      msg = j.error || msg;
      code = j.code;
      // details — диагностика внешнего источника (форум): статус, размер, сниппет.
      details = (j.details as TrackerErrorDetails | null) || null;
    } catch {
      /* keep default */
    }
    if (url !== "/health")
      logEvent("error", "api.error", {
        method,
        path: url,
        status: res.status,
        ms: ts(),
        error: msg,
        code,
        details,
      });
    const err = new Error(msg) as Error & {
      code?: string;
      status?: number;
      details?: TrackerErrorDetails | null;
    };
    err.code = code;
    err.status = res.status;
    err.details = details;
    throw err;
  }
  if (url !== "/health")
    logEvent("action", "api.ok", { method, path: url, status: res.status, ms: ts() });
  return (res.status === 204 ? null : await res.json()) as T;
}

/**
 * GET-файл как blob (сравнение «до/после» и скачивание результата апскейла).
 *
 * Именно fetch с токеном, а не прямой <img src>/<a href>: все /api-роуты
 * закрыты заголовком x-moonapp-token, который теги передать не могут
 * (см. src/lib/download.ts). Полученный blob отдаём в URL.createObjectURL.
 */
export async function blobGet(url: string): Promise<Blob> {
  const res = await fetch(`${BASE}/api${url}`, {
    headers: { ...tokenHeaders(), ...pageHeaders() },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* keep default */
    }
    logEvent("error", "api.error", {
      method: "GET(blob)",
      path: url,
      status: res.status,
      error: msg,
    });
    throw new Error(msg);
  }
  return res.blob();
}

export function toFormData(file: File, to: string): FormData {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("to", to);
  return fd;
}

/**
 * Multipart-запрос к бэкенду (загрузка файла).
 * Доступ к токену прокидывается так же, как в req(); Content-Type с boundary
 * браузер ставит сам. Ошибки обрабатываются как в req().
 */
export async function multipart<T = unknown>(url: string, formData: FormData): Promise<T> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api${url}`, {
    method: "POST",
    headers: { ...tokenHeaders(), ...pageHeaders() },
    body: formData,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* keep */
    }
    logEvent("error", "api.error", {
      method: "POST(multipart)",
      path: url,
      status: res.status,
      ms: Date.now() - t0,
      error: msg,
    });
    throw new Error(msg);
  }
  logEvent("action", "api.ok", {
    method: "POST(multipart)",
    path: url,
    status: res.status,
    ms: Date.now() - t0,
  });
  return res.json() as T;
}

/** POST multipart с одним "file" + текстовыми полями → Blob (PDF-тулкит). */
export async function pdfBlobPost(
  url: string,
  fields: { file: File; [key: string]: File | string },
): Promise<Blob> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const t = window.appBridge?.getToken?.();
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
    body: fd,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

/**
 * POST бинарного тела (PCM-стрим) с токеном.
 * Бросает при не-2xx: вызывающий код (Lecture Recorder) должен узнать, что
 * поток аудио до сервера потерян, а не молча копить «пустую» запись.
 */
export async function rawPost(path: string, body: ArrayBuffer): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/octet-stream" },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}
