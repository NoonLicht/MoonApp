/**
 * Сеть: разбор списка Wi-Fi сетей (netsh/nmcli) с оценкой загруженности каналов
 * и классификация DNS-серверов. Только чистые функции — запуск команд снаружи.
 */

export interface WifiNet {
  ssid: string;
  /** 0–100 */
  signal: number;
  channel: number | null;
  band: "2.4" | "5" | "6" | null;
}

/** Метки netsh бывают русскими и английскими — ищем по обоим. */
const SSID = /^\s*SSID\s+\d+\s*:\s*(.*)$/i;
const SIGNAL = /^\s*(?:Signal|Сигнал)\s*:\s*(\d+)\s*%/i;
const CHANNEL = /^\s*(?:Channel|Канал)\s*:\s*(\d+)/i;

export function bandOf(channel: number | null): WifiNet["band"] {
  if (channel === null) return null;
  if (channel >= 1 && channel <= 14) return "2.4";
  if (channel >= 32 && channel <= 177) return "5";
  return null;
}

/** Разбор `netsh wlan show networks mode=bssid` (по одной записи на BSSID, сигнал максимальный). */
export function parseNetsh(text: string): WifiNet[] {
  const nets: WifiNet[] = [];
  let cur: WifiNet | null = null;
  let bssidSignal = -1;
  for (const line of text.split(/\r?\n/)) {
    const s = line.match(SSID);
    if (s) {
      cur = { ssid: s[1].trim() || "(скрытая)", signal: 0, channel: null, band: null };
      nets.push(cur);
      bssidSignal = -1;
      continue;
    }
    if (!cur) continue;
    const sig = line.match(SIGNAL);
    if (sig) {
      const v = Number(sig[1]);
      if (v > bssidSignal) {
        bssidSignal = v;
        cur.signal = v;
      }
      continue;
    }
    const ch = line.match(CHANNEL);
    if (ch && cur.channel === null) {
      cur.channel = Number(ch[1]);
      cur.band = bandOf(cur.channel);
    }
  }
  return nets;
}

/** Разбор `nmcli -t -f SSID,SIGNAL,CHAN dev wifi list` (поля через «:»). */
export function parseNmcli(text: string): WifiNet[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/(?<!\\):/);
      const channel = parts[2] && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
      return {
        ssid: (parts[0] || "(скрытая)").replace(/\\:/g, ":"),
        signal: Number(parts[1]) || 0,
        channel,
        band: bandOf(channel),
      } as WifiNet;
    });
}

export interface ChannelLoad {
  channel: number;
  networks: number;
  /** Сумма «давления»: сильные сети на этом и соседних каналах мешают сильнее. */
  interference: number;
}

/**
 * Загрузка каналов 2,4 ГГц. Каналы шириной 20 МГц перекрываются с соседями в
 * пределах ±4, поэтому помеха считается по перекрытию, а рекомендация — только
 * среди непересекающихся 1, 6 и 11.
 */
export function analyzeChannels(nets: WifiNet[]): {
  loads: ChannelLoad[];
  recommended: number | null;
} {
  const two = nets.filter((n) => n.band === "2.4" && n.channel !== null);
  const loads: ChannelLoad[] = [];
  for (let ch = 1; ch <= 13; ch++) {
    let networks = 0;
    let interference = 0;
    for (const n of two) {
      const d = Math.abs((n.channel as number) - ch);
      if (d === 0) networks++;
      if (d <= 4) interference += (n.signal / 100) * (1 - d / 5);
    }
    loads.push({ channel: ch, networks, interference: Math.round(interference * 100) / 100 });
  }
  if (!two.length) return { loads, recommended: null };
  const best = [1, 6, 11]
    .map((c) => loads[c - 1])
    .sort((a, b) => a.interference - b.interference || a.networks - b.networks)[0];
  return { loads, recommended: best.channel };
}

/* --------------------------------- DNS --------------------------------- */

export type DnsKind = "private" | "public-known" | "public-other" | "loopback" | "invalid";

const KNOWN_PUBLIC: Record<string, string> = {
  "1.1.1.1": "Cloudflare",
  "1.0.0.1": "Cloudflare",
  "8.8.8.8": "Google",
  "8.8.4.4": "Google",
  "9.9.9.9": "Quad9",
  "149.112.112.112": "Quad9",
  "77.88.8.8": "Яндекс",
  "77.88.8.1": "Яндекс",
  "208.67.222.222": "OpenDNS",
  "208.67.220.220": "OpenDNS",
};

export function classifyDns(ip: string): { kind: DnsKind; provider: string | null } {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((p) => Number(p) > 255)) return { kind: "invalid", provider: null };
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return { kind: "loopback", provider: null };
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return { kind: "private", provider: null };
  }
  const known = KNOWN_PUBLIC[ip.trim()];
  return known ? { kind: "public-known", provider: known } : { kind: "public-other", provider: null };
}

/** Кандидат ICE (a=candidate:...) → тип и адрес; нужен проверке WebRTC-утечки. */
export function parseIceCandidate(c: string): { type: string; address: string } | null {
  const m = c.match(/candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+(\w+)/);
  return m ? { address: m[1], type: m[2] } : null;
}
