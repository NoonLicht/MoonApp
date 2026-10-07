/**
 * Выделено из zapret.ts при разбиении крупного файла (поведение не менялось).
 */
import https from "https";
import dgram from "dgram";
import logger from "./logger";
import { activeProfile, cfg, engineStatus, sleep, start, stop } from "./zapret";
import { listStrategies } from "./zapretStrategies";

/* ------------------------- Диагностика доступности ------------------------- */

const DEFAULT_TARGETS = [
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/generate_204", kind: "http" },
  { id: "googlevideo", name: "googlevideo (CDN)", url: "https://www.youtube.com", kind: "http" },
  {
    id: "discord-api",
    name: "Discord API",
    url: "https://discord.com/api/v9/gateway",
    kind: "http",
  },
  {
    id: "discord-gw",
    name: "Discord Gateway (WSS)",
    url: "https://gateway.discord.gg/?v=9&encver=1",
    kind: "http",
  },
  { id: "discord-voice", name: "Discord Voice (UDP/STUN)", kind: "udp" },
];

function parseCustomTargets() {
  const c = cfg();
  return String(c.customTargets || "")
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .map((url, i) => ({ id: `custom${i}`, name: url, url, kind: "http", custom: true }));
}

export function targets() {
  return [...DEFAULT_TARGETS, ...parseCustomTargets()];
}

/** HTTP-проба с таймингом. ok = 2xx..4xx (жёсткая блокировка даёт RST/timeout). */
function httpProbe(url: any, timeoutMs = 6000) {
  return new Promise<any>((resolve) => {
    const t0 = Date.now();
    try {
      const req = https.get(
        url,
        { timeout: timeoutMs, rejectUnauthorized: false, headers: { "User-Agent": "Mozilla/5.0" } },
        (res) => {
          res.resume();
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500,
            status: res.statusCode,
            latencyMs: Date.now() - t0,
            error: null,
          });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, status: null, latencyMs: Date.now() - t0, error: "timeout" });
      });
      req.on("error", (e) =>
        resolve({
          ok: false,
          status: null,
          latencyMs: Date.now() - t0,
          error: (e as NodeJS.ErrnoException).code || e.message,
        }),
      );
    } catch (e: any) {
      resolve({ ok: false, status: null, latencyMs: Date.now() - t0, error: e.message });
    }
  });
}

/** UDP/STUN-проба (голос Discord): STUN Binding Request на публичный STUN. */
function udpProbe(host = "stun.l.google.com", port = 19302, timeoutMs = 5000) {
  return new Promise<any>((resolve) => {
    const t0 = Date.now();
    const sock = dgram.createSocket("udp4");
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0);
    msg.writeUInt16BE(0, 2); // Binding Request
    msg.writeUInt32BE(0x2112a442, 4); // magic cookie
    for (let i = 8; i < 20; i++) msg[i] = Math.floor(Math.random() * 256);
    let done = false;
    const finish = (r: any) => {
      if (!done) {
        done = true;
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        resolve(r);
      }
    };
    sock.on("message", () => finish({ ok: true, latencyMs: Date.now() - t0, error: null }));
    sock.on("error", (e) =>
      finish({
        ok: false,
        latencyMs: Date.now() - t0,
        error: (e as NodeJS.ErrnoException).code || e.message,
      }),
    );
    sock.send(msg, port, host, (e) => {
      if (e)
        finish({
          ok: false,
          latencyMs: Date.now() - t0,
          error: (e as NodeJS.ErrnoException).code || e.message,
        });
    });
    setTimeout(
      () => finish({ ok: false, latencyMs: Date.now() - t0, error: "timeout" }),
      timeoutMs,
    );
  });
}

/** Прогнать всю матрицу проверок. */
export async function runDiagnostics() {
  const results = [];
  for (const t of targets()) {
    const r = t.kind === "udp" ? await udpProbe() : await httpProbe(t.url);
    results.push({ ...t, ...r, packetDrop: !r.ok });
  }
  const okCount = results.filter((r) => r.ok).length;
  const oks = results.filter((r) => r.ok);
  const avgLatency = Math.round(oks.reduce((a, r) => a + r.latencyMs, 0) / Math.max(1, oks.length));
  return {
    allOk: results.length > 0 && okCount === results.length,
    okCount,
    total: results.length,
    avgLatency,
    results,
    at: Date.now(),
  };
}

/* ------------------------- Auto-Tuner (1-click) ------------------------- */

let tuning = false;

/**
 * Прогнать стратегии по очереди: старт → диагностика → стоп.
 * Возвращает ранжированный результат; лучшую может применить сама (autoApplyBest).
 */
export async function autoTune(opts: Record<string, any> = {}) {
  if (tuning) throw new Error("tuning_already_running");
  if (!engineStatus().found) throw new Error("engine_not_found");
  tuning = true;
  const apply = opts.apply !== undefined ? !!opts.apply : !!cfg().autoApplyBest;
  const previous: any = activeProfile ? { ...activeProfile } : null;
  try {
    const tried = [];
    for (const s of listStrategies()) {
      try {
        await start({ strategyId: s.id, mode: "process", customArgs: "" });
        await sleep(2500); // даём winws и WinDivert подняться
        const diag = await runDiagnostics();
        const score = diag.allOk ? 0 : diag.okCount * -10 + diag.avgLatency / 100;
        tried.push({
          strategyId: s.id,
          allOk: diag.allOk,
          okCount: diag.okCount,
          total: diag.total,
          avgLatency: diag.avgLatency,
          score,
        });
      } catch (e: any) {
        tried.push({ strategyId: s.id, allOk: false, error: String(e.message || e) });
      }
    }
    const ranked = tried
      .filter((t) => !t.error)
      .sort((a, b) => Number(b.allOk) - Number(a.allOk) || (a.score ?? 0) - (b.score ?? 0));
    const best = ranked[0] || null;
    let applied = null;
    if (best && apply) {
      await start({ strategyId: best.strategyId, mode: "process", customArgs: "" });
      applied = best.strategyId;
    } else if (previous) {
      try {
        await start(previous);
      } catch {
        /* вернуть прежний профиль не вышло — не критично */
      }
    } else {
      await stop();
    }
    logger.action("zapret.autoTune", {
      tried: tried.length,
      best: best?.strategyId || null,
      applied,
    });
    return { tried, best: best?.strategyId || null, applied };
  } finally {
    tuning = false;
  }
}
