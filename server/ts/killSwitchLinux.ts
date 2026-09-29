/**
 * Kill-switch — Linux-реализация. Тот же контракт и то же поведение, что в
 * killSwitchWin.ts (см. подробное обоснование ограничений там же — оно
 * одинаково применимо и здесь): если ядро прокси (sing-box, proxyCore.js)
 * перестаёт отвечать, пока kill-switch взведён, блокируется ВЕСЬ исходящий
 * трафик, снимает блокировку только явный disarm(), а startupCleanup()
 * подчищает правило, оставшееся от аварийно завершённого предыдущего запуска.
 *
 * На Windows это делает netsh advfirewall, здесь — nftables (предпочтительно,
 * есть на всех современных дистрибутивах с systemd) с фолбэком на iptables,
 * если `nft` не найден в PATH (некоторые дистрибутивы/старые ядра). Оба пути
 * требуют root — элевация здесь устроена иначе, чем UAC на Windows: приложение
 * не может само запросить sudo-пароль в GUI-диалоге, поэтому вызовы идут через
 * `pkexec` (стандартный Polkit-агент, показывает системный диалог с паролем
 * пользователя почти на любом Linux-DE) — это ближайший аналог UAC, доступный
 * без установки собственного демона с постоянными правами.
 */
import { execFile } from "child_process";
import logger from "./logger";

const RULE_COMMENT = "moonapp-killswitch";
// Отдельная таблица/цепочка nftables — не трогаем правила пользователя и
// других приложений, снимаем ровно то, что добавили сами.
const NFT_TABLE = "moonapp_killswitch";
const IPT_CHAIN = "MOONAPP_KILLSWITCH";

let armed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastError = "";
const POLL_MS = 4000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyCore = require("./proxyCore") as { getCoreStatus(): { running: boolean } };

