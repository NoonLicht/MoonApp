/**
 * API управления веб-компаньоном (server/ts/routes/companion.ts).
 */
import { BASE, req, tokenHeaders } from "@/api/apiHttp";
import type { CompanionStatus, PlayerCommand as CompanionCommand, PlayerState } from "@contracts/companion";

export type { CompanionStatus, CompanionCommand };
/** Состояние плеера, которое окно приложения отправляет на сервер (без метки времени — её ставит сервер). */
export type CompanionPlayerState = Omit<PlayerState, "at">;


export const companionApi = {
  companionStatus: () => req<CompanionStatus>("GET", "/companion/status"),
  companionEnable: (enabled: boolean, port?: number) =>
    req<CompanionStatus>("POST", "/companion/enable", { enabled, port }),
  companionNewCode: () => req<CompanionStatus>("POST", "/companion/pairing"),
  companionRevoke: (id: string) => req<{ ok: boolean }>("DELETE", `/companion/devices/${id}`),
  companionPlayerState: (state: CompanionPlayerState | null) =>
    req<{ ok: boolean }>("POST", "/companion/player-state", { state }),
  companionCommands: () => req<CompanionCommand[]>("GET", "/companion/commands"),
  companionCamSnapshot: () => req<{ ok: boolean; name: string; dir: string }>("POST", "/companion/cam/snapshot"),
  companionCamKey: () => req<CompanionStatus>("POST", "/companion/cam/key"),
  /** Последний кадр камеры телефона как blob-URL (вызывающий освобождает его через URL.revokeObjectURL). */
  companionCamFrame: async (): Promise<string | null> => {
    const r = await fetch(`${BASE}/api/companion/cam/frame`, { headers: tokenHeaders() });
    if (!r.ok) return null;
    return URL.createObjectURL(await r.blob());
  },
};
