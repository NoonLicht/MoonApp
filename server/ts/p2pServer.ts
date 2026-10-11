/**
 * P2P-синхронизация заметок: обмен файлами хранилища между двумя устройствами
 * по локальной сети (протокол и защита описаны в p2pSync.ts).
 *
 * Все функции принимают корень хранилища `root`, поэтому тестируются на
 * временных каталогах. Слушатель включается только по явной команде и по
 * умолчанию отключён; удаления между устройствами не синхронизируются.
 */
import fs from "fs";
import path from "path";
import http from "http";
import * as p2p from "./p2pSync";

const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 5000;

/* --------------------------------- Файлы --------------------------------- */

export function buildManifest(root: string): p2p.FileMeta[] {
  const out: p2p.FileMeta[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile() && p2p.safeRelPath(r)) {
        const st = fs.statSync(full);
        if (st.size > MAX_FILE) continue;
        out.push({ path: r, mtime: Math.floor(st.mtimeMs), size: st.size, hash: p2p.sha256(fs.readFileSync(full)) });
      }
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out;
}

const fullOf = (root: string, rel: string): string => path.join(root, ...rel.split("/"));

export function readNote(root: string, rel: string): Buffer | null {
  const safe = p2p.safeRelPath(rel);
  if (!safe) return null;
  const f = fullOf(root, safe);
  return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null;
}

/**
 * Записывает пришедший файл. Если на этой стороне уже есть другая версия, она
 * сохраняется копией «(конфликт …)» — данные не теряются ни при какой победе.
 */
export function writeNote(root: string, rel: string, data: Buffer, mtime: number, day = new Date().toISOString().slice(0, 10)): {
  conflictCopy: string | null;
} {
  const safe = p2p.safeRelPath(rel);
  if (!safe) throw new Error("bad_path");
  if (data.length > MAX_FILE) throw new Error("file_too_large");
  const full = fullOf(root, safe);
  let conflictCopy: string | null = null;
  if (fs.existsSync(full)) {
    const cur = fs.readFileSync(full);
    if (cur.equals(data)) return { conflictCopy: null };
    conflictCopy = p2p.conflictPath(safe, day, (p) => fs.existsSync(fullOf(root, p)));
    fs.mkdirSync(path.dirname(fullOf(root, conflictCopy)), { recursive: true });
    fs.writeFileSync(fullOf(root, conflictCopy), cur);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  if (Number.isFinite(mtime) && mtime > 0) fs.utimesSync(full, new Date(), new Date(mtime));
  return { conflictCopy };
}

/* --------------------------------- Сервер --------------------------------- */

export interface P2pServer {
  port: number;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_FILE * 2) {
        reject(new Error("too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function startServer(opts: { root: string; secret: string; port?: number; host?: string }): Promise<P2pServer> {
  const server = http.createServer(async (req, res) => {
    const fail = (code: number, msg: string): void => {
      res.writeHead(code, { "Content-Type": "text/plain" });
      res.end(msg);
    };
    try {
      const body = await readBody(req);
      const ts = Number(req.headers["x-ts"]);
      const sig = String(req.headers["x-sig"] ?? "");
      const url = req.url ?? "";
      if (!p2p.verify(opts.secret, req.method ?? "", url, ts, body, sig)) return fail(401, "unauthorized");
      const u = new URL(url, "http://x");
      if (req.method === "GET" && u.pathname === "/p2p/manifest") {
        const sealed = p2p.seal(opts.secret, Buffer.from(JSON.stringify(buildManifest(opts.root))));
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return void res.end(sealed);
      }
      if (req.method === "GET" && u.pathname === "/p2p/file") {
        const data = readNote(opts.root, u.searchParams.get("path") ?? "");
        if (!data) return fail(404, "not_found");
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return void res.end(p2p.seal(opts.secret, data));
      }
      if (req.method === "PUT" && u.pathname === "/p2p/file") {
        const data = p2p.open(opts.secret, body);
        const r = writeNote(opts.root, u.searchParams.get("path") ?? "", data, Number(u.searchParams.get("mtime")));
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ ok: true, conflictCopy: r.conflictCopy }));
      }
      fail(404, "not_found");
    } catch (e) {
      fail(400, (e as Error).message || "error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "0.0.0.0", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : opts.port ?? 0,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/* --------------------------------- Клиент --------------------------------- */

async function call(
  base: string,
  secret: string,
  method: "GET" | "PUT",
  pathAndQuery: string,
  body: Buffer = Buffer.alloc(0),
): Promise<Buffer> {
  const ts = Date.now();
  const r = await fetch(`${base}${pathAndQuery}`, {
    method,
    headers: { "x-ts": String(ts), "x-sig": p2p.sign(secret, method, pathAndQuery, ts, body) },
    body: method === "PUT" ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 401) throw new Error("wrong_key");
  if (!r.ok) throw new Error(`http_${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  same: number;
  failed: string[];
}

/** Синхронизирует `root` с удалённым устройством host:port. */
export async function syncWith(opts: { root: string; host: string; port: number; secret: string }): Promise<SyncResult> {
  const base = `http://${opts.host}:${opts.port}`;
  const remote = JSON.parse(
    p2p.open(opts.secret, await call(base, opts.secret, "GET", "/p2p/manifest")).toString("utf8"),
  ) as p2p.FileMeta[];
  const plan = p2p.planSync(buildManifest(opts.root), remote.filter((f) => p2p.safeRelPath(f.path)));
  const res: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, same: plan.same, failed: [] };
  const rmeta = new Map(remote.map((f) => [f.path, f]));

  const pull = async (rel: string): Promise<void> => {
    const sealed = await call(base, opts.secret, "GET", `/p2p/file?path=${encodeURIComponent(rel)}`);
    writeNote(opts.root, rel, p2p.open(opts.secret, sealed), rmeta.get(rel)?.mtime ?? Date.now());
  };
  const push = async (rel: string): Promise<void> => {
    const data = readNote(opts.root, rel);
    if (!data) return;
    const st = fs.statSync(fullOf(opts.root, rel));
    await call(
      base,
      opts.secret,
      "PUT",
      `/p2p/file?path=${encodeURIComponent(rel)}&mtime=${Math.floor(st.mtimeMs)}`,
      p2p.seal(opts.secret, data),
    );
  };

  for (const rel of plan.pull) {
    try {
      await pull(rel);
      res.pulled++;
    } catch (e) {
      res.failed.push(`${rel}: ${(e as Error).message}`);
    }
  }
  for (const rel of plan.push) {
    try {
      await push(rel);
      res.pushed++;
    } catch (e) {
      res.failed.push(`${rel}: ${(e as Error).message}`);
    }
  }
  for (const c of plan.conflicts) {
    try {
      // победитель — более свежая версия; версия проигравшего сохраняется копией на принимающей стороне
      if (c.winner === "remote") await pull(c.path);
      else await push(c.path);
      res.conflicts++;
    } catch (e) {
      res.failed.push(`${c.path}: ${(e as Error).message}`);
    }
  }
  return res;
}
