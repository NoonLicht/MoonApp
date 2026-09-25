/**
 * Kill-switch: если ядро прокси (sing-box, server/proxyCore.js) внезапно
 * перестаёт работать, пока kill-switch взведён, блокируется ВЕСЬ исходящий
 * трафик через правило Windows Firewall — чтобы приложения, рассчитывавшие
 * на прокси, не «утекли» напрямую с реальным IP.
 *
 * ЧЕСТНЫЕ ОГРАНИЧЕНИЯ (сознательный выбор, не забытая деталь):
 *  1. Простое правило netsh advfirewall "block all" НЕ может одновременно
 *     разрешить исходящий трафик только для sing-box.exe: в Windows Firewall
 *     БЛОКИРУЮЩЕЕ правило всегда побеждает разрешающее при конфликте — надёжный
 *     «allow-list для одного процесса» требует WFP-драйвера уровня ядра,
 *     которого в проекте нет и которым ночью, без возможности живого теста на
 *     чужой сети, рисковать нельзя. Поэтому блокировка — это ДЕЙСТВИТЕЛЬНО
 *     весь трафик, включая попытки самого sing-box переподключиться. Снять
 *     блокировку может только явное действие пользователя (disarm) — это не
 *     баг, а осознанное решение: тихое самовосстановление в момент попытки
 *     реконнекта обесценило бы смысл kill-switch.
 *  2. Правило НЕ переживает перезапуск сервера: при старте приложения любое
 *     оставшееся правило блокировки автоматически снимается (см. startupCleanup).
 *     Иначе баг или падение процесса между сессиями мог бы НАВСЕГДА заблокировать
 *     интернет пользователю без явного способа исправить это, кроме ручного
 *     `netsh advfirewall firewall delete rule name=...` в консоли. Обратная
 *     сторона: если приложение закрыто силой (не штатным выходом) во время
 *     активной блокировки, защита не переживает перезапуск приложения — честно
 *     показано в UI.
 */
import { execFile } from "child_process";
import logger from "./logger";
import { runElevated } from "./elevate";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyCore = require("./proxyCore") as {
  getCoreStatus(): { running: boolean };
};

const RULE_NAME = "MoonApp-KillSwitch-Block";
const POLL_MS = 4000;

let armed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastError = "";

function execFileAsync(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

/**
 * Проверка "есть ли правило" НЕ требует прав администратора и работает без
 * элевации. Важно: определяем по КОДУ ВЫХОДА (0 — правило есть, 1 — нет), а
 * не по тексту stdout — netsh выводит текст на языке системы ("No rules
 * match..." на английской, "Ни одно правило не соответствует..." на русской
 * Windows), парсинг конкретной строки сломался бы на нерусской/неанглийской
 * локали.
 */
async function ruleExists(): Promise<boolean> {
  const { ok } = await execFileAsync("netsh", ["advfirewall", "firewall", "show", "rule", `name=${RULE_NAME}`]);
  return ok;
}

/**
 * add/delete правила firewall требуют прав администратора — используем тот
 * же UAC-паттерн (Start-Process -Verb RunAs), что уже применяется в проекте
 * для zapret/WinDivert (см. server/ts/elevate.ts). Каждый вызов показывает
 * пользователю диалог UAC — это ожидаемо для операции такого уровня.
 */
async function installBlockRule(): Promise<{ ok: boolean; error?: string }> {
  if (await ruleExists()) return { ok: true };
  const r = await runElevated(
    "netsh",
    ["advfirewall", "firewall", "add", "rule", `name=${RULE_NAME}`, "dir=out", "action=block", "enable=yes", "profile=any"],
    { timeoutMs: 30000 },
  );
  if (!r.ok) {
    logger.error("killSwitch.install_failed", { error: r.error });
    return { ok: false, error: r.error || "elevation_failed" };
  }
  logger.warn("killSwitch.engaged", {});
  return { ok: true };
}

async function removeBlockRule(): Promise<{ ok: boolean; error?: string }> {
  if (!(await ruleExists())) return { ok: true };
  const r = await runElevated("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${RULE_NAME}`], {
    timeoutMs: 30000,
  });
  if (!r.ok) {
    logger.error("killSwitch.remove_failed", { error: r.error });
    return { ok: false, error: r.error || "elevation_failed" };
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
    // Намеренно НЕ снимаем блокировку здесь, даже если running снова true —
    // см. пункт 1 в шапке файла: авто-восстановление в момент реконнекта
    // обесценивает смысл kill-switch. Снятие — только через disarm().
  } catch (e) {
    lastError = (e as Error).message;
  }
}

/** Взвести kill-switch: начинает следить за состоянием ядра прокси. */
export function arm(): void {
  if (armed) return;
  armed = true;
  lastError = "";
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void tick(), POLL_MS);
  void tick();
}

/** Снять взвод И убрать блокировку (если она была установлена). */
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

/**
 * Вызывается один раз при старте сервера: снимает любое правило блокировки,
 * оставшееся от предыдущего запуска (крэш/аварийное завершение) — см. пункт 2
 * в шапке файла. armed при старте всегда false (не персистится намеренно).
 */
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
