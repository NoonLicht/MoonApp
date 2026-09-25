/**
 * Git-синхронизация заметок и канваса (storage/vault/) — через isomorphic-git,
 * без системного git.exe (выбор пользователя: не у всех разработчиков он
 * стоит, а тихая установка ещё одного бинарника ночью — риск).
 *
 * Область синхронизации — DIRS.vault (notes/ + holts/), это ровно то, что
 * буквально называлось "заметки и canvas". Закладки (storage/bookmarks.json)
 * НЕ включены — это отдельный плоский JSON-файл вне vault, а не часть
 * файлового дерева заметок; расширить на него — небольшая отдельная задача,
 * сознательно не делалась в спешке, чтобы не усложнять формат синка ночью.
 *
 * Конфликты: сознательно БЕЗ авто-merge (см. план) — pull только
 * fast-forward; если история разошлась, синк честно сообщает "нужен ручной
 * merge" и ничего не трогает на диске, вместо попытки 3-way merge вслепую.
 */
import fs from "fs";
import path from "path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import config from "./config";
import logger from "./logger";
import { getSecret, setSecret } from "./security";

const { DIRS, FILES } = config;
const REPO_DIR = DIRS.vault;
const GIT_TOKEN_SECRET = "git.notesRemoteToken";

export interface NotesGitConfig {
  remoteUrl: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  lastSyncAt: number | null;
}

const DEFAULT_CONFIG: NotesGitConfig = {
  remoteUrl: "",
  branch: "main",
  authorName: "MoonApp",
  authorEmail: "moonapp@localhost",
  lastSyncAt: null,
};

function readConfig(): NotesGitConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(FILES.notesGitConfig, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(cfg: NotesGitConfig): void {
  fs.writeFileSync(FILES.notesGitConfig, JSON.stringify(cfg, null, 2), "utf8");
}

export function getConfig(): NotesGitConfig & { hasToken: boolean } {
  return { ...readConfig(), hasToken: !!getSecret(GIT_TOKEN_SECRET) };
}

export function setConfig(input: {
  remoteUrl?: string;
  branch?: string;
  authorName?: string;
  authorEmail?: string;
  token?: string;
}): NotesGitConfig {
  const cur = readConfig();
  const next: NotesGitConfig = {
    ...cur,
    remoteUrl: input.remoteUrl !== undefined ? input.remoteUrl.trim() : cur.remoteUrl,
    branch: input.branch !== undefined ? input.branch.trim() || "main" : cur.branch,
    authorName: input.authorName !== undefined ? input.authorName : cur.authorName,
    authorEmail: input.authorEmail !== undefined ? input.authorEmail : cur.authorEmail,
  };
  writeConfig(next);
  if (input.token) setSecret(GIT_TOKEN_SECRET, input.token);
  return next;
}

async function ensureRepo(): Promise<void> {
  const gitDir = path.join(REPO_DIR, ".git");
  const cfg = readConfig();
  if (!fs.existsSync(gitDir)) {
    await git.init({ fs, dir: REPO_DIR, defaultBranch: cfg.branch || "main" });
    logger.info("notesGit.init", { dir: REPO_DIR });
  }
  // git.pull резолвит fetch-refspec через настроенный remote (просто передать
  // url в pull недостаточно — проверено вживую: без addRemote pull падает с
  // "Could not find a fetch refspec for remote origin"), поэтому remote
  // синхронизируется с текущим URL из настроек при каждом вызове.
  if (cfg.remoteUrl) {
    try {
      await git.addRemote({ fs, dir: REPO_DIR, remote: "origin", url: cfg.remoteUrl, force: true });
    } catch {
      /* уже настроен с тем же url — не критично */
    }
  }
}

function authCallback() {
  const token = getSecret(GIT_TOKEN_SECRET);
  if (!token) return undefined;
  // GitHub/GitLab: токен как пароль, имя пользователя — произвольное непустое значение.
  return () => ({ username: "moonapp", password: token });
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Список веток удалённого репозитория (короткое подтверждение реального доступа). */
  branches?: string[];
  /** true — репозиторий отдал ссылки БЕЗ токена (для приватного это невозможно,
   * значит либо репозиторий публичный, либо сервер даже не проверял токен). */
  usedAuth: boolean;
  error?: string;
}

/**
 * Проверка доступа к удалённому репозиторию БЕЗ затрагивания рабочей копии —
 * git.getRemoteInfo запрашивает только список ref'ов (тот же запрос, что
 * `git ls-remote`), ничего не клонирует и не пишет на диск. Кнопка "Проверить
 * подключение" в UI использует именно это — реальное подтверждение, что URL +
 * токен действительно дают доступ к приватному репозиторию, а не просто что
 * поля формы не пустые.
 */
export async function testConnection(): Promise<ConnectionTestResult> {
  const cfg = readConfig();
  if (!cfg.remoteUrl) return { ok: false, usedAuth: false, error: "no_remote_url" };
  const onAuth = authCallback();
  try {
    const info = await git.getRemoteInfo({ http, url: cfg.remoteUrl, onAuth });
    const branches = Object.keys(info.refs?.heads || {}).slice(0, 20);
    logger.info("notesGit.testConnection.ok", { url: cfg.remoteUrl, branches: branches.length });
    return { ok: true, branches, usedAuth: !!onAuth };
  } catch (e) {
    logger.warn("notesGit.testConnection.failed", { url: cfg.remoteUrl, error: (e as Error).message });
    return { ok: false, usedAuth: !!onAuth, error: (e as Error).message };
  }
}

/** Добавляет все изменённые файлы (statusMatrix) и коммитит, если есть что коммитить. */
async function stageAllAndCommit(message: string): Promise<{ committed: boolean; oid?: string }> {
  const matrix = await git.statusMatrix({ fs, dir: REPO_DIR });
  let changed = false;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === workdir && workdir === stage) continue; // без изменений
    changed = true;
    if (workdir === 0) {
      await git.remove({ fs, dir: REPO_DIR, filepath });
    } else {
      await git.add({ fs, dir: REPO_DIR, filepath });
    }
  }
  if (!changed) return { committed: false };
  const cfg = readConfig();
  const oid = await git.commit({
    fs,
    dir: REPO_DIR,
    message,
    author: { name: cfg.authorName, email: cfg.authorEmail },
  });
  logger.info("notesGit.commit", { oid, message });
  return { committed: true, oid };
}

