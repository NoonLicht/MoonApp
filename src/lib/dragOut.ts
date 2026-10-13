/**
 * Перетаскивание из приложения наружу (Telegram, проводник, редакторы).
 *
 * Системный drag стартует только в момент dragstart, а путь к файлу узнаётся запросом к серверу.
 * Поэтому путь запрашивается заранее — при наведении — и кладётся в кэш; dragstart берёт готовый
 * путь, отменяет HTML5-перенос и передаёт файл Electron (`appBridge.startDrag`). Без Electron или
 * пока путь не готов перенос остаётся обычным, внутри приложения.
 */
import { BASE, pageHeaders, req, tokenHeaders } from "@/api/apiHttp";
import type React from "react";

const cache = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

export type DragSource =
  | { kind: "note"; path: string }
  | { kind: "screenshot"; id: string }
  /** Любой файл по адресу (картинка письма, blob:…): скачивается и кладётся во временную папку. */
  | { kind: "url"; url: string; name: string };

const keyOf = (s: DragSource): string =>
  s.kind === "note" ? `n:${s.path}` : s.kind === "screenshot" ? `s:${s.id}` : `u:${s.url}`;

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

/** Скачать файл по адресу: свои пути — с токеном, внешние — через серверный прокси (без CORS). */
async function fetchBlob(url: string): Promise<Blob> {
  const own = url.startsWith("/") || url.startsWith("blob:") || url.startsWith("data:");
  const target =
    !own && /^https?:/i.test(url)
      ? `${BASE}/api/llamacpp/ocr/fetch?url=${encodeURIComponent(url)}`
      : url;
  const headers = target.startsWith("/") ? { ...tokenHeaders(), ...pageHeaders() } : undefined;
  const res = await fetch(target, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** Имя файла: из адреса (без параметров) либо «image» + расширение по типу содержимого. */
function nameFor(url: string, hint: string, type: string): string {
  let base = hint;
  if (!base && !url.startsWith("data:") && !url.startsWith("blob:")) {
    try {
      base = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "");
    } catch {
      base = "";
    }
  }
  base = base || "image";
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + (EXT[type] ?? "");
}

async function resolvePath(s: DragSource): Promise<string> {
  if (s.kind === "note")
    return (await req<{ path: string }>("GET", `/dragout/note?path=${encodeURIComponent(s.path)}`))
      .path;
  if (s.kind === "screenshot")
    return (await req<{ path: string }>("GET", `/dragout/screenshot/${encodeURIComponent(s.id)}`))
      .path;
  const blob = await fetchBlob(s.url);
  const name = nameFor(s.url, s.name, blob.type);
  const r = await fetch(`${BASE}/api/dragout/stash?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { path: string }).path;
}

/** Заранее узнать путь файла (вызывается при наведении). */
export function prefetchDrag(s: DragSource): void {
  const k = keyOf(s);
  if (cache.has(k) || pending.has(k)) return;
  const p = resolvePath(s)
    .then((path) => void cache.set(k, path))
    .catch(() => undefined)
    .finally(() => pending.delete(k));
  pending.set(k, p);
}

/** Начать системный перенос; false — файл ещё не готов или это не Electron. */
export function startNativeDrag(s: DragSource): boolean {
  const br = window.appBridge;
  const p = cache.get(keyOf(s));
  if (!br?.startDrag || !p) return false;
  br.startDrag(p);
  return true;
}

/** Атрибуты элемента, который можно вытащить из приложения. `when` — условие (например, Alt). */
export function dragOutProps(
  src: DragSource,
  when?: (e: React.DragEvent) => boolean,
): {
  draggable: true;
  onPointerEnter: () => void;
  onDragStart: (e: React.DragEvent) => void;
} {
  return {
    draggable: true,
    onPointerEnter: () => prefetchDrag(src),
    onDragStart: (e) => {
      if (when && !when(e)) return;
      if (!cache.has(keyOf(src))) return;
      e.preventDefault();
      startNativeDrag(src);
    },
  };
}

const bound = new WeakSet<Document>();

/**
 * Любую картинку на странице можно вытащить в другое приложение: делегированные обработчики на
 * документе (в том числе на документе iframe с письмом). Картинки с явным draggable="true" —
 * это внутренний перенос приложения, их не трогаем.
 */
export function bindImageDragOut(doc: Document): void {
  if (bound.has(doc)) return;
  bound.add(doc);
  const srcOf = (t: EventTarget | null): string => {
    if (!(t instanceof HTMLImageElement)) return "";
    if (t.getAttribute("draggable") === "true") return "";
    if (t.complete && t.naturalWidth > 0 && t.naturalWidth < 40) return "";
    const s = t.currentSrc || t.src;
    return /^(https?:|blob:|data:image\/)/i.test(s) ? s : "";
  };
  doc.addEventListener(
    "pointerover",
    (e) => {
      const url = srcOf(e.target);
      if (url) prefetchDrag({ kind: "url", url, name: "" });
    },
    true,
  );
  doc.addEventListener(
    "dragstart",
    (e) => {
      const url = srcOf(e.target);
      if (!url || e.defaultPrevented) return;
      if (!cache.has(keyOf({ kind: "url", url, name: "" }))) return;
      e.preventDefault();
      startNativeDrag({ kind: "url", url, name: "" });
    },
    true,
  );
}
