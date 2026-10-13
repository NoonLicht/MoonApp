/** Слэш-команды чата: список для подсказки и разбор введённой строки. */
export interface SlashCommand {
  name: string;
  /** Ключ i18n с описанием. */
  desc: string;
  /** Команде нужен аргумент (/title, /model, /system). */
  needsArg?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "compact", desc: "aichat.cmdCompact" },
  { name: "clear", desc: "aichat.cmdClear" },
  { name: "undo", desc: "aichat.cmdUndo" },
  { name: "retry", desc: "aichat.cmdRetry" },
  { name: "fork", desc: "aichat.cmdFork" },
  { name: "new", desc: "aichat.cmdNew" },
  { name: "title", desc: "aichat.cmdTitle", needsArg: true },
  { name: "model", desc: "aichat.cmdModel", needsArg: true },
  { name: "system", desc: "aichat.cmdSystem", needsArg: true },
  { name: "export", desc: "aichat.cmdExport" },
  { name: "copy", desc: "aichat.cmdCopy" },
  { name: "help", desc: "aichat.cmdHelp" },
];

export interface ParsedSlash {
  name: string;
  arg: string;
  /** Команда есть в списке. */
  known: boolean;
}

/**
 * Разбор строки ввода. Обычный текст, начинающийся с «/» (например путь `/usr/bin`),
 * командой не считается: неизвестное имя — только если введено одно слово.
 */
export function parseSlash(input: string): ParsedSlash | null {
  const m = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim();
  const known = SLASH_COMMANDS.some((c) => c.name === name);
  if (!known && arg) return null;
  return { name, arg, known };
}

/** Подсказки при наборе «/ко…» (пока нет пробела). */
export function suggestSlash(input: string): SlashCommand[] {
  const m = /^\/([a-zA-Z]*)$/.exec(input);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}
