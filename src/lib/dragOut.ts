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

async function resolvePath(s: DragSource): Promise<string> {
  if (s.kind === "note")
    return (await req<{ path: string }>("GET", `/dragout/note?path=${encodeURIComponent(s.path)}`))
      .path;
  if (s.kind === "screenshot")
    return (await req<{ path: string }>("GET", `/dragout/screenshot/${encodeURIComponent(s.id)}`))
      .path;
  const blob = await (
    await fetch(s.url, { headers: { ...tokenHeaders(), ...pageHeaders() } })
  ).blob();
  const r = await fetch(`${BASE}/api/dragout/stash?name=${encodeURIComponent(s.name)}`, {
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
