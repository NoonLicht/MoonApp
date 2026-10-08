/**
 * Kill-switch — точка входа, которую требуют server/routes/killSwitch.js и
 * server/index.ts (startupCleanup при старте сервера). Реализация зависит от
 * платформы: killSwitchWin.ts (netsh advfirewall) на Windows,
 * killSwitchLinux.ts (nftables/iptables) на остальных ОС — контракт
 * (arm/disarm/status/startupCleanup + KillSwitchStatus) у них одинаковый, так
 * что этот файл — тонкий диспетчер без собственной логики, и вызывающему
 * коду вообще не нужно знать про платформу.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = (
  process.platform === "win32" ? require("./killSwitchWin") : require("./killSwitchLinux")
) as {
  arm(): void;
  disarm(): Promise<{ ok: boolean; error?: string }>;
  status(): Promise<{ armed: boolean; blocking: boolean; proxyRunning: boolean; error: string }>;
  startupCleanup(): Promise<void>;
};

export const arm = impl.arm;
export const disarm = impl.disarm;
export const status = impl.status;
export const startupCleanup = impl.startupCleanup;
export type { KillSwitchStatus } from "./killSwitchWin";
