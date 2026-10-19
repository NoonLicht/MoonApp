/**
 * Прокси к собственному процессу ComfyUI: `/api/comfy/ui/*` → `127.0.0.1:<порт>/*`.
 *
 * Через него и приложение ходит в API ComfyUI (prompt, history, object_info, view, upload), и
 * открывается сам редактор графа во встроенной рамке. Так всё остаётся на одном origin и под
 * токеном приложения. ComfyUI проверяет, что Origin совпадает с Host, поэтому оба заголовка
 * переписываются на адрес процесса. WebSocket (`/ws`: прогресс и превью) туннелируется как есть.
 */
import http from "http";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Request, Response } from "express";
import { comfyPort, comfyReady } from "./engine";

export const UI_PREFIX = "/api/comfy/ui";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

function upstreamHeaders(src: http.IncomingHttpHeaders, port: number): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase();
    if (HOP.has(key) || key === "x-moonapp-token" || key === "cookie" || key === "referer") continue;
    h[key] = v;
  }
  h.host = `127.0.0.1:${port}`;
  if (src.origin) h.origin = `http://127.0.0.1:${port}`;
  return h;
}

export function uiProxy(req: Request, res: Response): void {
  const port = comfyPort();
  if (!port || !comfyReady()) {
    res.status(503).json({ error: "comfy_not_running" });
    return;
  }
  const rest = req.originalUrl.slice(UI_PREFIX.length) || "/";
  const headers = upstreamHeaders(req.headers, port);
  // JSON уже разобран общим парсером: отправляем заново, длину пересчитываем.
  const parsed = req.body !== undefined && req.readableEnded && /json/i.test(String(req.headers["content-type"] ?? ""));
  const payload = parsed ? Buffer.from(JSON.stringify(req.body)) : null;
  if (payload) headers["content-length"] = payload.length;
  const up = http.request({ host: "127.0.0.1", port, path: rest, method: req.method, headers }, (r) => {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(r.headers)) {
      const key = k.toLowerCase();
      if (HOP.has(key) || key === "content-security-policy" || key === "x-frame-options") continue;
      out[key] = v;
    }
    res.writeHead(r.statusCode ?? 502, out);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "comfy_unreachable" });
    else res.end();
  });
  res.on("close", () => up.destroy());
  if (payload) up.end(payload);
  else req.pipe(up);
}

/** Туннель WebSocket для `/api/comfy/ui/ws`. Проверка токена — на стороне вызывающего. */
export function uiUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const port = comfyPort();
  if (!port || !comfyReady()) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  const rest = (req.url ?? "").slice(UI_PREFIX.length) || "/";
  const headers = upstreamHeaders(req.headers, port);
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  const up = http.request({ host: "127.0.0.1", port, path: rest, method: "GET", headers });
  up.on("upgrade", (r, s, h) => {
    const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (h.length) socket.write(h);
    if (head.length) s.write(head);
    s.pipe(socket);
    socket.pipe(s);
    s.on("error", () => socket.destroy());
    socket.on("error", () => s.destroy());
    s.on("close", () => socket.destroy());
    socket.on("close", () => s.destroy());
  });
  up.on("response", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  up.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  up.end();
}
