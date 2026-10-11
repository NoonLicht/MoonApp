/** Контракты управления веб-компаньоном (server/ts/companion.ts, routes/companion.ts). Только типы. */

/** Устройство без секрета: хэш токена наружу не отдаётся никогда. */
export interface PublicDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}

export interface PlayerState {
  title: string;
  paused: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  at: number;
}

export interface PlayerCommand {
  id: number;
  cmd: "play" | "pause" | "toggle" | "seek" | "volume" | "mute";
  value?: number;
}

export interface CompanionStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  urls: string[];
  pairing: { code: string; expiresAt: number } | null;
  devices: PublicDevice[];
  inboxDir: string;
  inbox: { name: string; size: number; at: number }[];
}
