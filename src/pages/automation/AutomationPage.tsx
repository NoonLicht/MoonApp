import { useEffect, useState } from "react";
import { Zap, Plus, Play, Trash2, X, Save, Clock, AlertTriangle, CalendarClock } from "lucide-react";
import { Glass, Btn, Badge, EmptyHint, SectionHead, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LauncherEntry, ScheduledTask, ScheduleKind } from "@/api/types";

interface LauncherForm {
  name: string;
  exePath: string;
  args: string;
}
const EMPTY_LAUNCHER: LauncherForm = { name: "", exePath: "", args: "" };

interface TaskForm {
  name: string;
  launcherId: string;
  schedule: ScheduleKind;
  time: string;
}

export default function AutomationPage() {
  const { t } = useI18n();
  const [launchers, setLaunchers] = useState<LauncherEntry[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [showLauncherForm, setShowLauncherForm] = useState(false);
  const [launcherForm, setLauncherForm] = useState<LauncherForm>(EMPTY_LAUNCHER);
  const [savingLauncher, setSavingLauncher] = useState(false);
  const [runError, setRunError] = useState("");

  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskForm>({
    name: "",
    launcherId: "",
    schedule: "DAILY",
    time: "09:00",
  });
  const [savingTask, setSavingTask] = useState(false);
  const [taskError, setTaskError] = useState("");

  const loadLaunchers = () => {
    setLoading(true);
    api
      .automationLaunchers()
      .then(setLaunchers)
      .catch(() => setLaunchers([]))
      .finally(() => setLoading(false));
  };

  const loadTasks = () => {
    setTasksLoading(true);
    api
      .automationTasks()
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  };

  useEffect(() => {
    loadLaunchers();
    loadTasks();
  }, []);

  const saveLauncher = async () => {
    if (!launcherForm.name.trim() || !launcherForm.exePath.trim()) return;
    setSavingLauncher(true);
    try {
      await api.automationCreateLauncher({
        name: launcherForm.name.trim(),
        exePath: launcherForm.exePath.trim(),
        args: launcherForm.args.trim(),
      });
      setLauncherForm(EMPTY_LAUNCHER);
      setShowLauncherForm(false);
      loadLaunchers();
    } finally {
      setSavingLauncher(false);
    }
  };

  const removeLauncher = async (id: string) => {
    await api.automationDeleteLauncher(id);
    loadLaunchers();
  };

  const runLauncher = async (l: LauncherEntry) => {
    setRunError("");
    const r = await api.automationRunLauncher(l.id);
    if (!r.ok) setRunError(`${l.name}: ${r.error}`);
  };

  const saveTask = async () => {
    if (!taskForm.name.trim() || !taskForm.launcherId) return;
    setSavingTask(true);
    setTaskError("");
    try {
      const r = await api.automationCreateTask({
        name: taskForm.name.trim(),
        launcherId: taskForm.launcherId,
        schedule: taskForm.schedule,
        time: taskForm.time,
      });
      if (!r.ok) {
        setTaskError(r.error || "error");
        return;
      }
      setTaskForm({ name: "", launcherId: "", schedule: "DAILY", time: "09:00" });
      setShowTaskForm(false);
      loadTasks();
    } finally {
      setSavingTask(false);
    }
  };

  const removeTask = async (name: string) => {
    await api.automationDeleteTask(name);
    loadTasks();
  };

  const runTaskNow = async (name: string) => {
    setTaskError("");
    const r = await api.automationRunTask(name);
    if (!r.ok) setTaskError(`${name}: ${r.error}`);
  };

  return (
    <div className="page">
      <SectionHead
        eyebrow={t("automation.eyebrow")}
        title={t("automation.title")}
        action={
          <Btn variant="primary" icon={Plus} onClick={() => setShowLauncherForm(true)}>
            {t("automation.addLauncher")}
          </Btn>
        }
      />

      {runError && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{runError}</span>
        </Glass>
      )}

      {showLauncherForm && (
        <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <input
            className="text-input"
            placeholder={t("automation.fName")}
            value={launcherForm.name}
            onChange={(e) => setLauncherForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="text-input"
            placeholder={t("automation.fExePath")}
            value={launcherForm.exePath}
            onChange={(e) => setLauncherForm((f) => ({ ...f, exePath: e.target.value }))}
          />
          <input
            className="text-input"
            placeholder={t("automation.fArgs")}
            value={launcherForm.args}
            onChange={(e) => setLauncherForm((f) => ({ ...f, args: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="primary"
              icon={Save}
              disabled={savingLauncher || !launcherForm.name.trim() || !launcherForm.exePath.trim()}
              onClick={() => void saveLauncher()}
            >
              {t("automation.save")}
            </Btn>
            <Btn icon={X} onClick={() => setShowLauncherForm(false)}>
              {t("ctx.clear")}
            </Btn>
          </div>
        </Glass>
      )}

      {loading && <div className="muted-sm">{t("passwordVault.loading")}</div>}
      {!loading && launchers.length === 0 && !showLauncherForm && (
        <EmptyHint icon={Zap} text={t("automation.emptyLaunchers")} />
      )}

      <div className="automation-grid">
        {launchers.map((l) => (
          <Glass key={l.id} className="automation-card">
            <div className="automation-card-head">
              <Zap size={16} />
              <div className="automation-card-name" title={l.name}>
                {l.name}
              </div>
            </div>
            <div className="muted-sm automation-card-path" title={l.exePath}>
              {l.exePath}
              {l.args ? ` ${l.args}` : ""}
            </div>
            <div className="automation-card-actions">
              <Btn icon={Play} onClick={() => void runLauncher(l)}>
                {t("automation.run")}
              </Btn>
              <Btn icon={Trash2} onClick={() => void removeLauncher(l.id)}>
                {t("ctx.remove")}
              </Btn>
            </div>
          </Glass>
        ))}
      </div>

      <SectionHead
        eyebrow={t("automation.tasksEyebrow")}
        title={t("automation.tasksTitle")}
        action={
          <Btn
            variant="primary"
            icon={CalendarClock}
            disabled={launchers.length === 0}
            onClick={() => setShowTaskForm(true)}
          >
            {t("automation.addTask")}
          </Btn>
        }
      />
      {launchers.length === 0 && <div className="muted-sm">{t("automation.needLauncherForTask")}</div>}

      {taskError && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{taskError}</span>
        </Glass>
      )}

      {showTaskForm && (
        <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <input
            className="text-input"
            placeholder={t("automation.fTaskName")}
            value={taskForm.name}
            onChange={(e) => setTaskForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Select
            value={taskForm.launcherId}
            onChange={(e) => setTaskForm((f) => ({ ...f, launcherId: e.target.value }))}
            options={[
              { value: "", label: t("automation.pickLauncher") },
              ...launchers.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
          <Select
            value={taskForm.schedule}
            onChange={(e) => setTaskForm((f) => ({ ...f, schedule: e.target.value as ScheduleKind }))}
            options={[
              { value: "DAILY", label: t("automation.scheduleDaily") },
              { value: "HOURLY", label: t("automation.scheduleHourly") },
              { value: "ONLOGON", label: t("automation.scheduleOnLogon") },
              { value: "ONSTART", label: t("automation.scheduleOnStart") },
            ]}
          />
          {taskForm.schedule === "DAILY" && (
            <input
              type="time"
              className="text-input"
              value={taskForm.time}
              onChange={(e) => setTaskForm((f) => ({ ...f, time: e.target.value }))}
            />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="primary"
              icon={Save}
              disabled={savingTask || !taskForm.name.trim() || !taskForm.launcherId}
              onClick={() => void saveTask()}
            >
              {t("automation.save")}
            </Btn>
            <Btn icon={X} onClick={() => setShowTaskForm(false)}>
              {t("ctx.clear")}
            </Btn>
          </div>
        </Glass>
      )}

      {tasksLoading && <div className="muted-sm">{t("passwordVault.loading")}</div>}
      {!tasksLoading && tasks.length === 0 && !showTaskForm && (
        <EmptyHint icon={Clock} text={t("automation.emptyTasks")} />
      )}

      <div className="automation-tasklist">
        {tasks.map((tk) => (
          <Glass key={tk.name} className="automation-task-row">
            <div className="automation-task-info">
              <div className="automation-card-name">{tk.name}</div>
              <div className="muted-sm">
                {tk.nextRun ? `${t("automation.nextRun")}: ${tk.nextRun}` : ""}
              </div>
            </div>
            {tk.status && <Badge tone="neutral">{tk.status}</Badge>}
            <div className="automation-card-actions">
              <Btn icon={Play} onClick={() => void runTaskNow(tk.name)}>
                {t("automation.run")}
              </Btn>
              <Btn icon={Trash2} onClick={() => void removeTask(tk.name)}>
                {t("ctx.remove")}
              </Btn>
            </div>
          </Glass>
        ))}
      </div>
    </div>
  );
}
