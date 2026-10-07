/**
 * Каталог целей зачистки для вкладки «Приватность».
 * Описание (что именно чистится) лежит в i18n: privacy.it.<id>.t / .d.
 */
import type { WipeItem } from "./privacyTypes";

export const WIPE_ITEMS: WipeItem[] = [
  // ─────────────────────────── история команд ───────────────────────────
  { id: "shell-history", category: "history", risk: 0, platforms: ["win32", "linux"] },
  { id: "run-mru", category: "history", risk: 0, platforms: ["win32"] },
  { id: "search-history", category: "history", risk: 0, platforms: ["win32"] },
  // ────────────────────────────── недавнее ───────────────────────────────
  { id: "recent-files", category: "recent", risk: 0, platforms: ["win32"] },
  { id: "recently-used", category: "recent", risk: 0, platforms: ["linux"] },
  { id: "activity-history", category: "recent", risk: 0, platforms: ["win32"] },
  // ─────────────────────────────── кэши ──────────────────────────────────
  { id: "thumbnail-cache", category: "cache", risk: 0, platforms: ["win32", "linux"] },
  { id: "temp-files", category: "cache", risk: 0, platforms: ["win32", "linux"] },
  { id: "recycle-bin", category: "cache", risk: 1, platforms: ["win32"] },
  { id: "trash", category: "cache", risk: 1, platforms: ["linux"] },
  // ──────────────────────────── буфер/сеть ───────────────────────────────
  { id: "clipboard", category: "clipboard", risk: 0, platforms: ["win32", "linux"] },
  { id: "dns-cache", category: "network", risk: 0, platforms: ["win32", "linux"] },
  // ──────────────────────────── браузеры ─────────────────────────────────
  { id: "browser-chrome", category: "browser", risk: 1, platforms: ["win32", "linux"] },
  { id: "browser-edge", category: "browser", risk: 1, platforms: ["win32"] },
  { id: "browser-firefox", category: "browser", risk: 1, platforms: ["win32", "linux"] },
  // ───────────────────── системные логи / требуют admin ─────────────────
  { id: "event-logs", category: "logs", risk: 2, platforms: ["win32"], admin: true },
  { id: "journal-logs", category: "logs", risk: 2, platforms: ["linux"], admin: true },
  { id: "prefetch", category: "logs", risk: 2, platforms: ["win32"], admin: true },
  { id: "usb-history", category: "usb", risk: 2, platforms: ["win32"], admin: true },
];

export const WIPE_BY_ID = new Map(WIPE_ITEMS.map((i) => [i.id, i]));

export function itemsFor(platform: "win32" | "linux"): WipeItem[] {
  return WIPE_ITEMS.filter((i) => i.platforms.includes(platform));
}
