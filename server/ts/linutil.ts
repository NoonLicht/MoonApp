/**
 * Linux-инструменты из ChrisTitusTech/linutil (лицензия MIT).
 *
 * Скрипты лежат в server/vendor/linutil как есть (рядом — LICENSE); каталог пунктов
 * собран из их tab_data.toml в catalog.json. Многие скрипты интерактивны (спрашивают
 * подтверждения, вызывают sudo), поэтому запускаем их в окне эмулятора терминала —
 * так ввод пароля и вопросы работают, а пользователь видит каждое действие.
 * Скрипты используют относительные пути (`. ../../common-script.sh`), поэтому
 * выполняются из своей папки.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config";

export interface LuPre {
  matches: boolean;
  kind: "command_exists" | "env" | "file";
  arg?: string;
  values: string[];
}

export interface LuNode {
  id?: string;
  name: string;
  desc?: string;
  script?: string;
  tasks?: string;
  pre?: LuPre[];
  children?: LuNode[];
}

export interface LuTab {
  id: string;
  name: string;
  groups: LuNode[];
}

const ROOT = config.vendorPath("linutil");

let cache: LuTab[] | null = null;
const catalog = (): LuTab[] => {
  if (!cache) cache = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8")).tabs;
  return cache as LuTab[];
};

function commandExists(cmd: string): boolean {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  dirs.push(
    path.join(process.env.HOME || "", ".local/share/flatpak/exports/bin"),
    "/var/lib/flatpak/exports/bin",
  );
  return dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Условия показа пункта (как в linutil): command_exists — все команды, env/file — любое значение. */
function preOk(p: LuPre): boolean {
  let hit = false;
  if (p.kind === "command_exists") hit = p.values.every(commandExists);
  else if (p.kind === "env") hit = p.values.includes(process.env[p.arg || ""] ?? "\u0000");
  else {
    try {
      const text = fs.readFileSync(p.arg || "", "utf8");
      hit = p.values.some((v) => text.includes(v));
    } catch {
      hit = false;
    }
  }
  return hit === p.matches;
}

function filter(nodes: LuNode[]): LuNode[] {
  const out: LuNode[] = [];
  for (const n of nodes) {
    if (n.pre && !n.pre.every(preOk)) continue;
    if (n.children) {
      const kids = filter(n.children);
      if (!kids.length) continue;
      out.push({ ...n, pre: undefined, children: kids });
    } else out.push({ ...n, pre: undefined });
  }
  return out;
}

export function linutilOverview(): { tabs: LuTab[]; terminal: string | null; distro: string } {
  let distro = "";
  try {
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync("/etc/os-release", "utf8"));
    distro = m ? m[1] : "";
  } catch {
    /* не Linux или нет os-release */
  }
  const tabs = catalog()
    .map((t) => ({ ...t, groups: filter(t.groups) }))
    .filter((t) => t.groups.length);
  return { tabs, terminal: findTerminal()?.[0] ?? null, distro };
}

function allIds(): Set<string> {
  const ids = new Set<string>();
  const walk = (l: LuNode[]): void => {
    for (const n of l) {
      if (n.id) ids.add(n.id);
      if (n.children) walk(n.children);
    }
  };
  for (const t of catalog()) walk(t.groups);
  return ids;
}

/** Эмуляторы терминала и ключ, после которого идёт команда. */
const TERMINALS: [string, string[]][] = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["xterm", ["-e"]],
];

function findTerminal(): [string, string[]] | null {
  return TERMINALS.find(([bin]) => commandExists(bin)) ?? null;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface LuRunResult {
  ok: boolean;
  error?: string;
  terminal?: string;
}

/** Запускает пункт каталога в терминале. Принимается только id из каталога. */
export function linutilRun(id: string): LuRunResult {
  if (process.platform !== "linux") return { ok: false, error: "linux_only" };
  if (!allIds().has(id)) return { ok: false, error: "unknown_script" };
  const term = findTerminal();
  if (!term) return { ok: false, error: "no_terminal" };
  const file = path.join(ROOT, id);
  const dir = path.dirname(file);
  const line =
    `cd ${shq(dir)} && sh ${shq(path.basename(file))}; ` +
    `printf '\\n--- Готово. Нажмите Enter, чтобы закрыть окно ---\\n'; read _`;
  const [bin, flag] = term;
  const child = spawn(bin, [...flag, "sh", "-c", line], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return { ok: true, terminal: bin };
}
