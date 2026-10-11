/**
 * Плагины — наборы ДАННЫХ, а не кода: навыки ИИ-чата и шаблоны заметок.
 * Плагин не исполняет скриптов и не получает доступа к API приложения, поэтому
 * установка чужого плагина не может ничего сломать или украсть.
 *
 * Манифест (JSON):
 *   { "id": "my-pack", "name": "Мой набор", "version": "1.0.0",
 *     "skills":    [{ "name": "…", "description": "…", "prompt": "…" }],
 *     "templates": [{ "id": "…", "title": "…", "body": "…" }] }
 */
import fs from "fs";
import path from "path";

export interface PluginSkill {
  name: string;
  description: string;
  prompt: string;
}
export interface PluginTemplate {
  id: string;
  title: string;
  body: string;
}
export interface Plugin {
  id: string;
  name: string;
  version: string;
  skills: PluginSkill[];
  templates: PluginTemplate[];
}

const ID = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const LIMITS = { skills: 50, templates: 50, prompt: 8000, body: 20000, name: 120 };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Проверяет и нормализует манифест; бросает Error с кодом причины. */
export function validateManifest(raw: unknown): Plugin {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("manifest_not_object");
  const m = raw as Record<string, unknown>;
  const id = str(m.id, 41).toLowerCase();
  if (!ID.test(id)) throw new Error("bad_id");
  const name = str(m.name, LIMITS.name);
  if (!name) throw new Error("name_required");
  const version = str(m.version, 20) || "0.0.0";
  const skillsRaw = Array.isArray(m.skills) ? m.skills : [];
  const tplRaw = Array.isArray(m.templates) ? m.templates : [];
  if (skillsRaw.length > LIMITS.skills || tplRaw.length > LIMITS.templates) throw new Error("too_many_items");
  const skills: PluginSkill[] = [];
  for (const s of skillsRaw) {
    const o = (s ?? {}) as Record<string, unknown>;
    const n = str(o.name, LIMITS.name);
    const prompt = str(o.prompt, LIMITS.prompt);
    if (!n || !prompt) throw new Error("bad_skill");
    skills.push({ name: n, description: str(o.description, 300), prompt });
  }
  const templates: PluginTemplate[] = [];
  const seen = new Set<string>();
  for (const t of tplRaw) {
    const o = (t ?? {}) as Record<string, unknown>;
    const tid = str(o.id, 40).toLowerCase();
    const title = str(o.title, LIMITS.name);
    const body = str(o.body, LIMITS.body);
    if (!ID.test(tid) || !title || !body || seen.has(tid)) throw new Error("bad_template");
    seen.add(tid);
    templates.push({ id: tid, title, body });
  }
  if (!skills.length && !templates.length) throw new Error("empty_plugin");
  return { id, name, version, skills, templates };
}

/* -------------------------------- Хранение -------------------------------- */

const fileOf = (dir: string, id: string): string => path.join(dir, `${id}.json`);

export function listPlugins(dir: string): Plugin[] {
  if (!fs.existsSync(dir)) return [];
  const out: Plugin[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(validateManifest(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
    } catch {
      /* повреждённый или недопустимый манифест пропускается */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function installPlugin(dir: string, raw: unknown): Plugin {
  const p = validateManifest(raw);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileOf(dir, p.id), JSON.stringify(p, null, 2), "utf8");
  return p;
}

export function removePlugin(dir: string, id: string): boolean {
  if (!ID.test(id)) return false;
  const f = fileOf(dir, id);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

/** Навыки и шаблоны всех плагинов с пометкой источника. */
export function collect(plugins: Plugin[]): {
  skills: (PluginSkill & { plugin: string })[];
  templates: (PluginTemplate & { plugin: string })[];
} {
  return {
    skills: plugins.flatMap((p) => p.skills.map((s) => ({ ...s, plugin: p.id }))),
    templates: plugins.flatMap((p) => p.templates.map((t) => ({ ...t, id: `plugin:${p.id}:${t.id}`, plugin: p.id }))),
  };
}
