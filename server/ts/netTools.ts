/**
 * Сетевые утилиты для страницы Bypass: ping/traceroute (обёртка над системными
 * ping/tracert — тот же приём, что и для ffmpeg/git в проекте), TCP connect-scan
 * портов (свой, без внешних зависимостей), публичный IP и мониторинг Wi-Fi
 * (netsh). Kill-switch сознательно НЕ реализован — правки системного firewall
 * автономно, без возможности протестировать на живой машине ночью, слишком
 * рискованны (см. итоговый отчёт).
 */
import { exec } from "child_process";
import net from "net";
import os from "os";

function execAsync(cmd: string, timeoutMs = 15000): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ out: String(stdout || ""), err: error ? String(stderr || error.message) : "" });
      },
    );
  });
}

/** Простая защита от command injection: хост — только допустимые символы имени/IP. */
function sanitizeHost(host: string): string {
  const h = String(host || "").trim();
  if (!/^[a-zA-Z0-9.\-:]+$/.test(h) || h.length > 255) {
    throw new Error("invalid_host");
  }
  return h;
}

export async function ping(host: string): Promise<{ ok: boolean; output: string }> {
  const h = sanitizeHost(host);
  const { out, err } = await execAsync(`ping -n 4 ${h}`, 12000);
  const output = out || err;
  return { ok: !err && /TTL=/i.test(output), output };
}

export async function traceroute(host: string): Promise<{ ok: boolean; output: string }> {
  const h = sanitizeHost(host);
  const { out, err } = await execAsync(`tracert -d -h 20 -w 800 ${h}`, 25000);
  return { ok: !err, output: out || err };
}

export interface PortScanResult {
  port: number;
  open: boolean;
}

function scanOnePort(host: string, port: number, timeoutMs: number): Promise<PortScanResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, open });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/** TCP connect-scan диапазона портов, с ограничением на общее число портов и параллелизм. */
export async function portScan(
  host: string,
  from: number,
  to: number,
): Promise<{ host: string; results: PortScanResult[] }> {
  const h = sanitizeHost(host);
  const start = Math.max(1, Math.min(65535, Math.floor(from)));
  const end = Math.max(1, Math.min(65535, Math.floor(to)));
  if (end < start) throw new Error("invalid_range");
  if (end - start > 1000) throw new Error("range_too_large"); // защита от случайного скана всего диапазона

  const ports = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const CONCURRENCY = 64;
  const results: PortScanResult[] = [];
  for (let i = 0; i < ports.length; i += CONCURRENCY) {
    const batch = ports.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((p) => scanOnePort(h, p, 600)));
    results.push(...batchResults);
  }
  return { host: h, results };
}

/** Публичный IP через сторонний echo-сервис (нужна сеть; при недоступности — честная ошибка). */
export async function publicIp(): Promise<{ ip: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { ip: string };
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/** Локальные сетевые интерфейсы (без внешних запросов) — IP/MAC/семейство. */
export function localInterfaces(): Record<string, os.NetworkInterfaceInfo[]> {
  return os.networkInterfaces() as Record<string, os.NetworkInterfaceInfo[]>;
}

export async function wifiNetworks(): Promise<{ ok: boolean; output: string }> {
  const { out, err } = await execAsync("netsh wlan show networks mode=bssid", 10000);
  return { ok: !err, output: out || err };
}

export async function wifiCurrent(): Promise<{ ok: boolean; output: string }> {
  const { out, err } = await execAsync("netsh wlan show interfaces", 10000);
  return { ok: !err, output: out || err };
}
