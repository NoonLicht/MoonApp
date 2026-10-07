import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Страж перевода модулей на TS (server/ts -> server, electron/ts -> electron,
 * scripts/ts -> scripts).
 *
 * Исходник, не попавший под include tsconfig, существует только в .ts:
 * require("./имя") упадёт в рантайме, потому что рядом нет собранного .js.
 * Отдельно проверяем, что артефакт не попал в git: он генерируется и в истории
 * репозитория дублировать его не нужно.
 */
const root = path.resolve(__dirname, "..");
const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");

interface Target {
  srcDir: string;
  outDir: string;
  config: string;
  /** Артефакты scripts/ собираются в .mjs для .mts-исходников. */
  checkArtifacts: boolean;
}

const TARGETS: Target[] = [
  { srcDir: "server/ts", outDir: "server", config: "tsconfig.server.json", checkArtifacts: true },
  {
    srcDir: "electron/ts",
    outDir: "electron",
    config: "tsconfig.electron.json",
    checkArtifacts: true,
  },
  {
    srcDir: "scripts/ts",
    outDir: "scripts",
    config: "tsconfig.scripts.json",
    checkArtifacts: false,
  },
];

function listSources(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSources(p, base));
    else if (/\.m?ts$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      out.push(path.relative(base, p).split(path.sep).join("/"));
    }
  }
  return out;
}

const toArtifact = (rel: string) => rel.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js");

describe.each(TARGETS)("перевод на TS: $srcDir", ({ srcDir, outDir, config, checkArtifacts }) => {
  const sources = listSources(path.join(root, srcDir));
  const cfg = JSON.parse(
    fs.readFileSync(path.join(root, config), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ) as { include?: string[]; compilerOptions: { outDir: string; rootDir: string } };

  it("есть исходники (иначе тест ничего не проверяет)", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("tsconfig подхватывает все исходники через include", () => {
    expect(cfg.include).toBeDefined();
    expect(cfg.include?.some((g) => g.startsWith(`${srcDir}/`))).toBe(true);
    expect(cfg.compilerOptions.rootDir).toBe(srcDir);
    expect(cfg.compilerOptions.outDir).toBe(outDir);
  });

  it.each(sources)("для %s собран артефакт и он не хранится в git", (rel) => {
    const artifactRel = toArtifact(rel);
    if (checkArtifacts) {
      const artifact = path.join(root, outDir, artifactRel);
      expect(fs.existsSync(artifact), `нет собранного ${artifact}`).toBe(true);
      // Обычные модули отдают `exports.*`, а модули с `export =`
      // (CommonJS-совместимые, как logger или роутеры) — `module.exports = ...`.
      // Модули, содержащие только типы, дают пустой артефакт с `exports.__esModule`.
      expect(fs.readFileSync(artifact, "utf8")).toMatch(/exports|require\(/);
    }
    const full = `${outDir}/${artifactRel}`;
    const dirPattern = `${outDir}/${artifactRel.split("/").slice(0, -1).join("/")}/`;
    const covered =
      gitignore.includes(full) ||
      (artifactRel.includes("/") && gitignore.includes(dirPattern)) ||
      (outDir === "scripts" && /^scripts\/\*\.m?js$/m.test(gitignore));
    expect(covered, `${full} не в .gitignore`).toBe(true);
  });
});
