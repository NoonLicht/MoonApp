import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api } from "../api/client";
import type { TaskItem, TaskChecklistItem, TaskCreatePayload, TaskStatus, TaskPriority } from "../api/types";
import {
  Check, Plus, X, Clock, Calendar, Tag, Trash2, Play, Pause,
  GripVertical, Filter, Search, List, Columns, CalendarDays,
  Focus, Star, TrendingUp, ChevronDown, ChevronRight,
  AlertCircle, ArrowUp, ArrowDown
} from "lucide-react";

/* ---------- types ---------- */
interface TasksPanelProps {
  onOpenNote?: (path: string) => void;
  vaultFiles?: string[];
}

interface ParsedChip {
  type: string;
  value: string;
}

type ViewMode = "list" | "kanban" | "calendar";
type SmartFilter = "all" | "today" | "upcoming" | "overdue" | "high";

interface SortConfig {
  key: string;
  direction: "asc" | "desc";
}

/* ---------- helpers ---------- */
const ChevronLeft = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const tabStyle = (active: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 4,
  padding: "5px 12px", borderRadius: 6, fontSize: 12,
  fontWeight: active ? 600 : 400,
  background: active ? "var(--glass)" : "transparent",
  border: "none",
  color: active ? "var(--text-primary)" : "var(--text-secondary)",
  cursor: "pointer", transition: "all 0.15s",
});

const btnBadge: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  padding: "4px 8px", borderRadius: 6, fontSize: 11,
  border: "1px solid var(--glass-border)", cursor: "pointer",
  color: "var(--text-secondary)",
};

const priorityColor = (p: TaskPriority): string => {
  if (p === "urgent") return "var(--coral)";
  if (p === "high") return "var(--amber)";
  if (p === "medium") return "#e8b83a";
  return "var(--text-tertiary)";
};

const statusLabel: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  deferred: "Deferred",
  completed: "Completed",
};

const statusColor = (s: TaskStatus): string => {
  const map: Record<TaskStatus, string> = {
    todo: "var(--text-secondary)",
    in_progress: "var(--amber)",
    deferred: "var(--violet)",
    completed: "var(--teal)",
  };
  return map[s] || "var(--text-secondary)";
};

function formatTimer(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ================================================================
   COMPONENT
   ================================================================ */
const TasksPanel: React.FC<TasksPanelProps> = ({ onOpenNote, vaultFiles }) => {
  /* ----- state ----- */
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [focusMode, setFocusMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterTag, setFilterTag] = useState<string>("");
  const [filterProject, setFilterProject] = useState<string>("");
  const [filterSmart, setFilterSmart] = useState<SmartFilter>("all");
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [quickAddText, setQuickAddText] = useState("");
  const [parsedChips, setParsedChips] = useState<ParsedChip[]>([]);
  const [streakCount, setStreakCount] = useState(0);
  const [weeklyData, setWeeklyData] = useState<number[]>([]);
  const [points, setPoints] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerTaskId, setTimerTaskId] = useState<string | null>(null);
  const [timerElapsed, setTimerElapsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "created_at", direction: "desc" });
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().getMonth());
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const [checkedDays, setCheckedDays] = useState<Set<string>>(new Set());
/* ----- load tasks on mount ----- */
  useEffect(() => {
    api.tasksList().then(setTasks).catch(() => {});
    loadStreakAndProgress();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- derived data ----- */

  /* ----- derived data ----- */
  const tags = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach(t => t.tags?.forEach(tg => s.add(tg)));
    return Array.from(s).sort();
  }, [tasks]);

  const projects = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach(t => { if (t.projectId) s.add(t.projectId); });
    return Array.from(s).sort();
  }, [tasks]);

  /* ----- filtering logic ----- */
  const filteredTasks = useMemo(() => {
    let list = [...tasks];

    if (focusMode) {
      const threeDays = new Date();
      threeDays.setDate(threeDays.getDate() + 3);
      list = list.filter(t =>
        (t.priority === "high" || t.priority === "urgent") &&
        (t.dueDate && new Date(t.dueDate) <= threeDays)
      );
      list = list.slice(0, 5);
      return list;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.tags?.some(tg => tg.toLowerCase().includes(q))
      );
    }

    if (filterStatus) {
      list = list.filter(t => t.status === filterStatus);
    }

    if (filterTag) {
      list = list.filter(t => t.tags?.includes(filterTag));
    }

    if (filterProject) {
      list = list.filter(t => t.projectId === filterProject);
    }

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);

    switch (filterSmart) {
      case "today":
        list = list.filter(t =>
          t.dueDate && new Date(t.dueDate).toDateString() === now.toDateString()
        );
        break;
      case "upcoming":
        list = list.filter(t =>
          t.dueDate &&
          new Date(t.dueDate) >= now &&
          new Date(t.dueDate) <= endOfWeek
        );
        break;
      case "overdue":
        list = list.filter(t =>
          t.status !== "completed" && t.dueDate && new Date(t.dueDate) < now
        );
        break;
      case "high":
        list = list.filter(t => t.priority === "high" || t.priority === "urgent");
        break;
    }

    return list;
  }, [tasks, searchQuery, filterStatus, filterTag, filterProject, filterSmart, focusMode]);

  const sortedTasks = useMemo(() => {
    const list = [...filteredTasks];
    const dir = sortConfig.direction === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let va: any = a[sortConfig.key as keyof TaskItem] ?? "";
      let vb: any = b[sortConfig.key as keyof TaskItem] ?? "";
      if (typeof va === "string") va = va.toLowerCase();
      if (typeof vb === "string") vb = vb.toLowerCase();
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return 0;
    });
    return list;
  }, [filteredTasks, sortConfig]);

  /* ----- counts for smart filter sidebar ----- */
  const countForFilter = useCallback((key: string): number => {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);

    switch (key) {
      case "today":
        return tasks.filter(t =>
          t.dueDate && new Date(t.dueDate).toDateString() === now.toDateString()
        ).length;
      case "upcoming":
        return tasks.filter(t =>
          t.dueDate && new Date(t.dueDate) >= now && new Date(t.dueDate) <= endOfWeek
        ).length;
      case "overdue":
        return tasks.filter(t =>
          t.status !== "completed" && t.dueDate && new Date(t.dueDate) < now
        ).length;
      case "high":
        return tasks.filter(t => t.priority === "high" || t.priority === "urgent").length;
      default:
        return tasks.length;
    }
  }, [tasks]);

  /* ----- data loading ----- */
  const loadStreakAndProgress = useCallback(async () => {
    try {
      const data = localStorage.getItem("tasks_progress");
      if (data) {
        const parsed = JSON.parse(data);
        setStreakCount(parsed.streak || 0);
        setWeeklyData(parsed.weekly || [0, 0, 0, 0, 0, 0, 0]);
        setPoints(parsed.points || 0);
      }
    } catch { /* ignore */ }
  }, []);

  /* ----- NLP parsing ----- */
  const parseQuickAdd = useCallback((text: string) => {
    const chips: ParsedChip[] = [];
    const linkMatch = text.match(/@(\w[\w.-]*)/g);
    if (linkMatch) linkMatch.forEach(m => chips.push({ type: "link", value: m.slice(1) }));
    const tagMatch = text.match(/#(\w[\w-]*)/g);
    if (tagMatch) tagMatch.forEach(m => chips.push({ type: "tag", value: m.slice(1) }));
    const prioMatch = text.match(/!(high|urgent|medium|low|высокий|срочный|средний|низкий)\b/gi);
    if (prioMatch) prioMatch.forEach(m => {
      const v = m.slice(1).toLowerCase();
      if (v === "высокий" || v === "срочный") chips.push({ type: "priority", value: v === "срочный" ? "urgent" : "high" });
      else if (v === "средний") chips.push({ type: "priority", value: "medium" });
      else if (v === "низкий") chips.push({ type: "priority", value: "low" });
      else chips.push({ type: "priority", value: v });
    });
    const relMatch = text.match(/\b(today|tomorrow|next monday|next tuesday|next wednesday|next thursday|next friday|next saturday|next sunday|сегодня|завтра|следующий понедельник|следующий вторник|следующая среда|следующий четверг|следующая пятница|следующая суббота|следующее воскресенье)\b/gi);
    if (relMatch) relMatch.forEach(m => chips.push({ type: "date", value: m.toLowerCase() }));
    const timeMatch = text.match(/\b(\d{1,2}:\d{2})\b/g);
    if (timeMatch) timeMatch.forEach(m => chips.push({ type: "time", value: m }));
    const projMatch = text.match(/\+(project|folder):(\w[\w-]*)/gi);
    if (projMatch) projMatch.forEach(m => {
      const parts = m.split(":");
      chips.push({ type: "project", value: parts[1] });
    });
    setParsedChips(chips);
  }, []);

  const handleQuickAddChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuickAddText(v);
    parseQuickAdd(v);
  }, [parseQuickAdd]);

