/**
 * Типы вкладки «Приватность» (стр. «Тюнинг ПК»): точечная зачистка цифровых
 * следов в уже работающей системе — история оболочки, недавние файлы, кэши,
 * системные логи, история USB-устройств, буфер обмена, DNS-кэш, кэш браузеров.
 *
 * Это НЕ стирание диска: содержимое файлов (документы, медиа) не трогается.
 */

export type PrivacyCategory =
  "history" | "recent" | "cache" | "logs" | "usb" | "clipboard" | "network" | "browser";

/** 0 — безопасно (можно отменить/несущественно), 1 — осторожно (закройте браузер/проводник моргнёт), 2 — системные логи/требует admin. */
export type PrivacyRisk = 0 | 1 | 2;

export interface WipeItem {
  id: string;
  category: PrivacyCategory;
  risk: PrivacyRisk;
  platforms: ("win32" | "linux")[];
  admin?: boolean;
}

export interface WipeOutcome {
  ok: boolean;
  removed: number;
  bytes: number;
  error?: string;
}

export interface WipeItemResult extends WipeOutcome {
  id: string;
}

export interface PanicLogEntry {
  at: number;
  ids: string[];
  removed: number;
  bytes: number;
  failed: string[];
}
