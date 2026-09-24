import { useEffect, useState, useCallback } from "react";
import { ListChecks, X, Pause, Play, Square } from "lucide-react";
import { Btn, Badge, ProgressBar, EmptyHint } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TmTask } from "@/api/types";

/**
 * Диспетчер фоновых задач — единый список активных job'ов всех "тяжёлых"
 * движков приложения (компрессия, апскейл, озвучка, лекции, веб-архиватор),
 * с возможностью отменить/приостановить каждую.
 *
 * Зачем: раньше прогресс каждой задачи был виден только на её собственной
 * странице — если пользователь запускал апскейл и уходил в другой раздел, он
 * не видел, что вообще происходит в фоне, а остановить долгую задачу можно
 * было не отовсюду (см. AUDIT_REPORT.md, раздел 10). Опрос — раз в 2 секунды,
 * пока попап открыт (это лёгкий GET, агрегирующий уже посчитанное состояние
 * каждого движка — не создаёт дополнительной нагрузки).
 */
export default function TaskManagerPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<TmTask[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.bgTasksList();
      setTasks(r.tasks);
    } catch {
      /* бэкенд мог быть занят долгим синхронным шагом — подождём следующего тика */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);

  const active = tasks.filter((tsk) => !tsk.done);
  const finished = tasks.filter((tsk) => tsk.done).slice(0, 10);

  const run = async (fn: () => Promise<unknown>, key: string) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
  };

  const engineLabel = (engine: string): string => {
    const key = `taskmgr.engine.${engine}`;
    const label = t(key);
    return label === key ? engine : label;
  };

  return (
    <div
      className="proxy-panel-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="proxy-panel">
        <div className="proxy-panel-header">
          <div className="proxy-panel-title">
            <span className="proxy-shield">
              <ListChecks size={18} strokeWidth={2} />
            </span>
            <div className="proxy-title-text">
              <div className="proxy-eyebrow">{t("taskmgr.eyebrow")}</div>
              <div className="proxy-h1">{t("taskmgr.title")}</div>
            </div>
          </div>
          <button className="proxy-panel-close" onClick={onClose} title={t("common.close")}>
            <X size={15} />
          </button>
        </div>

        {!!error && <div className="proxy-error">{error}</div>}

        {!active.length && !finished.length && (
          <EmptyHint icon={ListChecks} text={t("taskmgr.empty")} />
        )}

        {!!active.length && (
          <div className="task-mgr-section">
            <div className="task-mgr-section-title">{t("taskmgr.active")}</div>
            {active.map((tsk) => (
              <div className="task-mgr-row" key={`${tsk.engine}:${tsk.id}`}>
                <div className="task-mgr-row-top">
                  <Badge tone="violet" mono>
                    {engineLabel(tsk.engine)}
                  </Badge>
                  <span className="task-mgr-label" title={tsk.label}>
                    {tsk.label}
                  </span>
                  <span className="muted-sm">{tsk.stage}</span>
                </div>
                {tsk.progress >= 0 && <ProgressBar value={tsk.progress} />}
                <div className="task-mgr-row-actions">
                  {tsk.canPause && (
                    <Btn
                      icon={tsk.paused ? Play : Pause}
                      disabled={busy === `${tsk.engine}:${tsk.id}`}
                      onClick={() =>
                        void run(
                          () =>
                            tsk.paused
                              ? api.bgTasksResume(tsk.engine, tsk.id)
                              : api.bgTasksPause(tsk.engine, tsk.id),
                          `${tsk.engine}:${tsk.id}`,
                        )
                      }
                    >
                      {tsk.paused ? t("taskmgr.resume") : t("taskmgr.pause")}
                    </Btn>
                  )}
                  {tsk.canCancel && (
                    <Btn
                      variant="danger"
                      icon={Square}
                      disabled={busy === `${tsk.engine}:${tsk.id}`}
                      onClick={() => void run(() => api.bgTasksCancel(tsk.engine, tsk.id), `${tsk.engine}:${tsk.id}`)}
                    >
                      {t("taskmgr.cancel")}
                    </Btn>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {!!finished.length && (
          <div className="task-mgr-section">
            <div className="task-mgr-section-title">{t("taskmgr.recent")}</div>
            {finished.map((tsk) => (
              <div className="task-mgr-row is-done" key={`${tsk.engine}:${tsk.id}`}>
                <div className="task-mgr-row-top">
                  <Badge tone="neutral" mono>
                    {engineLabel(tsk.engine)}
                  </Badge>
                  <span className="task-mgr-label" title={tsk.label}>
                    {tsk.label}
                  </span>
                  <span className={`muted-sm ${tsk.error ? "task-mgr-err" : ""}`}>
                    {tsk.error ? tsk.error : t("taskmgr.done")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
