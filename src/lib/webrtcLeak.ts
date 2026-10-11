/**
 * Проверка утечки WebRTC: разбор ICE-кандидатов и вердикт.
 *
 * `srflx` — адрес, который STUN-сервер увидел снаружи, то есть реальный
 * публичный IP браузера. Если он отличается от адреса, под которым приложение
 * выходит в сеть (прокси/VPN), сайты через WebRTC могут узнать настоящий адрес.
 */

export interface IceCandidate {
  ip: string;
  type: "host" | "srflx" | "prflx" | "relay" | string;
}

/** Разбор строки `candidate:… <ip> <port> typ <type> …`; null — если не кандидат. */
export function parseCandidate(line: string): IceCandidate | null {
  const m = String(line).match(/candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+(\w+)/);
  return m ? { ip: m[1], type: m[2] } : null;
}

/** Локальный адрес: частные диапазоны, link-local, mDNS-имя, loopback. */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s.endsWith(".local")) return true;
  if (s.includes(":")) return s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  const m = s.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Адреса виртуальных адаптеров: Hamachi (25.x), Radmin VPN (26.x), CGNAT и Tailscale
 * (100.64.0.0/10). Они видны в WebRTC как host-кандидаты, но выглядят «публичными»;
 * реального адреса провайдера они не раскрывают.
 */
export function isOverlayAddress(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 25 || a === 26 || (a === 100 && b >= 64 && b <= 127);
}

export interface LeakVerdict {
  /** Публичные адреса, видимые через WebRTC. */
  publicIps: string[];
  /** Среди них есть адрес, отличный от адреса приложения (возможная утечка мимо прокси/VPN). */
  leak: boolean;
  /** Видны только локальные/скрытые адреса — браузер ничего не раскрывает. */
  safe: boolean;
}

export function verdict(candidates: IceCandidate[], appIp: string | null): LeakVerdict {
  const publicIps = [
    ...new Set(
      candidates
        .filter((c) => c.type !== "relay" && !isPrivateAddress(c.ip) && !isOverlayAddress(c.ip))
        .map((c) => c.ip),
    ),
  ];
  const leak = publicIps.some((ip) => (appIp ? ip !== appIp : true)) && publicIps.length > 0;
  return { publicIps, leak: appIp ? leak : false, safe: publicIps.length === 0 };
}
