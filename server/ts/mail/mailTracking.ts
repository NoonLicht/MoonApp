/**
 * Отслеживание открытий и переходов по ссылкам — без чужого сервера.
 *
 * Для пикселя нужен публичный адрес, поэтому пользователь поднимает собственный микро-эндпоинт
 * (шаблон Cloudflare Worker ниже, бесплатного тарифа хватает) и вносит его адрес и ключ в
 * настройки. Приложение:
 *   - вставляет в исходящие 1×1 пиксель и переписывает ссылки на /c/<id>?u=…;
 *   - периодически забирает события GET <base>/events?since=<ts> (заголовок X-Key).
 * Без настроенного эндпоинта отправка идёт как обычно — письма не трогаются.
 */
import crypto from "crypto";
import { mailDb } from "./mailDb";
import { getSettings } from "./mailSettings";
import type { SendPayload } from "./mailService";

export interface TrackEvent {
  id: string;
  trackId: string;
  kind: "open" | "click";
  url: string;
  ts: number;
}

function enabled(): boolean {
  const t = getSettings().tracking;
  return t.enabled && /^https?:\/\//i.test(t.base) && !!t.key;
}

export function decorateOutgoing(p: SendPayload): { payload: SendPayload; trackId: string } {
  if (!p.track || !enabled()) return { payload: p, trackId: "" };
  const t = getSettings().tracking;
  const base = t.base.replace(/\/+$/, "");
  const id = crypto.randomBytes(9).toString("base64url");
  let html = p.html;
  if (t.clicks) {
    html = html.replace(
      /<a\b([^>]*?)href=("|')(https?:\/\/[^"']+)\2/gi,
      (_m, pre: string, q: string, url: string) => {
        return `<a${pre}href=${q}${base}/c/${id}?u=${encodeURIComponent(url)}${q}`;
      },
    );
  }
  if (t.opens)
    html += `<img src="${base}/o/${id}.gif" width="1" height="1" alt="" style="display:none">`;
  return { payload: { ...p, html }, trackId: id };
}

let polling = false;

/** Забирает события с эндпоинта и сохраняет локально. */
export async function pollTracking(): Promise<number> {
  if (!enabled() || polling) return 0;
  polling = true;
  try {
    const t = getSettings().tracking;
    const d = mailDb();
    const last =
      (d.prepare("SELECT MAX(ts) AS m FROM track_events").get() as { m: number | null }).m ?? 0;
    const res = await fetch(`${t.base.replace(/\/+$/, "")}/events?since=${last}`, {
      headers: { "X-Key": t.key },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as {
      id: string;
      t: string;
      k: string;
      u?: string;
      ts: number;
    }[];
    const ins = d.prepare(
      "INSERT OR IGNORE INTO track_events (id, track_id, kind, url, ts) VALUES (?,?,?,?,?)",
    );
    let n = 0;
    for (const e of list) {
      if (!e.id || !e.t) continue;
      ins.run(e.id, e.t, e.k === "click" ? "click" : "open", e.u ?? "", e.ts);
      n++;
    }
    return n;
  } finally {
    polling = false;
  }
}

export function trackingSummary(): {
  trackId: string;
  subject: string;
  to: string[];
  sent: number;
  opens: number;
  clicks: number;
  lastOpen: number;
  events: TrackEvent[];
}[] {
  const d = mailDb();
  const rows = d.prepare("SELECT * FROM tracked ORDER BY sent DESC LIMIT 100").all() as {
    track_id: string;
    subject: string;
    to_json: string;
    sent: number;
  }[];
  return rows.map((r) => {
    const ev = d
      .prepare(
        "SELECT id, track_id, kind, url, ts FROM track_events WHERE track_id = ? ORDER BY ts DESC LIMIT 50",
      )
      .all(r.track_id) as { id: string; track_id: string; kind: string; url: string; ts: number }[];
    const events = ev.map((e) => ({
      id: e.id,
      trackId: e.track_id,
      kind: (e.kind === "click" ? "click" : "open") as "open" | "click",
      url: e.url,
      ts: e.ts,
    }));
    let to: string[] = [];
    try {
      to = JSON.parse(r.to_json) as string[];
    } catch {
      /* пусто */
    }
    return {
      trackId: r.track_id,
      subject: r.subject,
      to,
      sent: r.sent,
      opens: events.filter((e) => e.kind === "open").length,
      clicks: events.filter((e) => e.kind === "click").length,
      lastOpen: events.find((e) => e.kind === "open")?.ts ?? 0,
      events,
    };
  });
}

/** Код Cloudflare Worker (KV-привязка EVENTS, секрет KEY). Публикуется пользователем. */
export const WORKER_TEMPLATE = `// MoonApp Mail tracking — Cloudflare Worker
// 1) Создайте KV namespace и привяжите к воркеру как EVENTS.
// 2) Добавьте секрет KEY (тот же, что в настройках почты).
// 3) Адрес воркера впишите в «Адрес эндпоинта».
const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const log = async (t, k, url) => {
      const ts = Date.now();
      const id = t + ":" + ts + ":" + Math.random().toString(36).slice(2, 7);
      await env.EVENTS.put("e:" + ts + ":" + id, JSON.stringify({ id, t, k, u: url || "", ts }), { expirationTtl: 60 * 60 * 24 * 90 });
    };
    if (u.pathname.startsWith("/o/")) {
      await log(u.pathname.slice(3).replace(/\\.gif$/, ""), "open");
      return new Response(GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" } });
    }
    if (u.pathname.startsWith("/c/")) {
      const target = u.searchParams.get("u") || "/";
      await log(u.pathname.slice(3), "click", target);
      return Response.redirect(target, 302);
    }
    if (u.pathname === "/events") {
      if (req.headers.get("X-Key") !== env.KEY) return new Response("forbidden", { status: 403 });
      const since = Number(u.searchParams.get("since") || 0);
      const list = await env.EVENTS.list({ prefix: "e:", limit: 1000 });
      const out = [];
      for (const k of list.keys) {
        const ts = Number(k.name.split(":")[1]);
        if (ts <= since) continue;
        const v = await env.EVENTS.get(k.name);
        if (v) out.push(JSON.parse(v));
      }
      return Response.json(out);
    }
    return new Response("ok");
  },
};
`;
