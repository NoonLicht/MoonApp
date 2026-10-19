/**
 * Обслуживание ComfyUI: обновление с GitHub, встроенный менеджер, пользовательские узлы.
 *
 * Обновление — штатным скриптом update.py портативной сборки (git-репозиторий внутри ComfyUI):
 * забирает свежий код ComfyUI и доустанавливает зависимости. Узлы ставятся архивом репозитория GitHub
 * в custom_nodes, зависимости — через pip встроенного Python.
 */
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import logger from "../logger";
import { downloadToFile } from "../download";
import { removePath } from "../fsUtil";
import {
  comfySetup,
  customNodes,
  dlDir,
  isInstalled,
  managerInstalled,
  portableRoot,
  pythonExe,
  run,
  running,
} from "./engine";
import { writeRunSettings } from "./runtime";

const UA = "MoonApp/1.0 (+ComfyUI)";

// ───────────────────────────── версии ─────────────────────────────

/** Установленная версия ComfyUI из comfyui_version.py ("" — не определить). */
export function readVersion(): string {
  try {
    const t = fs.readFileSync(path.join(portableRoot() ?? "", "ComfyUI", "comfyui_version.py"), "utf8");
    return /__version__\s*=\s*"([^"]+)"/.exec(t)?.[1] ?? "";
  } catch {
    return "";
  }
}

let latestCache: { at: number; tag: string } | null = null;

/** Последний релиз ComfyUI на GitHub (кэш на 10 минут); пустая строка, если GitHub недоступен. */
export async function latestVersion(force = false): Promise<string> {
  if (!force && latestCache && Date.now() - latestCache.at < 10 * 60 * 1000) return latestCache.tag;
  try {
    const r = await fetch("https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest", {
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return latestCache?.tag ?? "";
    const j = (await r.json()) as { tag_name?: string };
    const tag = String(j.tag_name ?? "").replace(/^v/, "");
    latestCache = { at: Date.now(), tag };
    return tag;
  } catch {
    return latestCache?.tag ?? "";
  }
}

/** a новее b? Сравнение «0.42.1» по числам; нечисловые куски считаются нулём. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

// ───────────────────────────── обновление ─────────────────────────────

export type Channel = "stable" | "latest";
export const isChannel = (v: unknown): v is Channel => v === "stable" || v === "latest";

/**
 * Обновить ComfyUI штатным скриптом сборки. stable — последний релиз, latest — ветка master.
 * Свои данные (модели, воркфлоу, результаты) лежат вне папки сборки; узлы в custom_nodes не трогаются.
 */
export function updateComfy(channel: Channel): { ok: boolean; error?: string } {
  if (!isInstalled()) return { ok: false, error: "not_installed" };
  if (comfySetup.state.state === "working") return { ok: false, error: "busy" };
  if (running()) return { ok: false, error: "running" };
  const root = portableRoot() as string;
  const updDir = path.join(root, "update");
  if (!fs.existsSync(path.join(updDir, "update.py"))) return { ok: false, error: "update_script_missing" };
  comfySetup.reset("update", channel);
  void (async () => {
    const before = readVersion();
    try {
      comfySetup.state.phase = "update";
      comfySetup.state.progress = 10;
      const flags = channel === "stable" ? ["--stable"] : [];
      const py = pythonExe();
      await run(py, ["-s", "update.py", path.join("..", "ComfyUI") + path.sep, ...flags], updDir, 20 * 60 * 1000);
      comfySetup.state.progress = 60;
      // Скрипт мог обновить сам себя: тогда кладёт update_new.py и просит повторить.
      const next = path.join(updDir, "update_new.py");
      if (fs.existsSync(next)) {
        fs.copyFileSync(next, path.join(updDir, "update.py"));
        fs.rmSync(next, { force: true });
        await run(py, ["-s", "update.py", path.join("..", "ComfyUI") + path.sep, "--skip_self_update", ...flags], updDir, 20 * 60 * 1000);
      }
      comfySetup.state.progress = 100;
      logger.info("comfy.updated", { from: before, to: readVersion(), channel });
      comfySetup.done();
    } catch (e) {
      comfySetup.fail(e);
    }
  })();
  return { ok: true };
}

// ───────────────────────────── менеджер ComfyUI ─────────────────────────────

/** Ставит зависимости встроенного менеджера (поиск и установка узлов и моделей внутри редактора). */
export function installManager(): { ok: boolean; error?: string } {
  if (!isInstalled()) return { ok: false, error: "not_installed" };
  if (comfySetup.state.state === "working") return { ok: false, error: "busy" };
  if (running()) return { ok: false, error: "running" };
  const root = portableRoot() as string;
  const req = path.join(root, "ComfyUI", "manager_requirements.txt");
  if (!fs.existsSync(req)) return { ok: false, error: "manager_unsupported" };
  comfySetup.reset("manager", null);
  void (async () => {
    try {
      comfySetup.state.phase = "pip";
      comfySetup.state.progress = 20;
      await run(pythonExe(), ["-s", "-m", "pip", "install", "--no-warn-script-location", "-r", req], root, 30 * 60 * 1000);
      writeRunSettings({ manager: true });
      comfySetup.state.progress = 100;
      logger.info("comfy.manager_installed");
      comfySetup.done();
    } catch (e) {
      comfySetup.fail(e);
    }
  })();
  return { ok: true };
}

export const managerReady = (): boolean => managerInstalled();

// ───────────────────────────── пользовательские узлы ─────────────────────────────

export interface NodePack {
  /** Имя папки (без суффикса .disabled). */
  name: string;
  enabled: boolean;
  source: string;
  hasRequirements: boolean;
  /** Встроенные узлы приложения нельзя удалить из списка по ошибке — помечаем. */
  builtin: boolean;
}

const META = "moonapp-node.json";
const SKIP = new Set(["__pycache__", "example_node.py.example", "websocket_image_save.py"]);

function originOf(dir: string): string {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META), "utf8")) as { url?: string };
    if (m.url) return m.url;
  } catch {
    /* нет метки */
  }
  try {
    const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    return /url\s*=\s*(\S+)/.exec(cfg)?.[1]?.replace(/\.git$/, "") ?? "";
  } catch {
    return "";
  }
}