function execFileAsync(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

/** Есть ли в PATH рабочий `nft` — если нет, работаем через iptables-фолбэк. */
async function hasNft(): Promise<boolean> {
  const r = await execFileAsync("nft", ["--version"]);
  return r.ok;
}

/**
 * Элевация через pkexec: показывает системный диалог Polkit с запросом
 * пароля. В отличие от Windows UAC, здесь нет отдельного модуля elevate —
 * pkexec делает то же самое одной внешней командой без обвязки в проекте.
 */
async function runPrivileged(cmd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  const r = await execFileAsync("pkexec", [cmd, ...args]);
  if (!r.ok) return { ok: false, error: r.stderr || "elevation_failed" };
  return { ok: true };
}

async function nftRuleExists(): Promise<boolean> {
  const r = await execFileAsync("nft", ["list", "table", "inet", NFT_TABLE]);
  return r.ok;
}

async function iptRuleExists(): Promise<boolean> {
  // -C проверяет наличие конкретного правила кодом выхода, без парсинга текста
  // (аналогично тому, как killSwitchWin.ts определяет наличие правила netsh).
  const r = await execFileAsync("iptables", ["-C", "OUTPUT", "-j", IPT_CHAIN]);
  return r.ok;
}

async function ruleExists(): Promise<boolean> {
  return (await hasNft()) ? nftRuleExists() : iptRuleExists();
}

/**
 * Блокирующее правило: весь исходящий трафик, кроме loopback (иначе рвётся
 * связь самого приложения со своим локальным API-сервером на 127.0.0.1).
 * Так же, как и на Windows, сознательно НЕ делаем allow-list для процесса
 * sing-box — надёжный allow-list для одного процесса на Linux потребовал бы
 * cgroup-классификации/eBPF, что несопоставимо по риску с задачей.
 */
async function installBlockRuleNft(): Promise<{ ok: boolean; error?: string }> {
  const script = [
    `add table inet ${NFT_TABLE}`,
    `add chain inet ${NFT_TABLE} output { type filter hook output priority 0 ; policy accept ; }`,
    `add rule inet ${NFT_TABLE} output oif lo accept`,
    `add rule inet ${NFT_TABLE} output comment "${RULE_COMMENT}" drop`,
  ].join("\n");
  // `nft -f -` умеет читать скрипт из stdin, но наш execFileAsync-хелпер не
  // прокидывает stdin, а pkexec в любом случае требует отдельного процесса —
  // проще и надёжнее один раз сбросить скрипт во временный файл и передать
  // его путь через -f.
  const { writeFileSync, unlinkSync } = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const tmp = path.join(os.tmpdir(), `moonapp-killswitch-${Date.now()}.nft`);
  writeFileSync(tmp, script, "utf8");
  try {
    return await runPrivileged("nft", ["-f", tmp]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* временный файл, не критично */
    }
  }
}

async function removeBlockRuleNft(): Promise<{ ok: boolean; error?: string }> {
  if (!(await nftRuleExists())) return { ok: true };
  return runPrivileged("nft", ["delete", "table", "inet", NFT_TABLE]);
}

async function installBlockRuleIpt(): Promise<{ ok: boolean; error?: string }> {
  // Создаём отдельную цепочку и подключаем её к OUTPUT — так же просто
  // распознаётся и снимается целиком, как таблица nftables выше.
  // Может уже существовать с прошлого раза — код выхода намеренно игнорируем.
  await runPrivileged("iptables", ["-N", IPT_CHAIN]);
  const jump = await execFileAsync("iptables", ["-C", "OUTPUT", "-j", IPT_CHAIN]);
  if (!jump.ok) {
    const r = await runPrivileged("iptables", ["-I", "OUTPUT", "-j", IPT_CHAIN]);
    if (!r.ok) return r;
  }
  await runPrivileged("iptables", ["-A", IPT_CHAIN, "-o", "lo", "-j", "ACCEPT"]);
  const r2 = await runPrivileged("iptables", ["-A", IPT_CHAIN, "-j", "DROP", "-m", "comment", "--comment", RULE_COMMENT]);
  return r2;
}

async function removeBlockRuleIpt(): Promise<{ ok: boolean; error?: string }> {
  if (!(await iptRuleExists())) return { ok: true };
  await runPrivileged("iptables", ["-D", "OUTPUT", "-j", IPT_CHAIN]);
  const r = await runPrivileged("iptables", ["-F", IPT_CHAIN]);
  await runPrivileged("iptables", ["-X", IPT_CHAIN]);
  return r;
}

async function installBlockRule(): Promise<{ ok: boolean; error?: string }> {
  if (await ruleExists()) return { ok: true };
  const r = (await hasNft()) ? await installBlockRuleNft() : await installBlockRuleIpt();
  if (!r.ok) {
    logger.error("killSwitch.install_failed", { error: r.error });
    return r;
  }
  logger.warn("killSwitch.engaged", {});
  return { ok: true };
}

async function removeBlockRule(): Promise<{ ok: boolean; error?: string }> {
  const r = (await hasNft()) ? await removeBlockRuleNft() : await removeBlockRuleIpt();
  if (!r.ok) {
    logger.error("killSwitch.remove_failed", { error: r.error });
    return r;
  }
  logger.info("killSwitch.disengaged", {});
  return { ok: true };
}

async function tick(): Promise<void> {
  if (!armed) return;
  try {
    const running = proxyCore.getCoreStatus().running;
    if (!running) {
      const r = await installBlockRule();
      if (!r.ok) lastError = r.error || "install_failed";
    }
    // См. killSwitchWin.ts: намеренно не снимаем блокировку автоматически.
  } catch (e) {
    lastError = (e as Error).message;
  }
}

export function arm(): void {
  if (armed) return;
  armed = true;
  lastError = "";
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void tick(), POLL_MS);
  void tick();
}

export async function disarm(): Promise<{ ok: boolean; error?: string }> {
  armed = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  return removeBlockRule();
}

export interface KillSwitchStatus {
  armed: boolean;
  blocking: boolean;
  proxyRunning: boolean;
  error: string;
}

export async function status(): Promise<KillSwitchStatus> {
  return {
    armed,
    blocking: await ruleExists(),
    proxyRunning: proxyCore.getCoreStatus().running,
    error: lastError,
  };
}

export async function startupCleanup(): Promise<void> {
  try {
    if (await ruleExists()) {
      await removeBlockRule();
      logger.warn("killSwitch.startup_cleanup", { message: "removed leftover block rule from previous session" });
    }
  } catch (e) {
    logger.error("killSwitch.startup_cleanup_failed", { error: (e as Error).message });
  }
}