/* ----- progress updater (declared BEFORE quick-add to avoid TDZ) ----- */
  const updateProgress = useCallback((increment: number) => {
    try {
      const data = localStorage.getItem("tasks_progress");
      let prog = data ? JSON.parse(data) : { streak: 0, weekly: [0, 0, 0, 0, 0, 0, 0], points: 0, lastDate: null };

      const today = new Date().toDateString();
      if (prog.lastDate !== today) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        if (prog.lastDate === yesterday.toDateString()) {
          prog.streak += increment;
        } else {
          prog.streak = increment;
        }
        prog.lastDate = today;
      } else {
        prog.streak += increment;
      }

      const dayOfWeek = new Date().getDay();
      prog.weekly[dayOfWeek] = (prog.weekly[dayOfWeek] || 0) + increment;
      prog.points = (prog.points || 0) + increment * 10;

      localStorage.setItem("tasks_progress", JSON.stringify(prog));
      setStreakCount(prog.streak);
      setWeeklyData(prog.weekly);
      setPoints(prog.points);
    } catch { /* ignore */ }
  }, []);

  /* ----- quick add create ----- */
  /* ----- quick add create ----- */
  const handleQuickAddCreate = useCallback(async () => {
    if (!quickAddText.trim()) return;
    try {
      let title = quickAddText.trim();
      let priority: TaskPriority | undefined;
      let dueDate: string | undefined;
      let tags: string[] | undefined;

      const prioMatch = title.match(/!(high|urgent|medium|low)\b/i);
      if (prioMatch) {
        priority = prioMatch[1].toLowerCase() as TaskPriority;
        title = title.replace(prioMatch[0], "").trim();
      }

      const tagMatch = title.match(/#(\w[\w-]*)/g);
      if (tagMatch) {
        tags = tagMatch.map(m => m.slice(1));
        title = title.replace(/#(\w[\w-]*)/g, "").trim();
      }

      const relMatch = title.match(/\b(today|tomorrow|next monday|next tuesday|next wednesday|next thursday|next friday|next saturday|next sunday)\b/gi);
      if (relMatch) {
        const rel = relMatch[0].toLowerCase();
        const d = new Date();
        if (rel === "today" || rel === "сегодня") { /* keep today */ }
        else if (rel === "tomorrow" || rel === "завтра") d.setDate(d.getDate() + 1);
        else {
          const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
          const targetDay = days.indexOf(rel.replace("next ", ""));
          if (targetDay >= 0) {
            const currentDay = d.getDay();
            let diff = targetDay - currentDay;
            if (diff <= 0) diff += 7;
            d.setDate(d.getDate() + diff);
          }
        }
        dueDate = d.toISOString().split("T")[0];
        title = title.replace(relMatch[0], "").trim();
      }

      const payload: TaskCreatePayload = {
        title: title || quickAddText.trim(),
        priority,
        dueDate,
        tags,
      };

      const created = await api.tasksCreate(payload);
      setTasks(prev => [created, ...prev]);
      setQuickAddText("");
      setParsedChips([]);
      updateProgress(1);
    } catch (e: any) {
      console.error("Failed to create task", e);
      setErrorMsg("Failed to create task");
      setTimeout(() => setErrorMsg(null), 3000);
    }
  }, [quickAddText]);

  /* ----- task actions ----- */
  const toggleTaskStatus = useCallback(async (task: TaskItem) => {
    try {
      const newStatus: TaskStatus = task.status === "completed" ? "todo" : "completed";
      const updated = await api.tasksUpdate(task.id, { status: newStatus });
      setTasks(prev => prev.map(t => t.id === task.id ? updated : t));
      if (selectedTask?.id === task.id) setSelectedTask(updated);
      if (newStatus === "completed") updateProgress(1);
    } catch (e: any) {
      console.error("Failed to toggle task", e);
      setErrorMsg("Failed to update task");
      setTimeout(() => setErrorMsg(null), 3000);
    }
  }, [selectedTask, updateProgress]);

  const updateTask = useCallback(async (id: string, data: Partial<TaskItem>) => {
    try {
      const updated = await api.tasksUpdate(id, data);
      setTasks(prev => prev.map(t => t.id === id ? updated : t));
      if (selectedTask?.id === id) setSelectedTask(updated);
    } catch (e: any) {
      console.error("Failed to update task", e);
      setErrorMsg("Failed to update task");
      setTimeout(() => setErrorMsg(null), 3000);
    }
  }, [selectedTask]);

  const deleteTask = useCallback(async (id: string) => {
    try {
      await api.tasksDelete(id);
      setTasks(prev => prev.filter(t => t.id !== id));
      if (selectedTask?.id === id) {
        setSelectedTask(null);
        setShowDetail(false);
      }
    } catch (e: any) {
      console.error("Failed to delete task", e);
      setErrorMsg("Failed to delete task");
      setTimeout(() => setErrorMsg(null), 3000);
    }
  }, [selectedTask]);

  /* ----- timer ----- */
  const handleTimerToggle = useCallback(async (taskId: string) => {
    try {
      if (timerRunning && timerTaskId === taskId) {
        const updated = await api.tasksTimer(taskId, "pause");
        setTasks(prev => prev.map(t => t.id === taskId ? updated : t));
        setTimerRunning(false);
        setTimerTaskId(null);
      } else {
        if (timerRunning && timerTaskId) {
          await api.tasksTimer(timerTaskId, "pause");
        }
        const updated = await api.tasksTimer(taskId, "start");
        setTasks(prev => prev.map(t => t.id === taskId ? updated : t));
        setTimerRunning(true);
        setTimerTaskId(taskId);
        setTimerElapsed(0);
      }
    } catch (e: any) {
      console.error("Timer error", e);
      setErrorMsg("Timer error");
      setTimeout(() => setErrorMsg(null), 3000);
    }
  }, [timerRunning, timerTaskId]);

  /* Timer tick */
  useEffect(() => {
    if (!timerRunning) return;
    const interval = setInterval(() => {
      setTimerElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [timerRunning]);

  /* ----- checklist actions ----- */
  const addChecklistItem = useCallback(async (taskId: string, text: string) => {
    if (!text.trim()) return;
    try {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      const newItem: TaskChecklistItem = {
        id: Date.now().toString(),
        text: text.trim(),
        completed: false,
      };
      const checklist = [...(task.checklist || []), newItem];
      await updateTask(taskId, { checklist });
    } catch (e: any) {
      console.error("Failed to add checklist item", e);
    }
  }, [tasks, updateTask]);

  const toggleChecklistItem = useCallback(async (taskId: string, itemId: string) => {
    try {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      const checklist = (task.checklist || []).map(item =>
        item.id === itemId ? { ...item, completed: !item.completed } : item
      );
      await updateTask(taskId, { checklist });
    } catch (e: any) {
      console.error("Failed to toggle checklist item", e);
    }
  }, [tasks, updateTask]);

  const deleteChecklistItem = useCallback(async (taskId: string, itemId: string) => {
    try {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      const checklist = (task.checklist || []).filter(item => item.id !== itemId);
      await updateTask(taskId, { checklist });
    } catch (e: any) {
      console.error("Failed to delete checklist item", e);
    }
  }, [tasks, updateTask]);

  /* ----- sort ----- */
  const handleSort = useCallback((key: string) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  const sortIndicator = (key: string): string => {
    if (sortConfig.key !== key) return "";
    return sortConfig.direction === "asc" ? " ▲" : " ▼";
  };

  /* ----- kanban ----- */
  const moveTaskStatus = useCallback((taskId: string, newStatus: TaskStatus) => {
    updateTask(taskId, { status: newStatus });
  }, [updateTask]);

  /* ----- calendar navigation ----- */
/* ----- detail drawer ----- */
  const openDetail = useCallback((task: TaskItem) => {
    setSelectedTask(task);
    setShowDetail(true);
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedTask(null);
    setShowDetail(false);
  }, []);
  const prevMonth = useCallback(() => {
    if (calendarMonth === 0) {
      setCalendarMonth(11);
      setCalendarYear(y => y - 1);
    } else {
      setCalendarMonth(m => m - 1);
    }
  }, [calendarMonth]);

  const nextMonth = useCallback(() => {
    if (calendarMonth === 11) {
      setCalendarMonth(0);
      setCalendarYear(y => y + 1);
    } else {
      setCalendarMonth(m => m + 1);
    }
  }, [calendarMonth]);

  const calendarTasks = useMemo(() => {
    const map = new Map<string, TaskItem[]>();
    tasks.forEach(t => {
      if (t.dueDate) {
        const key = t.dueDate;
        const existing = map.get(key) || [];
        existing.push(t);
        map.set(key, existing);
      }
    });
    return map;
  }, [tasks]);

  /* ----- detail drawer editable state ----- */
  const [detailTitle, setDetailTitle] = useState("");
  const [detailDescription, setDetailDescription] = useState("");
  const [detailStatus, setDetailStatus] = useState<TaskStatus>("todo");
  const [detailPriority, setDetailPriority] = useState<TaskPriority>("medium");
  const [detailDueDate, setDetailDueDate] = useState("");
  const [detailTags, setDetailTags] = useState("");
  const [detailEstimatedTime, setDetailEstimatedTime] = useState(0);
  const [detailChecklistInput, setDetailChecklistInput] = useState("");

  useEffect(() => {
    if (selectedTask) {
      setDetailTitle(selectedTask.title);
      setDetailDescription(selectedTask.description || "");
      setDetailStatus(selectedTask.status);
      setDetailPriority(selectedTask.priority);
      setDetailDueDate(selectedTask.dueDate || "");
      setDetailTags((selectedTask.tags || []).join(", "));
      setDetailEstimatedTime(selectedTask.estimatedTime || 0);
      setDetailChecklistInput("");
    }
  }, [selectedTask]);

  const saveDetail = useCallback(async () => {
    if (!selectedTask) return;
    try {
      const tags = detailTags.split(",").map(s => s.trim()).filter(Boolean);
      const data: Partial<TaskItem> = {
        title: detailTitle,
        description: detailDescription,
        status: detailStatus,
        priority: detailPriority,
        dueDate: detailDueDate || null,
        tags: detailTags.split(",").map(s => s.trim()).filter(Boolean),
        estimatedTime: detailEstimatedTime,
      };
      await updateTask(selectedTask.id, data);
    } catch (e: any) {
      console.error("Failed to save detail", e);
    }
  }, [selectedTask, detailTitle, detailDescription, detailStatus, detailPriority, detailDueDate, detailTags, detailEstimatedTime, updateTask]);

  /* ================================================================
     RENDER
     ================================================================ */
  return (
    <div style={{
      display: "flex", flexDirection: "column", flex: 1, width: "100%",
      background: "var(--surface-glass)", color: "var(--text-primary)",
      fontFamily: "var(--font-mono)", fontSize: 13,
      overflow: "hidden", position: "relative",
    }}>
      {/* ------ error toast ------ */}
      {errorMsg && (
        <div style={{
          position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
          zIndex: 200, padding: "6px 16px", borderRadius: 8,
          background: "var(--coral)", color: "#fff", fontSize: 12,
          border: "1px solid rgba(255,255,255,0.2)",
        }}>
          {errorMsg}
        </div>
      )}

      {/* ========== QUICK ADD BAR ========== */}
      <div style={{
        display: "flex", flexDirection: "column",
        borderBottom: "1px solid var(--glass-border)",
      }}>
        <div style={{
          display: "flex", gap: 8, padding: "8px 12px",
          background: "var(--glass)",
          border: "1px solid var(--glass-border)", borderRadius: 10,
          margin: "8px 12px",
        }}>
          <input
            placeholder={'Quick add task \u2014 "Team sync tomorrow at 15:00 !high #work"'}
            value={quickAddText}
            onChange={handleQuickAddChange}
            onKeyDown={(e) => { if (e.key === "Enter") handleQuickAddCreate(); }}
            style={{
              flex: 1, background: "transparent", border: "none",
              outline: "none", color: "var(--text-primary)", fontSize: 13,
              fontFamily: "var(--font-mono)",
            }}
          />
          <button onClick={handleQuickAddCreate} style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, borderRadius: 6,
            background: "var(--teal)", border: "none",
            color: "#fff", cursor: "pointer",
          }}>
            <Plus size={16} />
          </button>
        </div>
        {parsedChips.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "0 12px 4px 12px" }}>
            {parsedChips.map((chip, i) => (
              <span key={i} style={{
                fontSize: 10, padding: "2px 6px", borderRadius: 4,
                background: "var(--glass)", border: "1px solid var(--glass-border)",
                color: "var(--text-secondary)",
              }}>
                {chip.type}: <strong>{chip.value}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ========== HEADER TABS & CONTROLS ========== */}
      <div style={{
        display: "flex", alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 12px",
        borderBottom: "1px solid var(--glass-border)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setViewMode("list")} style={tabStyle(viewMode === "list")}>
            <List size={14} /> List
          </button>
          <button onClick={() => setViewMode("kanban")} style={tabStyle(viewMode === "kanban")}>
            <Columns size={14} /> Board
          </button>
          <button onClick={() => setViewMode("calendar")} style={tabStyle(viewMode === "calendar")}>
            <CalendarDays size={14} /> Calendar
          </button>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setFocusMode(!focusMode)}
            style={{
              ...btnBadge,
              background: focusMode ? "var(--amber)" : "transparent",
              color: focusMode ? "#1a1a2e" : "var(--text-secondary)",
            }}
            title="Focus mode"
          >
            <Focus size={14} /> Focus
          </button>
          <button
            onClick={() => setShowProgress(!showProgress)}
            style={{
              ...btnBadge,
              background: showProgress ? "var(--teal)" : "transparent",
              color: showProgress ? "#1a1a2e" : "var(--text-secondary)",
            }}
            title="Progress dashboard"
          >
            <TrendingUp size={14} /> Streak
          </button>
        </div>
      </div>

      {/* ========== MAIN AREA ========== */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ------ SIDEBAR (smart filters) ------ */}
        <div style={{
          width: 200, borderRight: "1px solid var(--glass-border)",
          padding: "8px 4px", display: "flex", flexDirection: "column",
          gap: 2, overflowY: "auto", flexShrink: 0,
        }}>
          <div style={{
            fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)",
            textTransform: "uppercase", letterSpacing: "0.05em",
            padding: "4px 8px", marginBottom: 4,
          }}>
            Smart Filters
          </div>
          {[
            { key: "all", label: "All Tasks", icon: List },
            { key: "today", label: "Today", icon: Calendar },
            { key: "upcoming", label: "This Week", icon: ArrowUp },
            { key: "overdue", label: "Overdue", icon: AlertCircle },
            { key: "high", label: "High Priority", icon: Star },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilterSmart(f.key as SmartFilter)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "5px 10px", borderRadius: 6, fontSize: 12,
                cursor: "pointer",
                background: filterSmart === f.key ? "var(--glass)" : "transparent",
                border: "none", color: "var(--text-primary)",
                textAlign: "left", width: "100%",
              }}
            >
              <f.icon size={13} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
              <span>{f.label}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-tertiary)" }}>
                {countForFilter(f.key)}
              </span>
            </button>
          ))}
          {/* Tags */}
          {tags.length > 0 && (
            <>
              <div style={{
                fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)",
                textTransform: "uppercase", letterSpacing: "0.05em",
                padding: "4px 8px", marginTop: 8, marginBottom: 4,
              }}>
                Tags
              </div>
              {tags.map(tag => (
                <button
                  key={tag}
                  onClick={() => setFilterTag(filterTag === tag ? "" : tag)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "5px 10px", borderRadius: 6, fontSize: 12,
                    cursor: "pointer",
                    background: filterTag === tag ? "var(--glass)" : "transparent",
                    border: "none", color: "var(--text-primary)",
                    textAlign: "left", width: "100%",
                  }}
                >
                  <span style={{ color: "var(--teal)", flexShrink: 0 }}>#</span>
                  <span>{tag}</span>
                </button>
              ))}
            </>
          )}
{/* Projects */}
          {projects.length > 0 && (
            <>
              <div style={{
                fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)",
                textTransform: "uppercase", letterSpacing: "0.05em",
                padding: "4px 8px", marginTop: 8, marginBottom: 4,
              }}>
                Projects
              </div>
              {projects.map(proj => (
                <button
                  key={proj}
                  onClick={() => setFilterProject(filterProject === proj ? "" : proj)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "5px 10px", borderRadius: 6, fontSize: 12,
                    cursor: "pointer",
                    background: filterProject === proj ? "var(--glass)" : "transparent",
                    border: "none", color: "var(--text-primary)",
                    textAlign: "left", width: "100%",
                  }}
                >
                  <span style={{ flexShrink: 0 }}>{'\uD83D\uDCC1'}</span>
                  <span>{proj}</span>
                </button>
              ))}
            </>
          )}
          {/* Search */}
          <div style={{ marginTop: "auto", padding: "8px 4px" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 8px", borderRadius: 6,
              background: "var(--glass)", border: "1px solid var(--glass-border)",
            }}>
              <Search size={12} style={{ color: "var(--text-tertiary)" }} />
              <input
                placeholder="Search tasks..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{
                  flex: 1, background: "transparent", border: "none",
                  outline: "none", color: "var(--text-primary)", fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
              />
            </div>
          </div>
        </div>
        {/* ------ CONTENT AREA ------ */}
        <div style={{ flex: 1, overflow: "auto", padding: 8, width: "100%", boxSizing: "border-box" }}>
          {viewMode === "list" && renderListView()}
          {viewMode === "kanban" && renderKanbanView()}
          {viewMode === "calendar" && renderCalendarView()}
        </div>
      </div>

      {/* ========== PROGRESS DASHBOARD ========== */}
      {showProgress && (
        <div style={{
          borderTop: "1px solid var(--glass-border)",
          padding: "8px 12px", background: "var(--glass)", flexShrink: 0,
        }}>
          <div style={{ display: "flex", gap: 24, alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}>
            <span>{'\uD83D\uDD25'} Streak: <strong>{streakCount}</strong> days</span>
            <span>{'\u2B50'} Points: <strong>{points}</strong></span>
            <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 24 }}>
              {weeklyData.map((val, i) => (
                <div
                  key={i}
                  style={{
                    width: 20, height: Math.max(4, val),
                    borderRadius: "3px 3px 0 0",
                    background: "var(--teal)", opacity: 0.7,
                    transition: "height 0.2s",
                  }}
                  title={`Day ${i + 1}: ${val} tasks`}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ========== TASK DETAIL DRAWER ========== */}
      {showDetail && selectedTask && (
        <div style={{
          position: "fixed", right: 0, top: 0, bottom: 0, width: 380,
          background: "var(--surface-glass)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderLeft: "1px solid var(--glass-border)", zIndex: 100,
          display: "flex", flexDirection: "column",
          boxShadow: "-4px 0 20px rgba(0,0,0,0.3)",
          transition: "transform 0.2s",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "12px 12px 8px",
            borderBottom: "1px solid var(--glass-border)",
          }}>
            <button onClick={saveDetail} style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 10px", borderRadius: 6, fontSize: 11,
              background: "var(--teal)", border: "none", color: "#fff",
              cursor: "pointer", marginRight: "auto",
              fontFamily: "var(--font-mono)",
            }}>
              <Check size={12} /> Save
            </button>
            <button onClick={() => deleteTask(selectedTask.id)} style={{
              ...btnBadge, background: "transparent",
              border: "1px solid var(--coral)", color: "var(--coral)",
            }} title="Delete task">
              <Trash2 size={14} />
            </button>
            <button onClick={closeDetail} style={{
              ...btnBadge, background: "transparent",
            }} title="Close">
              <X size={14} />
            </button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px", display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Title */}
            <input
              value={detailTitle}
              onChange={e => setDetailTitle(e.target.value)}
              style={{
                width: "100%", padding: "6px 8px", borderRadius: 6, fontSize: 14, fontWeight: 600,
                background: "var(--glass)", border: "1px solid var(--glass-border)",
                outline: "none", color: "var(--text-primary)", fontFamily: "var(--font-mono)",
              }}
              placeholder="Task title"
            />

            {/* Description */}
            <textarea
              value={detailDescription}
              onChange={e => setDetailDescription(e.target.value)}
              rows={3}
              style={{
                width: "100%", padding: "6px 8px", borderRadius: 6, fontSize: 12,
                background: "var(--glass)", border: "1px solid var(--glass-border)",
                outline: "none", color: "var(--text-primary)", resize: "vertical",
                fontFamily: "var(--font-mono)",
              }}
              placeholder="Description..."
            />

            {/* Status */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Status</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["todo", "in_progress", "deferred", "completed"] as TaskStatus[]).map(s => (
                  <button
                    key={s}
                    onClick={() => setDetailStatus(s)}
                    style={{
                      padding: "4px 10px", borderRadius: 6, fontSize: 11,
                      background: detailStatus === s ? statusColor(s) : "var(--glass)",
                      border: "1px solid " + statusColor(s),
                      color: detailStatus === s ? "#fff" : "var(--text-secondary)",
                      cursor: "pointer", fontFamily: "var(--font-mono)",
                    }}
                  >
                    {statusLabel[s]}
                  </button>
                ))}
              </div>
{/* Due Date */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Due Date</div>
              <input
                type="date"
                value={detailDueDate}
                onChange={e => setDetailDueDate(e.target.value)}
                style={{
                  width: "100%", padding: "6px 8px", borderRadius: 6, fontSize: 12,
                  background: "var(--glass)", border: "1px solid var(--glass-border)",
                  outline: "none", color: "var(--text-primary)", fontFamily: "var(--font-mono)",
                }}
              />
            </div>

            {/* Tags */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Tags (comma separated)</div>
              <input
                value={detailTags}
                onChange={e => setDetailTags(e.target.value)}
                style={{
                  width: "100%", padding: "6px 8px", borderRadius: 6, fontSize: 12,
                  background: "var(--glass)", border: "1px solid var(--glass-border)",
                  outline: "none", color: "var(--text-primary)", fontFamily: "var(--font-mono)",
                }}
                placeholder="work, personal, urgent"
              />
            </div>

            {/* Estimated Time */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Est. Time (min)</div>
              <input
                type="number"
                value={detailEstimatedTime}
                onChange={e => setDetailEstimatedTime(Number(e.target.value))}
                min={0}
                style={{
                  width: "100%", padding: "6px 8px", borderRadius: 6, fontSize: 12,
                  background: "var(--glass)", border: "1px solid var(--glass-border)",
                  outline: "none", color: "var(--text-primary)", fontFamily: "var(--font-mono)",
                }}
              />
            </div>
            </div>

            {/* Priority */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Priority</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["low", "medium", "high", "urgent"] as TaskPriority[]).map(p => (
                  <button
                    key={p}
                    onClick={() => setDetailPriority(p)}
                    style={{
                      padding: "4px 10px", borderRadius: 6, fontSize: 11,
                      background: detailPriority === p ? priorityColor(p) : "var(--glass)",
                      border: "1px solid " + priorityColor(p),
                      color: detailPriority === p ? "#fff" : "var(--text-secondary)",
                      cursor: "pointer", fontFamily: "var(--font-mono)",
                    }}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Timer */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Timer</div>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px", borderRadius: 6,
                background: "var(--glass)", border: "1px solid var(--glass-border)",
              }}>
                <button
                  onClick={() => handleTimerToggle(selectedTask.id)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32, borderRadius: 6,
                    background: timerRunning && timerTaskId === selectedTask.id ? "var(--coral)" : "var(--teal)",
                    border: "none", color: "#fff", cursor: "pointer",
                  }}
                >
                  {timerRunning && timerTaskId === selectedTask.id ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                  {timerRunning && timerTaskId === selectedTask.id
                    ? formatTimer(timerElapsed)
                    : formatTimer(selectedTask.actualTime || 0)}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>
                  {selectedTask.estimatedTime ? `est. ${selectedTask.estimatedTime}m` : ""}
                </span>
              </div>
            </div>

            {/* Checklist */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Checklist ({selectedTask.checklist?.filter(c => c.completed).length || 0}/{selectedTask.checklist?.length || 0})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 6 }}>
                {(selectedTask.checklist || []).map(item => (
                  <div key={item.id} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 6px", borderRadius: 4,
                    background: "var(--glass)",
                  }}>
                    <button
                      onClick={() => toggleChecklistItem(selectedTask.id, item.id)}
                      style={{
                        width: 16, height: 16, borderRadius: 3,
                        background: item.completed ? "var(--teal)" : "transparent",
                        border: "1px solid var(--glass-border)", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      {item.completed && <Check size={10} style={{ color: "#fff" }} />}
                    </button>
                    <span style={{
                      flex: 1, fontSize: 12, color: "var(--text-primary)",
                      textDecoration: item.completed ? "line-through" : "none",
                      opacity: item.completed ? 0.6 : 1,
                    }}>
                      {item.text}
                    </span>
                    <button
                      onClick={() => deleteChecklistItem(selectedTask.id, item.id)}
                      style={{
                        background: "none", border: "none", cursor: "pointer",
                        color: "var(--text-tertiary)", padding: 2,
                      }}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  value={detailChecklistInput}
                  onChange={e => setDetailChecklistInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && detailChecklistInput.trim()) {
                      addChecklistItem(selectedTask.id, detailChecklistInput);
                      setDetailChecklistInput("");
                    }
                  }}
                  placeholder="Add checklist item..."
                  style={{
                    flex: 1, padding: "4px 8px", borderRadius: 4, fontSize: 11,
                    background: "var(--glass)", border: "1px solid var(--glass-border)",
                    outline: "none", color: "var(--text-primary)", fontFamily: "var(--font-mono)",
                  }}
                />
                <button
                  onClick={() => {
                    if (detailChecklistInput.trim()) {
                      addChecklistItem(selectedTask.id, detailChecklistInput);
                      setDetailChecklistInput("");
                    }
                  }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 24, height: 24, borderRadius: 4,
                    background: "var(--teal)", border: "none", color: "#fff", cursor: "pointer",
                  }}
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>

            {/* Dependencies */}
            {selectedTask.dependencies && selectedTask.dependencies.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Dependencies
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {selectedTask.dependencies.map(depId => {
                    const dep = tasks.find(t => t.id === depId);
                    return (
                      <div key={depId} style={{
                        display: "flex", alignItems: "center", gap: 4,
                        padding: "3px 6px", borderRadius: 4, fontSize: 11,
                        background: "var(--glass)", color: "var(--text-secondary)",
                      }}>
                        <AlertCircle size={10} style={{ color: dep?.status === "completed" ? "var(--teal)" : "var(--amber)" }} />
                        {dep ? dep.title : depId}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Backlinks */}
            {selectedTask.backlinks && selectedTask.backlinks.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Backlinks
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {selectedTask.backlinks.map((bl, i) => (
                    <button
                      key={i}
                      onClick={() => onOpenNote?.(bl)}
                      style={{
                        textAlign: "left", padding: "3px 6px", borderRadius: 4, fontSize: 11,
                        background: "var(--glass)", border: "none", color: "var(--teal)",
                        cursor: onOpenNote ? "pointer" : "default",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {'\uD83D\uDCC4'} {bl}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  /* ================================================================
     LIST VIEW
     ================================================================ */
  function renderListView() {
    if (sortedTasks.length === 0) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 8,
          color: "var(--text-tertiary)", fontSize: 13,
        }}>
          <List size={32} style={{ opacity: 0.3 }} />
          <span>{tasks.length === 0 ? "No tasks yet. Add one above." : "No matching tasks"}</span>
        </div>
      );
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {/* Table header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "4px 6px", fontSize: 10, fontWeight: 600,
          color: "var(--text-tertiary)", textTransform: "uppercase",
          borderBottom: "1px solid var(--glass-border)", marginBottom: 4,
        }}>
          <div style={{ width: 28, flexShrink: 0 }} />
          <div
            onClick={() => handleSort("priority")}
            style={{ cursor: "pointer", width: 70, flexShrink: 0 }}
          >
            Priority{sortIndicator("priority")}
          </div>
          <div
            onClick={() => handleSort("title")}
            style={{ cursor: "pointer", flex: 1, minWidth: 0 }}
          >
            Title{sortIndicator("title")}
          </div>
          <div
            onClick={() => handleSort("dueDate")}
            style={{ cursor: "pointer", width: 100, flexShrink: 0 }}
          >
            Due{sortIndicator("dueDate")}
          </div>
          <div style={{ width: 80, flexShrink: 0 }}>Tags</div>
          <div
            onClick={() => handleSort("status")}
            style={{ cursor: "pointer", width: 90, flexShrink: 0 }}
          >
            Status{sortIndicator("status")}
          </div>
          <div
            onClick={() => handleSort("estimatedTime")}
            style={{ cursor: "pointer", width: 50, flexShrink: 0 }}
          >
            Est{sortIndicator("estimatedTime")}
          </div>
          <div style={{ width: 50, flexShrink: 0 }}>Act</div>
          <div style={{ width: 50, flexShrink: 0 }} />
        </div>

        {sortedTasks.map(task => (
          <div
            key={task.id}
            onClick={() => openDetail(task)}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "6px 6px", borderRadius: 6,
              background: "var(--glass)", cursor: "pointer",
              transition: "background 0.1s",
              opacity: focusMode && (task.priority !== "high" && task.priority !== "urgent") ? 0.4 : 1,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-glass)")}
            onMouseLeave={e => (e.currentTarget.style.background = "var(--glass)")}
          >
            {/* Checkbox */}
            <button
              onClick={e => { e.stopPropagation(); toggleTaskStatus(task); }}
              style={{
                width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                background: task.status === "completed" ? "var(--teal)" : "transparent",
                border: task.status === "completed" ? "none" : "1px solid var(--glass-border)",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {task.status === "completed" && <Check size={12} style={{ color: "#fff" }} />}
            </button>

            {/* Priority badge */}
            <span style={{
              width: 70, flexShrink: 0, fontSize: 10, fontWeight: 600,
              color: priorityColor(task.priority),
              textTransform: "uppercase",
            }}>
              {task.priority}
            </span>

            {/* Title */}
            <span style={{
              flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", fontSize: 12, color: "var(--text-primary)",
              textDecoration: task.status === "completed" ? "line-through" : "none",
            }}>
              {task.title}
            </span>

            {/* Due date */}
            <span style={{
              width: 100, flexShrink: 0, fontSize: 10,
              color: task.dueDate && new Date(task.dueDate) < new Date() && task.status !== "completed"
                ? "var(--coral)" : "var(--text-secondary)",
            }}>
              {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : "-"}
            </span>

            {/* Tags */}
            <div style={{ width: 80, flexShrink: 0, display: "flex", gap: 2, flexWrap: "wrap" }}>
              {(task.tags || []).slice(0, 2).map(t => (
                <span key={t} style={{
                  fontSize: 8, padding: "1px 4px", borderRadius: 3,
                  background: "var(--glass)", border: "1px solid var(--glass-border)",
                  color: "var(--text-tertiary)",
                }}>
                  {t}
                </span>
              ))}
            </div>

            {/* Status */}
            <span style={{
              width: 90, flexShrink: 0, fontSize: 10,
              color: statusColor(task.status),
            }}>
              {statusLabel[task.status]}
            </span>

            {/* Estimated */}
            <span style={{ width: 50, flexShrink: 0, fontSize: 10, color: "var(--text-tertiary)" }}>
              {task.estimatedTime ? `${task.estimatedTime}m` : "-"}
            </span>

            {/* Actual */}
            <span style={{ width: 50, flexShrink: 0, fontSize: 10, color: "var(--text-tertiary)" }}>
              {task.actualTime ? formatTimer(task.actualTime * 60) : "-"}
            </span>

            {/* Actions */}
            <div style={{ width: 50, flexShrink: 0, display: "flex", gap: 2 }}>
              <button
                onClick={e => { e.stopPropagation(); handleTimerToggle(task.id); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, borderRadius: 4,
                  background: timerRunning && timerTaskId === task.id ? "var(--coral)" : "var(--glass)",
                  border: "none", color: "var(--text-secondary)", cursor: "pointer",
                  fontSize: 10,
                }}
                title={timerRunning && timerTaskId === task.id ? "Pause timer" : "Start timer"}
              >
                {timerRunning && timerTaskId === task.id ? <Pause size={10} /> : <Play size={10} />}
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  /* ================================================================
     KANBAN VIEW
     ================================================================ */
  function renderKanbanView() {
    const columns: { status: TaskStatus; label: string }[] = [
      { status: "todo", label: "Todo" },
      { status: "in_progress", label: "In Progress" },
      { status: "deferred", label: "Deferred" },
      { status: "completed", label: "Completed" },
    ];

    return (
      <div style={{ display: "flex", gap: 8, height: "100%", overflow: "auto" }}>
        {columns.map(col => {
          const colTasks = sortedTasks.filter(t => t.status === col.status);
          return (
            <div
              key={col.status}
              style={{
                flex: 1, minWidth: 200,
                display: "flex", flexDirection: "column",
                background: "var(--glass)", borderRadius: 8,
                border: "1px solid var(--glass-border)",
                overflow: "hidden",
              }}
            >
              {/* Column header */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "8px 10px",
                borderBottom: "1px solid var(--glass-border)",
                background: statusColor(col.status),
                color: "#fff", fontSize: 12, fontWeight: 600,
              }}>
                <span>{col.label}</span>
                <span style={{ fontSize: 10, opacity: 0.8 }}>{colTasks.length}</span>
              </div>

              {/* Cards */}
              <div style={{
                flex: 1, overflowY: "auto", padding: 6,
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                {colTasks.length === 0 && (
                  <div style={{
                    fontSize: 11, color: "var(--text-tertiary)",
                    textAlign: "center", padding: 16,
                  }}>
                    Empty
                  </div>
                )}
                {colTasks.map(task => renderKanbanCard(task))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderKanbanCard(task: TaskItem) {
    return (
      <div
        key={task.id}
        onClick={() => openDetail(task)}
        style={{
          display: "flex", flexDirection: "column", gap: 4,
          padding: "8px 8px", borderRadius: 6,
          background: "var(--surface-glass)",
          border: "1px solid var(--glass-border)",
          cursor: "pointer",
          transition: "box-shadow 0.15s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: priorityColor(task.priority),
            flexShrink: 0,
          }} />
          <span style={{
            flex: 1, fontSize: 12, fontWeight: 500,
            color: "var(--text-primary)", lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {task.title}
          </span>
        </div>
        {task.dueDate && (
          <span style={{
            fontSize: 10, color: "var(--text-tertiary)",
            display: "flex", alignItems: "center", gap: 3,
          }}>
            <Calendar size={10} />
            {new Date(task.dueDate).toLocaleDateString()}
          </span>
        )}
        {task.tags && task.tags.length > 0 && (
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {task.tags.map(t => (
              <span key={t} style={{
                fontSize: 8, padding: "1px 4px", borderRadius: 3,
                background: "var(--glass)", border: "1px solid var(--glass-border)",
                color: "var(--text-tertiary)",
              }}>
                {t}
              </span>
            ))}
          </div>
        )}
        {task.checklist && task.checklist.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{
              flex: 1, height: 3, borderRadius: 2,
              background: "var(--glass)", overflow: "hidden",
            }}>
              <div style={{
                height: "100%",
                width: `${(task.checklist.filter(c => c.completed).length / task.checklist.length) * 100}%`,
                background: "var(--teal)",
                borderRadius: 2,
                transition: "width 0.2s",
              }} />
            </div>
            <span style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
              {task.checklist.filter(c => c.completed).length}/{task.checklist.length}
            </span>
          </div>
        )}
        <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
          {(["todo", "in_progress", "deferred", "completed"] as TaskStatus[])
            .filter(s => s !== task.status).map(s => (
            <button
              key={s}
              onClick={e => { e.stopPropagation(); moveTaskStatus(task.id, s); }}
              style={{
                padding: "2px 6px", borderRadius: 3, fontSize: 9,
                background: "var(--glass)", border: "1px solid var(--glass-border)",
                color: "var(--text-secondary)", cursor: "pointer",
              }}
            >
              {statusLabel[s]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* ================================================================
     CALENDAR VIEW
     ================================================================ */
  function renderCalendarView() {
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const firstDayOfWeek = new Date(calendarYear, calendarMonth, 1).getDay();
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
          <button onClick={prevMonth} style={{ ...btnBadge, background: "var(--glass)" }}>
            <ChevronLeft size={14} />
          </button>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {monthNames[calendarMonth]} {calendarYear}
          </span>
          <button onClick={nextMonth} style={{ ...btnBadge, background: "var(--glass)" }}>
            <ChevronRight size={14} />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
            <div key={d} style={{
              textAlign: "center", fontSize: 10, fontWeight: 600,
              color: "var(--text-tertiary)", padding: "4px 0",
              textTransform: "uppercase",
            }}>
              {d}
            </div>
          ))}
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2,
          flex: 1, alignContent: "start",
        }}>
          {Array.from({ length: firstDayOfWeek }).map((_, i) => (
            <div key={`empty-${i}`} style={{ aspectRatio: "1", opacity: 0.2 }} />
          ))}

          {Array.from({ length: daysInMonth }).map((_, idx) => {
            const day = idx + 1;
            const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const dayTasks = calendarTasks.get(dateStr) || [];
            const isToday = new Date().toDateString() === new Date(dateStr).toDateString();

            return (
              <div
                key={day}
                style={{
                  aspectRatio: "1", borderRadius: 6, padding: 2, cursor: "pointer",
                  background: isToday ? "var(--glass)" : "transparent",
                  border: isToday ? "1px solid var(--glass-border)" : "none",
                  display: "flex", flexDirection: "column", gap: 1,
                  overflow: "hidden",
                }}
              >
                <span style={{
                  fontSize: 10, fontWeight: isToday ? 700 : 400,
                  color: isToday ? "var(--teal)" : "var(--text-secondary)",
                  lineHeight: 1,
                }}>
                  {day}
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 1, overflow: "hidden" }}>
                  {dayTasks.slice(0, 3).map(t => {
                    const comp = t.status === "completed";
                    return (
                      <div
                        key={t.id}
                        onClick={e => { e.stopPropagation(); openDetail(t); }}
                        title={t.title}
                        style={{
                          display: "flex", alignItems: "center", gap: 2,
                          padding: "1px 3px", borderRadius: 2, fontSize: 8,
                          background: comp ? "var(--teal)" : "var(--surface-glass)",
                          color: comp ? "#fff" : "var(--text-primary)",
                          opacity: comp ? 0.7 : 1,
                          cursor: "pointer",
                          overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                          lineHeight: 1.2,
                        }}
                      >
                        <div style={{
                          width: 4, height: 4, borderRadius: "50%",
                          background: priorityColor(t.priority), flexShrink: 0,
                        }} />
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {t.title}
                        </span>
                      </div>
                    );
                  })}
                  {dayTasks.length > 3 && (
                    <span style={{ fontSize: 7, color: "var(--text-tertiary)", paddingLeft: 2 }}>
                      +{dayTasks.length - 3} more
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
};
export default TasksPanel;