export function listNodes(): NodePack[] {
  const base = customNodes();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: NodePack[] = [];
  for (const e of entries) {
    if (SKIP.has(e.name) || !e.isDirectory()) continue;
    const enabled = !e.name.endsWith(".disabled");
    const name = enabled ? e.name : e.name.slice(0, -".disabled".length);
    const dir = path.join(base, e.name);
    out.push({
      name,
      enabled,
      source: originOf(dir),
      hasRequirements: fs.existsSync(path.join(dir, "requirements.txt")),
      builtin: name === "ComfyUI-GGUF",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Разбор адреса GitHub: https://github.com/owner/repo[/tree/ветка]. Иное отклоняется. */
export function parseGithub(url: string): { owner: string; repo: string; branch: string } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?:\/tree\/([A-Za-z0-9_./-]{1,100}))?\/?$/.exec(url.trim());
  if (!m) return null;
  if (m[2] === "." || m[2] === ".." || m[1] === "." || m[1] === "..") return null;
  return { owner: m[1], repo: m[2], branch: m[3] ?? "" };
}

/** Безопасное имя папки узла из имени репозитория. */
export const nodeDirName = (repo: string): string => repo.replace(/[^A-Za-z0-9_.-]/g, "_");

function safeExtract(zipPath: string, dest: string): string {
  const zip = new AdmZip(zipPath);
  const root = path.resolve(dest);
  for (const e of zip.getEntries()) {
    const target = path.resolve(root, e.entryName);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("zip_unsafe_path");
  }
  zip.extractAllTo(root, true);
  const inner = fs.readdirSync(root).find((d) => fs.statSync(path.join(root, d)).isDirectory());
  if (!inner) throw new Error("node_layout");
  return path.join(root, inner);
}

/** Скачать узел с GitHub в custom_nodes и доустановить его зависимости. */
export function installNode(url: string): { ok: boolean; error?: string } {
  if (!isInstalled()) return { ok: false, error: "not_installed" };
  const gh = parseGithub(url);
  if (!gh) return { ok: false, error: "bad_github_url" };
  if (comfySetup.state.state === "working") return { ok: false, error: "busy" };
  if (running()) return { ok: false, error: "running" };
  comfySetup.reset("node", gh.repo);
  void (async () => {
    const tmp = path.join(dlDir(), "node");
    try {
      removePath(tmp);
      fs.mkdirSync(tmp, { recursive: true });
      const zip = path.join(tmp, "node.zip");
      comfySetup.state.phase = "download";
      const ref = gh.branch ? `refs/heads/${gh.branch}` : "HEAD";
      await downloadToFile(`https://github.com/${gh.owner}/${gh.repo}/archive/${ref}.zip`, zip, {
        userAgent: UA,
        shouldCancel: comfySetup.shouldCancel,
        onProgress: (p) => {
          comfySetup.state.received = p.received;
          comfySetup.state.total = p.total;
          comfySetup.state.progress = p.total ? Math.round((p.received / p.total) * 40) : 0;
        },
      });
      comfySetup.state.phase = "extract";
      const inner = safeExtract(zip, path.join(tmp, "x"));
      const name = nodeDirName(gh.repo);
      const dest = path.join(customNodes(), name);
      removePath(dest);
      removePath(`${dest}.disabled`);
      fs.mkdirSync(customNodes(), { recursive: true });
      fs.renameSync(inner, dest);
      fs.writeFileSync(
        path.join(dest, META),
        JSON.stringify({ url: `https://github.com/${gh.owner}/${gh.repo}`, branch: gh.branch, at: Date.now() }),
        "utf8",
      );
      const req = path.join(dest, "requirements.txt");
      if (fs.existsSync(req)) {
        comfySetup.state.phase = "pip";
        comfySetup.state.progress = 60;
        await run(pythonExe(), ["-s", "-m", "pip", "install", "--no-warn-script-location", "-r", req], portableRoot() ?? ".", 30 * 60 * 1000);
      }
      removePath(tmp);
      comfySetup.state.progress = 100;
      logger.info("comfy.node_installed", { repo: `${gh.owner}/${gh.repo}` });
      comfySetup.done();
    } catch (e) {
      removePath(tmp);
      comfySetup.fail(e);
    }
  })();
  return { ok: true };
}

/** Обновить узел заново из его репозитория (адрес берём из метки или .git). */
export function updateNode(name: string): { ok: boolean; error?: string } {
  const pack = listNodes().find((n) => n.name === name);
  if (!pack) return { ok: false, error: "node_not_found" };
  if (!pack.source) return { ok: false, error: "node_no_source" };
  return installNode(pack.source);
}

function packDir(name: string): string | null {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") return null;
  const base = customNodes();
  for (const d of [path.join(base, name), path.join(base, `${name}.disabled`)]) {
    if (fs.existsSync(d) && path.dirname(d) === base) return d;
  }
  return null;
}

export function removeNode(name: string): boolean {
  if (running()) return false;
  const d = packDir(name);
  if (!d) return false;
  removePath(d);
  return true;
}

/** Выключить/включить узел: ComfyUI не загружает папки с суффиксом .disabled. */
export function toggleNode(name: string, enabled: boolean): boolean {
  if (running()) return false;
  const d = packDir(name);
  if (!d) return false;
  const base = customNodes();
  const on = path.join(base, name);
  const off = path.join(base, `${name}.disabled`);
  if (enabled && d === off) fs.renameSync(off, on);
  else if (!enabled && d === on) fs.renameSync(on, off);
  return true;
}
