/**
 * Режимы приложения: именованные наборы настроек («Учёба», «Игра»), которые
 * включаются одним нажатием и откатываются к прежним значениям.
 *
 * Логика — чистые функции над деревом настроек: patchFor строит патч,
 * snapshotFor запоминает старые значения тех же ключей, а restore возвращает
 * их. Ключи вне схемы настроек отбрасывает сам settings.set().
 */

export type Tree = { [key: string]: unknown };

export interface AppMode {
  id: string;
  patch: Tree;
}

export const BUILTIN_MODES: AppMode[] = [
  {
    id: "study",
    patch: {
      appearance: { reduceMotion: true, density: "compact" },
      monitor: { alertsEnabled: false },
      clipboardHistory: { enabled: false },
    },
  },
  {
    id: "game",
    patch: {
      appearance: { reduceMotion: true, backgroundBlur: false },
      performance: { keepPagesAlive: false, backgroundBlur: false },
      monitor: { autoStart: true, alertsEnabled: true },
    },
  },
];

const isObj = (v: unknown): v is Tree => v != null && typeof v === "object" && !Array.isArray(v);

/** Значения тех же ключей, что в patch, из текущих настроек (для отката). */
export function snapshotFor(current: Tree, patch: Tree): Tree {
  const out: Tree = {};
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v)) out[k] = snapshotFor(isObj(current[k]) ? (current[k] as Tree) : {}, v);
    else if (k in current) out[k] = current[k];
  }
  return out;
}

/** Убирает из патча ключи, которые уже имеют целевое значение. */
export function effectivePatch(current: Tree, patch: Tree): Tree {
  const out: Tree = {};
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v)) {
      const nested = effectivePatch(isObj(current[k]) ? (current[k] as Tree) : {}, v);
      if (Object.keys(nested).length) out[k] = nested;
    } else if (current[k] !== v) out[k] = v;
  }
  return out;
}

export interface ModeState {
  active: string | null;
  /** Значения, которые нужно вернуть при выходе из режима. */
  previous: Tree;
}

export const EMPTY_STATE: ModeState = { active: null, previous: {} };

/**
 * Включает режим: возвращает патч настроек и новое состояние. Если уже активен
 * другой режим, сначала откатывается он (чтобы старые значения не терялись).
 */
export function activate(
  current: Tree,
  state: ModeState,
  mode: AppMode,
): { patch: Tree; state: ModeState } {
  const base = state.active ? mergeDeep(current, state.previous) : current;
  const patch = effectivePatch(base, mode.patch);
  const previous = snapshotFor(base, mode.patch);
  return {
    patch: state.active ? mergeDeep(state.previous, mode.patch) : patch,
    state: { active: mode.id, previous },
  };
}

/** Выход из режима: патч с прежними значениями и пустое состояние. */
export function deactivate(state: ModeState): { patch: Tree; state: ModeState } {
  return { patch: state.active ? state.previous : {}, state: EMPTY_STATE };
}

function mergeDeep(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k] as Tree, v) : v;
  }
  return out;
}
