/**
 * Редактируемые горячие клавиши.
 *
 * Комбинация хранится строкой «Ctrl+Shift+K». Ctrl и Cmd считаются одной
 * клавишей-модификатором (на macOS это Cmd), поэтому сочетание работает на
 * любой платформе без переключения. Переопределения лежат в localStorage:
 * это настройка конкретного устройства, как и сама раскладка клавиатуры.
 */

export interface HotkeyDef {
  id: string;
  /** Ключ i18n с названием действия. */
  labelKey: string;
  defaultCombo: string;
}

export const HOTKEYS: HotkeyDef[] = [
  { id: "palette", labelKey: "settings.hotkeys.palette", defaultCombo: "Ctrl+K" },
  { id: "chatSwitcher", labelKey: "settings.hotkeys.chatSwitcher", defaultCombo: "Ctrl+Shift+K" },
  { id: "noteSave", labelKey: "settings.hotkeys.noteSave", defaultCombo: "Ctrl+S" },
  { id: "privacy", labelKey: "settings.hotkeys.privacy", defaultCombo: "Ctrl+Alt+H" },
];

const STORAGE_KEY = "moonapp.hotkeys";
export const HOTKEYS_EVENT = "app:hotkeys";

export interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Клавиша в верхнем регистре для букв/цифр, имя для остальных («ENTER», «F5», «/»). */
  key: string;
}

/** Минимальный срез KeyboardEvent — чтобы функции проверялись без DOM. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph"]);

function normKey(k: string): string {
  if (k === " ") return "SPACE";
  if (k.length === 1) return k.toUpperCase();
  return k.toUpperCase();
}

export function parseCombo(s: string): Combo | null {
  const parts = String(s || "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const c: Combo = { ctrl: false, alt: false, shift: false, key: "" };
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "ctrl" || low === "cmd" || low === "meta" || low === "control") c.ctrl = true;
    else if (low === "alt" || low === "option") c.alt = true;
    else if (low === "shift") c.shift = true;
    else c.key = normKey(p);
  }
  return c.key ? c : null;
}

export function formatCombo(c: Combo): string {
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.key].filter(Boolean).join("+");
}

/** Комбинация из события клавиатуры; null, если нажат только модификатор. */
export function eventToCombo(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  return formatCombo({
    ctrl: e.ctrlKey || e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: normKey(e.key),
  });
}

export function matchesCombo(e: KeyLike, combo: string): boolean {
  const c = parseCombo(combo);
  if (!c || MODIFIER_KEYS.has(e.key)) return false;
  return (
    c.ctrl === (e.ctrlKey || e.metaKey) &&
    c.alt === e.altKey &&
    c.shift === e.shiftKey &&
    c.key === normKey(e.key)
  );
}

/** Нужен хотя бы один модификатор, иначе клавиша сломает обычный ввод текста. */
export function isValidCombo(combo: string): boolean {
  const c = parseCombo(combo);
  return !!c && (c.ctrl || c.alt || /^F\d{1,2}$/.test(c.key));
}

type Overrides = Record<string, string>;

function readOverrides(): Overrides {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Overrides) : {};
  } catch {
    return {};
  }
}

export function getCombo(id: string): string {
  const def = HOTKEYS.find((h) => h.id === id);
  const o = readOverrides()[id];
  return o && parseCombo(o) ? o : (def?.defaultCombo ?? "");
}

/** Сохраняет сочетание (null — вернуть стандартное) и оповещает подписчиков. */
export function setCombo(id: string, combo: string | null): void {
  const o = readOverrides();
  if (combo === null) delete o[id];
  else o[id] = combo;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(o));
  } catch {
    /* хранилище недоступно — настройка живёт до перезагрузки */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(HOTKEYS_EVENT));
}

/** Какое другое действие уже занимает это сочетание. */
export function findConflict(id: string, combo: string): string | null {
  const target = parseCombo(combo);
  if (!target) return null;
  const key = formatCombo(target);
  for (const h of HOTKEYS) {
    if (h.id === id) continue;
    const other = parseCombo(getCombo(h.id));
    if (other && formatCombo(other) === key) return h.id;
  }
  return null;
}

/** Подписка на «keydown» окна для действия; перечитывает сочетание на каждом нажатии. */
export function onHotkey(id: string, handler: (e: KeyboardEvent) => void): () => void {
  const listener = (e: KeyboardEvent) => {
    if (matchesCombo(e, getCombo(id))) handler(e);
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}
