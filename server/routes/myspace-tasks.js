const express = require("express");
const path = require("path");
const fs = require("fs");
const logger = require("../logger");
const { DIRS } = require("../config");

const router = express.Router();

// Папка задач — storage\vault ВНУТРИ папки установки. Путь берём из
// единственного источника истины (server/config.js → electron/storagePath.js),
// а не относительно исходников: в собранной сборке код лежит внутри app.asar,
// и прежний путь "../../storage/vault" указывал бы ВНУТРЬ архива, а не в
// storage рядом с exe. DIRS.vault уже создан при require config.
const STORAGE_DIR = DIRS.vault;
const TASKS_FILE = path.join(STORAGE_DIR, "tasks.json");

/* ─── Helpers ─── */

function loadTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return [];
    const raw = fs.readFileSync(TASKS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nowISO() {
  return new Date().toISOString();
}

/* ─── NLP Parser ─── */

function parseTaskTitle(title) {
  const result = { title, priority: undefined, tags: [], dueDate: null, backlinks: [] };
  let text = title;

  // Priority: !high !urgent !medium !low
  const priorityMatch = text.match(/!(high|urgent|medium|low)/gi);
  if (priorityMatch) {
    result.priority = priorityMatch[0].replace("!", "").toLowerCase();
    text = text.replace(/!(high|urgent|medium|low)/gi, "").trim();
  }

  // Tags: #tag1 #tag2
  const tagMatch = text.match(/#([\wа-яА-ЯёЁ\-_]+)/g);
  if (tagMatch) {
    result.tags = tagMatch.map((t) => t.replace("#", "").trim());
    text = text.replace(/#([\wа-яА-ЯёЁ\-_]+)/g, "").trim();
  }

  // Backlinks: @Name or [[Name]]
  const backlinkMatch = text.match(/@(\w[\w\s]*\w|\w)|\[\[([^\]]+)\]\]/g);
  if (backlinkMatch) {
    result.backlinks = backlinkMatch.map((b) => {
      if (b.startsWith("[[")) return b.slice(2, -2).trim();
      return b.slice(1).trim();
    });
    text = text.replace(/@(\w[\w\s]*\w|\w)|\[\[([^\]]+)\]\]/g, "").trim();
  }
// Due date: "tomorrow"
  const tomorrowMatch = text.match(/tomorrow/i);
  if (tomorrowMatch) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    result.dueDate = tomorrow.toISOString();
    text = text.replace(/tomorrow/gi, "").trim();
    const timeMatch = text.match(/at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const ampm = (timeMatch[3] || "").toLowerCase();
      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;
      const dt = new Date(result.dueDate);
      dt.setHours(hours, minutes, 0, 0);
      result.dueDate = dt.toISOString();
      text = text.replace(timeMatch[0], "").trim();
    }
  }

  // Handle "today"
  const todayMatch = text.match(/today/i);
  if (todayMatch) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    result.dueDate = today.toISOString();
    text = text.replace(/today/gi, "").trim();
    const timeMatch = text.match(/at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const ampm = (timeMatch[3] || "").toLowerCase();
      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;
      const dt = new Date(result.dueDate);
      dt.setHours(hours, minutes, 0, 0);
      result.dueDate = dt.toISOString();
      text = text.replace(timeMatch[0], "").trim();
    }
  }

  // Handle "next monday", "next tuesday", etc.
  const nextWeekMatch = text.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (nextWeekMatch) {
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const targetDay = dayNames.indexOf(nextWeekMatch[1].toLowerCase());
    if (targetDay >= 0) {
      const now = new Date();
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      const nextDate = new Date(now);
      nextDate.setDate(now.getDate() + daysUntil);
      nextDate.setHours(0, 0, 0, 0);
      result.dueDate = nextDate.toISOString();
      text = text.replace(nextWeekMatch[0], "").trim();
      const timeMatch = text.match(/at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const ampm = (timeMatch[3] || "").toLowerCase();
        if (ampm === "pm" && hours < 12) hours += 12;
        if (ampm === "am" && hours === 12) hours = 0;
        const dt = new Date(result.dueDate);
        dt.setHours(hours, minutes, 0, 0);
        result.dueDate = dt.toISOString();
        text = text.replace(timeMatch[0], "").trim();
      }
    }
  }

  // Clean up title
  result.title = text.replace(/\s+/g, " ").trim();
  if (!result.title) {
    result.title = title
      .replace(/!(high|urgent|medium|low)/gi, "")
      .replace(/#([\w\-_]+)/g, "")
      .replace(/@(\w[\w\s]*\w|\w)|\[\[([^\]]+)\]\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return result;
}

/* --- Routes --- */

// GET / � list tasks with filters
router.get("/", (req, res) => {
  try {
    const { status, tag, projectId, dateFrom, dateTo, search } = req.query;
    let tasks = loadTasks();

    if (status) tasks = tasks.filter((t) => t.status === status);
    if (tag) tasks = tasks.filter((t) => t.tags && t.tags.includes(tag));
    if (projectId) tasks = tasks.filter((t) => t.projectId === projectId);
    if (dateFrom) {
      const from = new Date(dateFrom);
      tasks = tasks.filter((t) => t.dueDate && new Date(t.dueDate) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      tasks = tasks.filter((t) => t.dueDate && new Date(t.dueDate) <= to);
    }
    if (search) {
      const q = search.toLowerCase();
      tasks = tasks.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
      );
    }

    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / � create task with NLP parsing
router.post("/", (req, res) => {
  try {
    const body = req.body || {};
    const parsed = parseTaskTitle(body.title || "");

    const task = {
      id: generateId(),
      title: parsed.title,
      description: body.description || "",
      status: body.status || "todo",
      priority: body.priority || parsed.priority || "medium",
      estimatedTime: body.estimatedTime || 0,
      actualTime: 0,
      recurrence: body.recurrence || "none",
      dueDate: body.dueDate || parsed.dueDate || null,
      reminderDateTime: body.reminderDateTime || null,
      checklist: [],
      attachments: [],
      urls: [],
      tags: [...new Set([...(body.tags || []), ...parsed.tags])],
      projectId: body.projectId || "",
      folder: body.folder || "",
      location: "",
      dependencies: body.dependencies || [],
      backlinks: parsed.backlinks || [],
      created_at: nowISO(),
      updated_at: nowISO(),
    };

    const tasks = loadTasks();
    tasks.push(task);
    saveTasks(tasks);

    logger.action("tasks.create", { id: task.id, title: task.title });
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id � update task
router.put("/:id", (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body || {};
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return res.status(404).json({ error: "task not found" });

    let parsedTitle = {};
    if (data.title && data.title !== tasks[idx].title) {
      parsedTitle = parseTaskTitle(data.title);
    }

    tasks[idx] = {
      ...tasks[idx],
      ...data,
      ...(parsedTitle.title ? { title: parsedTitle.title } : {}),
      ...(parsedTitle.priority && !data.priority ? { priority: parsedTitle.priority } : {}),
      ...(parsedTitle.tags && !data.tags
        ? { tags: [...new Set([...tasks[idx].tags, ...parsedTitle.tags])] }
        : {}),
      ...(parsedTitle.backlinks
        ? { backlinks: [...new Set([...tasks[idx].backlinks, ...parsedTitle.backlinks])] }
        : {}),
      ...(parsedTitle.dueDate && !data.dueDate ? { dueDate: parsedTitle.dueDate } : {}),
      updated_at: nowISO(),
    };

    saveTasks(tasks);
    logger.action("tasks.update", { id });
    res.json(tasks[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id � delete task
router.delete("/:id", (req, res) => {
  try {
    const { id } = req.params;
    let tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return res.status(404).json({ error: "task not found" });
    tasks.splice(idx, 1);
    saveTasks(tasks);
    logger.action("tasks.delete", { id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/checklist � reorder/update checklist items
router.put("/:id/checklist", (req, res) => {
  try {
    const { id } = req.params;
    const { checklist } = req.body || {};
    if (!Array.isArray(checklist)) return res.status(400).json({ error: "checklist must be an array" });

    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return res.status(404).json({ error: "task not found" });

    tasks[idx].checklist = checklist;
    tasks[idx].updated_at = nowISO();
    saveTasks(tasks);

    res.json(tasks[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/timer � start/pause timer
router.post("/:id/timer", (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body || {};
    if (!action || !["start", "pause"].includes(action)) {
      return res.status(400).json({ error: "action must be start or pause" });
    }

    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return res.status(404).json({ error: "task not found" });

    const task = tasks[idx];
    if (action === "start") {
      task._timerStart = Date.now();
    } else if (action === "pause") {
      if (task._timerStart) {
        const elapsed = Math.round((Date.now() - task._timerStart) / 60000);
        task.actualTime = (task.actualTime || 0) + elapsed;
        delete task._timerStart;
      }
    }

    task.updated_at = nowISO();
    tasks[idx] = task;
    saveTasks(tasks);

    res.json(tasks[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
