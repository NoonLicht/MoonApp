import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useDeepLink } from "@/lib/deepLink";
import { useI18n } from "@/app/i18n";
import type {
  TaskItem,
  TaskPriority,
  TaskCreatePayload,
  TaskStatus,
  TaskChecklistItem,
} from "@/api/types";
import { api } from "@/api/client";
import {
  type ParsedChip,
  type SmartFilter,
  type SortConfig,
  type TasksPanelProps,
  type ViewMode,
} from "@/pages/myspace/parts/TasksPanelUi";
import { formatLocalDateOnly, parseNaturalDate } from "@/pages/myspace/parts/TasksDateParser";

/** Состояние и обработчики страницы (вынесено из TasksPanel.tsx). */
export function useTasksPanel({ onOpenNote }: TasksPanelProps) {
  const { t } = useI18n();
  /* ----- state ----- */
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [focusMode, setFocusMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTag, setFilterTag] = useState<string>("");
  const [filterProject, setFilterProject] = useState<string>("");
  const [filterSmart, setFilterSmart] = useState<SmartFilter>("all");
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  // Переход по ссылке из заметки/Canvas/поиска: открыть нужную задачу.
  const [wantTask, setWantTask] = useState("");
  useDeepLink("myspace", (t) => {
    if (t.view !== "tasks" || !t.ref) return;
    setWantTask(t.ref);
  });
  useEffect(() => {
    if (!wantTask) return;
    const found = tasks.find((x) => x.id === wantTask);
    if (found) {
      setSelectedTask(found);
      setShowDetail(true);
      setWantTask("");
    }
  }, [wantTask, tasks]);
  const [showDetail, setShowDetail] = useState(false);
  const [quickAddText, setQuickAddText] = useState("");
  const [parsedChips, setParsedChips] = useState<ParsedChip[]>([]);
  // Подсказка проекта и тегов по похожим задачам (поиск по смыслу).
  const [metaHint, setMetaHint] = useState<{ project: string; tags: string[] } | null>(null);
  const [hintProject, setHintProject] = useState("");
  useEffect(() => {
    const text = quickAddText.replace(/[#!+@]\S+/g, " ").trim();
    if (text.length < 5) {
      setMetaHint(null);
      return;
    }
    let live = true;
    const tm = setTimeout(() => {
      api
        .semTaskMeta(text)
        .then((m) => live && setMetaHint(m.project || m.tags.length ? m : null))
        .catch(() => live && setMetaHint(null));
    }, 500);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [quickAddText]);
  const [streakCount, setStreakCount] = useState(0);
  const [weeklyData, setWeeklyData] = useState<number[]>([]);
  const [points, setPoints] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerTaskId, setTimerTaskId] = useState<string | null>(null);
  const [timerElapsed, setTimerElapsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: "created_at",
    direction: "desc",
  });
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().getMonth());
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  /* ----- load tasks on mount ----- */
  useEffect(() => {
    api
      .tasksList()
      .then(setTasks)
      .catch(() => {});
    loadStreakAndProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- derived data ----- */

  /* ----- derived data ----- */
  const tags = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach((t) => t.tags?.forEach((tg) => s.add(tg)));
    return Array.from(s).sort();
  }, [tasks]);

  const projects = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach((t) => {
      if (t.projectId) s.add(t.projectId);
    });
    return Array.from(s).sort();
  }, [tasks]);

  /* ----- filtering logic ----- */
  const filteredTasks = useMemo(() => {
    let list = [...tasks];

    if (focusMode) {
      const threeDays = new Date();
      threeDays.setDate(threeDays.getDate() + 3);
      list = list.filter(
        (t) =>
          (t.priority === "high" || t.priority === "urgent") &&
          t.dueDate &&
          new Date(t.dueDate) <= threeDays,
      );
      list = list.slice(0, 5);
      return list;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.tags?.some((tg) => tg.toLowerCase().includes(q)),
      );
    }

    if (filterTag) {
      list = list.filter((t) => t.tags?.includes(filterTag));
    }

    if (filterProject) {
      list = list.filter((t) => t.projectId === filterProject);
    }

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);

    switch (filterSmart) {
      case "today":
        list = list.filter(
          (t) => t.dueDate && new Date(t.dueDate).toDateString() === now.toDateString(),
        );
        break;
      case "upcoming":
        list = list.filter(
          (t) => t.dueDate && new Date(t.dueDate) >= now && new Date(t.dueDate) <= endOfWeek,
        );
        break;
      case "overdue":
        list = list.filter(
          (t) => t.status !== "completed" && t.dueDate && new Date(t.dueDate) < now,
        );
        break;
      case "high":
        list = list.filter((t) => t.priority === "high" || t.priority === "urgent");
        break;
    }

    return list;
  }, [tasks, searchQuery, filterTag, filterProject, filterSmart, focusMode]);

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
  const countForFilter = useCallback(
    (key: string): number => {
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);

      switch (key) {
        case "today":
          return tasks.filter(
            (t) => t.dueDate && new Date(t.dueDate).toDateString() === now.toDateString(),
          ).length;
        case "upcoming":
          return tasks.filter(
            (t) => t.dueDate && new Date(t.dueDate) >= now && new Date(t.dueDate) <= endOfWeek,
          ).length;
        case "overdue":
          return tasks.filter(
            (t) => t.status !== "completed" && t.dueDate && new Date(t.dueDate) < now,
          ).length;
        case "high":
          return tasks.filter((t) => t.priority === "high" || t.priority === "urgent").length;
        default:
          return tasks.length;
      }
    },
    [tasks],
  );

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
    } catch {
      /* ignore */
    }
  }, []);

  /* ----- NLP parsing ----- */
  const parseQuickAdd = useCallback((text: string) => {
    const chips: ParsedChip[] = [];
    const linkMatch = text.match(/@(\w[\w.-]*)/g);
    if (linkMatch) linkMatch.forEach((m) => chips.push({ type: "link", value: m.slice(1) }));
    const tagMatch = text.match(/#(\w[\w-]*)/g);
    if (tagMatch) tagMatch.forEach((m) => chips.push({ type: "tag", value: m.slice(1) }));
    // i18n-ignore-start: слова-приоритеты для разбора текста задачи — данные, не интерфейс
    const prioMatch = text.match(/!(high|urgent|medium|low|высокий|срочный|средний|низкий)\b/gi);
    if (prioMatch)
      prioMatch.forEach((m) => {
        const v = m.slice(1).toLowerCase();
        if (v === "высокий" || v === "срочный")
          chips.push({ type: "priority", value: v === "срочный" ? "urgent" : "high" });
        else if (v === "средний") chips.push({ type: "priority", value: "medium" });
        else if (v === "низкий") chips.push({ type: "priority", value: "low" });
        else chips.push({ type: "priority", value: v });
      });
    // i18n-ignore-end
    const natural = parseNaturalDate(text);
    if (natural) {
      chips.push({ type: "date", value: natural.phrase.toLowerCase() });
      if (natural.hasTime) {
        chips.push({
          type: "time",
          value: `${String(natural.date.getHours()).padStart(2, "0")}:${String(
            natural.date.getMinutes(),
          ).padStart(2, "0")}`,
        });
      }
    }
    const projMatch = text.match(/\+(project|folder):(\w[\w-]*)/gi);
    if (projMatch)
      projMatch.forEach((m) => {
        const parts = m.split(":");
        chips.push({ type: "project", value: parts[1] });
      });
    setParsedChips(chips);
  }, []);

  const handleQuickAddChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setQuickAddText(v);
      parseQuickAdd(v);
    },
    [parseQuickAdd],
  );

  /* ----- progress updater (declared BEFORE quick-add to avoid TDZ) ----- */
  const updateProgress = useCallback((increment: number) => {
    try {
      const data = localStorage.getItem("tasks_progress");
      const prog = data
        ? JSON.parse(data)
        : { streak: 0, weekly: [0, 0, 0, 0, 0, 0, 0], points: 0, lastDate: null };

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
    } catch {
      /* ignore */
    }
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
        tags = tagMatch.map((m) => m.slice(1));
        title = title.replace(/#(\w[\w-]*)/g, "").trim();
      }

      const natural = parseNaturalDate(title);
      if (natural) {
        dueDate = natural.hasTime ? natural.date.toISOString() : formatLocalDateOnly(natural.date);
        title = title.replace(natural.phrase, "").trim();
      }

      const payload: TaskCreatePayload = {
        title: title || quickAddText.trim(),
        priority,
        dueDate,
        tags,
        ...(hintProject ? { projectId: hintProject } : {}),
      };

      const created = await api.tasksCreate(payload);
      setTasks((prev) => [created, ...prev]);
      setQuickAddText("");
      setParsedChips([]);
      setHintProject("");
      updateProgress(1);
    } catch (e: any) {
      console.error("Failed to create task", e);
      setErrorMsg("Failed to create task");
      setTimeout(() => setErrorMsg(null), 3000);
    }
  }, [quickAddText, hintProject]);

  /* ----- task actions ----- */
  const toggleTaskStatus = useCallback(
    async (task: TaskItem) => {
      try {
        const newStatus: TaskStatus = task.status === "completed" ? "todo" : "completed";
        const updated = await api.tasksUpdate(task.id, { status: newStatus });
        setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
        if (selectedTask?.id === task.id) setSelectedTask(updated);
        if (newStatus === "completed") updateProgress(1);
      } catch (e: any) {
        console.error("Failed to toggle task", e);
        setErrorMsg("Failed to update task");
        setTimeout(() => setErrorMsg(null), 3000);
      }
    },
    [selectedTask, updateProgress],
  );

  const updateTask = useCallback(
    async (id: string, data: Partial<TaskItem>) => {
      try {
        const updated = await api.tasksUpdate(id, data);
        setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
        if (selectedTask?.id === id) setSelectedTask(updated);
      } catch (e: any) {
        console.error("Failed to update task", e);
        setErrorMsg("Failed to update task");
        setTimeout(() => setErrorMsg(null), 3000);
      }
    },
    [selectedTask],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      try {
        await api.tasksDelete(id);
        setTasks((prev) => prev.filter((t) => t.id !== id));
        if (selectedTask?.id === id) {
          setSelectedTask(null);
          setShowDetail(false);
        }
      } catch (e: any) {
        console.error("Failed to delete task", e);
        setErrorMsg("Failed to delete task");
        setTimeout(() => setErrorMsg(null), 3000);
      }
    },
    [selectedTask],
  );

  /* ----- timer ----- */
  const handleTimerToggle = useCallback(
    async (taskId: string) => {
      try {
        if (timerRunning && timerTaskId === taskId) {
          const updated = await api.tasksTimer(taskId, "pause");
          setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
          setTimerRunning(false);
          setTimerTaskId(null);
        } else {
          if (timerRunning && timerTaskId) {
            await api.tasksTimer(timerTaskId, "pause");
          }
          const updated = await api.tasksTimer(taskId, "start");
          setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
          setTimerRunning(true);
          setTimerTaskId(taskId);
          setTimerElapsed(0);
        }
      } catch (e: any) {
        console.error("Timer error", e);
        setErrorMsg("Timer error");
        setTimeout(() => setErrorMsg(null), 3000);
      }
    },
    [timerRunning, timerTaskId],
  );

  /* Timer tick */
  useEffect(() => {
    if (!timerRunning) return;
    const interval = setInterval(() => {
      setTimerElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [timerRunning]);

  /* ----- checklist actions ----- */
  const addChecklistItem = useCallback(
    async (taskId: string, text: string) => {
      if (!text.trim()) return;
      try {
        const task = tasks.find((t) => t.id === taskId);
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
    },
    [tasks, updateTask],
  );

  const toggleChecklistItem = useCallback(
    async (taskId: string, itemId: string) => {
      try {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return;
        const checklist = (task.checklist || []).map((item) =>
          item.id === itemId ? { ...item, completed: !item.completed } : item,
        );
        await updateTask(taskId, { checklist });
      } catch (e: any) {
        console.error("Failed to toggle checklist item", e);
      }
    },
    [tasks, updateTask],
  );

  const deleteChecklistItem = useCallback(
    async (taskId: string, itemId: string) => {
      try {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return;
        const checklist = (task.checklist || []).filter((item) => item.id !== itemId);
        await updateTask(taskId, { checklist });
      } catch (e: any) {
        console.error("Failed to delete checklist item", e);
      }
    },
    [tasks, updateTask],
  );

  /* ----- sort ----- */
  const handleSort = useCallback((key: string) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  const sortIndicator = (key: string): string => {
    if (sortConfig.key !== key) return "";
    return sortConfig.direction === "asc" ? " ▲" : " ▼";
  };

  /* ----- kanban ----- */
  const moveTaskStatus = useCallback(
    (taskId: string, newStatus: TaskStatus) => {
      updateTask(taskId, { status: newStatus });
    },
    [updateTask],
  );

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
      setCalendarYear((y) => y - 1);
    } else {
      setCalendarMonth((m) => m - 1);
    }
  }, [calendarMonth]);

  const nextMonth = useCallback(() => {
    if (calendarMonth === 11) {
      setCalendarMonth(0);
      setCalendarYear((y) => y + 1);
    } else {
      setCalendarMonth((m) => m + 1);
    }
  }, [calendarMonth]);

  const calendarTasks = useMemo(() => {
    const map = new Map<string, TaskItem[]>();
    tasks.forEach((t) => {
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
    // Поля пере-читываются только при смене открытой задачи: после автосохранения
    // selectedTask обновляется, и сброс на каждое сохранение сбивал бы ввод.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask?.id]);

  const saveDetail = useCallback(async () => {
    if (!selectedTask) return;
    try {
      const data: Partial<TaskItem> = {
        title: detailTitle,
        description: detailDescription,
        status: detailStatus,
        priority: detailPriority,
        dueDate: detailDueDate || null,
        tags: detailTags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        estimatedTime: detailEstimatedTime,
      };
      await updateTask(selectedTask.id, data);
    } catch (e: any) {
      console.error("Failed to save detail", e);
    }
  }, [
    selectedTask,
    detailTitle,
    detailDescription,
    detailStatus,
    detailPriority,
    detailDueDate,
    detailTags,
    detailEstimatedTime,
    updateTask,
  ]);
  // Автосохранение: любое изменение полей панели записывается через 0,5 с
  // (кнопки «Сохранить» нет), закрытие панели тоже дожидается записи.
  useEffect(() => {
    if (!selectedTask) return;
    const dirty =
      detailTitle !== selectedTask.title ||
      detailDescription !== (selectedTask.description || "") ||
      detailStatus !== selectedTask.status ||
      detailPriority !== selectedTask.priority ||
      detailDueDate !== (selectedTask.dueDate || "") ||
      detailTags !== (selectedTask.tags || []).join(", ") ||
      detailEstimatedTime !== (selectedTask.estimatedTime || 0);
    if (!dirty) return;
    const h = setTimeout(() => void saveDetail(), 500);
    return () => clearTimeout(h);
  }, [
    selectedTask,
    detailTitle,
    detailDescription,
    detailStatus,
    detailPriority,
    detailDueDate,
    detailTags,
    detailEstimatedTime,
    saveDetail,
  ]);

  const closeDetailSaved = useCallback(async () => {
    await saveDetail();
    closeDetail();
  }, [saveDetail, closeDetail]);

  return {
    onOpenNote,
    t,
    tasks,
    viewMode,
    setViewMode,
    focusMode,
    setFocusMode,
    searchQuery,
    setSearchQuery,
    filterTag,
    setFilterTag,
    filterProject,
    setFilterProject,
    filterSmart,
    setFilterSmart,
    selectedTask,
    showDetail,
    quickAddText,
    setQuickAddText,
    parsedChips,
    metaHint,
    setMetaHint,
    setHintProject,
    streakCount,
    weeklyData,
    points,
    showProgress,
    setShowProgress,
    timerRunning,
    timerTaskId,
    timerElapsed,
    errorMsg,
    calendarMonth,
    calendarYear,
    tags,
    projects,
    sortedTasks,
    countForFilter,
    handleQuickAddChange,
    handleQuickAddCreate,
    toggleTaskStatus,
    deleteTask,
    handleTimerToggle,
    addChecklistItem,
    toggleChecklistItem,
    deleteChecklistItem,
    handleSort,
    sortIndicator,
    moveTaskStatus,
    openDetail,
    closeDetail: closeDetailSaved,
    prevMonth,
    nextMonth,
    calendarTasks,
    detailTitle,
    setDetailTitle,
    detailDescription,
    setDetailDescription,
    detailStatus,
    setDetailStatus,
    detailPriority,
    setDetailPriority,
    detailDueDate,
    setDetailDueDate,
    detailTags,
    setDetailTags,
    detailEstimatedTime,
    setDetailEstimatedTime,
    detailChecklistInput,
    setDetailChecklistInput,
    saveDetail,
  };
}

export type useTasksPanelResult = ReturnType<typeof useTasksPanel>;
