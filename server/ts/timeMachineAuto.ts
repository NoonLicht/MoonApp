/**
 * Автоснимки для «Машины времени»: раз в intervalHours часов (и через минуту
 * после запуска) коммитит изменения vault в локальный git-репозиторий.
 * Сеть не нужна; удалённый репозиторий, если он настроен, не затрагивается.
 */
import logger from "./logger";
import settings from "./settings";
import * as notesGit from "./notesGit";

let timer: NodeJS.Timeout | null = null;

async function run(): Promise<void> {
  const cfg = settings.get("timeMachine") ?? {};
  if (cfg.enabled === false) return;
  try {
    const r = await notesGit.snapshot();
    if (r.committed) logger.info("timeMachine.snapshot", { oid: r.oid });
  } catch (e) {
    logger.warn("timeMachine.snapshot_failed", { error: (e as Error).message });
  }
}

export function startAuto(): void {
  if (timer) return;
  const first = setTimeout(() => void run(), 60_000);
  first.unref?.();
  const hours = Math.max(1, Number(settings.get("timeMachine")?.intervalHours) || 6);
  timer = setInterval(() => void run(), hours * 3_600_000);
  timer.unref?.();
}

export function stopAuto(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