export interface SyncResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  committed?: boolean;
  pulled?: boolean;
  pushed?: boolean;
}

/**
 * Полный цикл: закоммитить локальные изменения → pull (fast-forward-only,
 * без авто-merge) → push. Останавливается на первой проблеме и сообщает,
 * что именно нужно решить руками.
 */
export async function sync(): Promise<SyncResult> {
  const cfg = readConfig();
  if (!cfg.remoteUrl) return { ok: false, error: "remote_not_set" };

  await ensureRepo();

  const onAuth = authCallback();

  // Сначала честно узнаём, существует ли ветка на удалённой стороне — pull на
  // пустой репозиторий (первый синк) у isomorphic-git падает с непонятной
  // низкоуровневой ошибкой вместо внятного NotFoundError (проверено вживую
  // через локальный git-http-backend), поэтому не гадаем по тексту ошибки.
  let remoteBranchExists: boolean;
  try {
    const refs = await git.listServerRefs({
      http,
      url: cfg.remoteUrl,
      onAuth,
      prefix: `refs/heads/${cfg.branch}`,
    });
    remoteBranchExists = refs.some((r) => r.ref === `refs/heads/${cfg.branch}`);
  } catch (e) {
    return { ok: false, error: `remote_unreachable: ${(e as Error).message}` };
  }

  // Локальной ветки может не быть вовсе (новая машина, пустой storage/vault) —
  // тогда это не "pull поверх истории", а фактически первичное клонирование:
  // git.pull здесь не подходит (ему нечего мержить), нужен fetch + checkout.
  let localBranchExists = true;
  try {
    await git.resolveRef({ fs, dir: REPO_DIR, ref: `refs/heads/${cfg.branch}` });
  } catch {
    localBranchExists = false;
  }

  if (!localBranchExists && remoteBranchExists) {
    try {
      await git.fetch({ fs, http, dir: REPO_DIR, remote: "origin", ref: cfg.branch, singleBranch: true, onAuth });
      await git.checkout({ fs, dir: REPO_DIR, ref: cfg.branch, remote: "origin", noUpdateHead: false });
      logger.info("notesGit.initial_clone", { branch: cfg.branch });
    } catch (e) {
      return { ok: false, error: `initial_clone_failed: ${(e as Error).message}` };
    }
  }

  let committed: boolean;
  try {
    const r = await stageAllAndCommit("MoonApp: авто-синхронизация заметок");
    committed = r.committed;
  } catch (e) {
    return { ok: false, error: `commit_failed: ${(e as Error).message}` };
  }

  let pulled = false;
  if (remoteBranchExists && localBranchExists) {
    try {
      await git.pull({
        fs,
        http,
        dir: REPO_DIR,
        ref: cfg.branch,
        remote: "origin",
        remoteRef: cfg.branch,
        url: cfg.remoteUrl,
        singleBranch: true,
        fastForward: true,
        fastForwardOnly: true,
        author: { name: cfg.authorName, email: cfg.authorEmail },
        onAuth,
      });
      pulled = true;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (/Fast-?Forward/i.test(msg)) {
        logger.warn("notesGit.pull_conflict", { error: msg });
        return { ok: false, conflict: true, committed, error: "diverged_needs_manual_merge" };
      }
      return { ok: false, committed, error: `pull_failed: ${msg}` };
    }
  }

  let pushed: boolean;
  try {
    const res = await git.push({
      fs,
      http,
      dir: REPO_DIR,
      remote: "origin",
      ref: cfg.branch,
      remoteRef: cfg.branch,
      url: cfg.remoteUrl,
      onAuth,
    });
    if (res.ok !== undefined && !res.ok) {
      return { ok: false, committed, pulled, error: `push_rejected: ${res.error || ""}` };
    }
    pushed = true;
  } catch (e) {
    return { ok: false, committed, pulled, error: `push_failed: ${(e as Error).message}` };
  }

  const next = { ...cfg, lastSyncAt: Date.now() };
  writeConfig(next);
  logger.info("notesGit.sync.done", { committed, pulled, pushed });
  return { ok: true, committed, pulled, pushed };
}

export async function status(): Promise<{ dirty: boolean; files: number }> {
  await ensureRepo();
  const matrix = await git.statusMatrix({ fs, dir: REPO_DIR });
  const dirtyFiles = matrix.filter(([, head, workdir, stage]) => !(head === workdir && workdir === stage));
  return { dirty: dirtyFiles.length > 0, files: dirtyFiles.length };
}
