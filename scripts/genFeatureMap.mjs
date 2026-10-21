/**
 * Карта «страница → какие серверные функции ей нужны».
 *
 * Зачем: пользователь может целиком отключить страницу, и вместе с ней должны остановиться
 * серверные функции, которые нужны ТОЛЬКО ей (роуты не монтируются, тяжёлые модули вроде
 * tesseract не грузятся, фоновые службы не стартуют). А то, чем пользуются и другие включённые
 * страницы (распознавание речи в чате, OCR в скриншотах), остаётся работать.
 *
 * Как считаем: у каждой страницы берём все её файлы (транзитивно по импортам, начиная с точки
 * входа из PAGE_LOADERS в App.tsx), находим вызовы `api.<метод>` и строки `/api/<префикс>`,
 * а метод переводим в префикс роута по описаниям в src/api/*.ts. Файлы, достижимые из самой
 * оболочки приложения (main.tsx/App.tsx по статическим импортам), считаются общими: их вызовы
 * принадлежат ядру, а не странице, иначе любая страница «использовала» бы всё подряд.
 *
 * Результат пишется в server/ts/featureMap.generated.ts.
 * `node scripts/ts/genFeatureMap.mts` — перегенерировать, `--check` — только проверить
 * (тест tests/featureMap.test.ts падает, если файлы устарели).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const SOFT_SHELL = ["lecture", "myspace", "screenshots", "automation", "bookmarks", "mind"];
const SETTINGS_FOLLOW = ["upscale", "movies", "translate", "tts", "lecture", "quicknotes", "chat-tools"];
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
function read(file) {
    try {
        return fs.readFileSync(file, "utf8");
    }
    catch {
        return "";
    }
}
function resolveImport(from, spec, src) {
    let base;
    if (spec.startsWith("@/"))
        base = path.join(src, spec.slice(2));
    else if (spec.startsWith("."))
        base = path.resolve(path.dirname(from), spec);
    else
        return null;
    for (const ext of EXTS) {
        const f = base + ext;
        if (/\.(ts|tsx)$/.test(f) && fs.existsSync(f) && fs.statSync(f).isFile())
            return f;
    }
    return null;
}
/** Импорты файла: статические без type-only; динамические — по флагу. */
function importsOf(file, text, src, dynamic) {
    const specs = [];
    const stat = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;'"]*?\sfrom\s+["']([^"']+)["']/g;
    for (const m of text.matchAll(stat))
        specs.push(m[1]);
    if (dynamic)
        for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g))
            specs.push(m[1]);
    const out = [];
    for (const s of specs) {
        const r = resolveImport(file, s, src);
        if (r)
            out.push(r);
    }
    return out;
}
function closure(roots, src, dynamic, skip) {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length) {
        const f = queue.pop();
        if (seen.has(f) || skip(f))
            continue;
        seen.add(f);
        for (const n of importsOf(f, read(f), src, dynamic))
            queue.push(n);
    }
    return seen;
}
/** Метод `api.<имя>` → префиксы роутов (первый сегмент пути) по описаниям в src/api. */
function apiMethodPrefixes(src) {
    const out = new Map();
    const dir = path.join(src, "api");
    for (const name of fs.readdirSync(dir)) {
        if (!/^api[A-Z].*\.ts$/.test(name) || /^apiTypes|^apiHttp/.test(name))
            continue;
        let cur = "";
        for (const line of read(path.join(dir, name)).split("\n")) {
            const prop = /^ {2}([A-Za-z0-9_]+)\s*[:(]/.exec(line);
            if (prop)
                cur = prop[1];
            if (!cur)
                continue;
            const set = out.get(cur) ?? new Set();
            for (const m of line.matchAll(/["'`]\/([a-z][a-z0-9-]*)(?=[/"'`?$])/g))
                set.add(m[1]);
            for (const m of line.matchAll(/\/api\/([a-z][a-z0-9-]*)/g))
                set.add(m[1]);
            if (set.size)
                out.set(cur, set);
        }
    }
    return out;
}
function prefixesIn(files, methods) {
    const out = new Set();
    const why = process.env.FEATURE_WHY;
    const add = (p, f) => {
        out.add(p);
        if (why && p === why)
            console.log(`${p} ← ${f}`);
    };
    for (const f of files) {
        // Пути импортов («@/api/client») — не вызовы API: вырезаем их до поиска «/api/<префикс>».
        const text = read(f)
            .replace(/\bfrom\s+["'][^"']*["']/g, "")
            .replace(/import\(\s*["'][^"']*["']\s*\)/g, "");
        for (const m of text.matchAll(/\bapi\.([A-Za-z0-9_]+)/g))
            for (const p of methods.get(m[1]) ?? [])
                add(p, f);
        for (const m of text.matchAll(/\/api\/([a-z][a-z0-9-]*)/g))
            add(m[1], f);
    }
    return out;
}
/** Префиксы, реально смонтированные сервером: всё остальное в `api.*` — не роуты. */
function serverMounts(root) {
    const text = read(path.join(root, "server", "ts", "index.ts"));
    // Подключения идут и прямыми app.use("/api/…"), и строками таблицы LAZY_ROUTES: ["/api/…", "файл"].
    return new Set([...text.matchAll(/(?:app\.use\(|\n\s*\[)"\/api\/([a-z0-9-]+)/g)].map((m) => m[1]));
}
export function analyze(root) {
    const src = path.join(root, "src");
    const mounts = serverMounts(root);
    const methods = apiMethodPrefixes(src);
    const app = path.join(src, "app", "App.tsx");
    const isApi = (f) => f.startsWith(path.join(src, "api") + path.sep);
    const coreFiles = closure([path.join(src, "main.tsx"), app], src, false, isApi);
    const core = new Set([...prefixesIn(coreFiles, methods)].filter((p) => mounts.has(p)));
    const pages = {};
    const loaders = read(app);
    for (const m of loaders.matchAll(/\b(\w+):\s*\(\)\s*=>\s*import\("(@\/pages\/[^"]+)"\)/g)) {
        const entry = resolveImport(app, m[2], src);
        if (!entry)
            continue;
        const files = [...closure([entry], src, true, (f) => isApi(f) || f === app)].filter((f) => !coreFiles.has(f));
        pages[m[1]] = [...prefixesIn(files, methods)].filter((p) => mounts.has(p)).sort();
    }
    return {
        core: [...core].sort(),
        pages,
        soft: SOFT_SHELL.filter((p) => core.has(p)),
        follow: SETTINGS_FOLLOW,
    };
}
function render(map) {
    const body = JSON.stringify(map, null, 2);
    return ("// АВТОГЕНЕРАЦИЯ: node scripts/ts/genFeatureMap.mts — не править вручную.\n" +
        "// Страница → префиксы серверных роутов, которыми она пользуется; core — нужны оболочке.\n" +
        `export const FEATURE_MAP: {
  core: string[];
  pages: Record<string, string[]>;
  soft: string[];
  follow: string[];
} = ${body};\n`);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const OUTS = ["server/ts/featureMap.generated.ts"];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const root = path.resolve(here, "..", "..");
    const text = render(analyze(root));
    if (process.argv.includes("--check")) {
        const stale = OUTS.filter((o) => read(path.join(root, o)).replace(/\r\n/g, "\n") !== text);
        if (stale.length) {
            console.error(`Карта функций устарела: ${stale.join(", ")}. Запустите node scripts/ts/genFeatureMap.mts`);
            process.exit(1);
        }
    }
    else {
        for (const o of OUTS)
            fs.writeFileSync(path.join(root, o), text, "utf8");
        console.log("featureMap обновлена");
    }
}
