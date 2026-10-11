import type { TaskItem, TaskStatus } from "@/api/types";
import {
  List, Calendar, Check, Pause, Play, ChevronRight,
} from "lucide-react";
import {
  ChevronLeft, btnBadge, formatTimer, priorityColor, statusColor, statusLabel,
} from "@/pages/myspace/parts/TasksPanelUi";

/* Представления списка задач (список / канбан / календарь) — вынесены из TasksPanel. */

interface ListViewProps {
  sortedTasks: TaskItem[];
  tasks: TaskItem[];
  handleSort: (key: string) => void;
  sortIndicator: (key: string) => string;
  openDetail: (task: TaskItem) => void;
  focusMode: boolean;
  toggleTaskStatus: (task: TaskItem) => void | Promise<void>;
  handleTimerToggle: (taskId: string) => void | Promise<void>;
  timerRunning: boolean;
  timerTaskId: string | null;
}
interface KanbanViewProps {
  sortedTasks: TaskItem[];
  openDetail: (task: TaskItem) => void;
  moveTaskStatus: (taskId: string, status: TaskStatus) => void;
}
interface CalendarViewProps {
  calendarYear: number;
  calendarMonth: number;
  prevMonth: () => void;
  nextMonth: () => void;
  calendarTasks: Map<string, TaskItem[]>;
  openDetail: (task: TaskItem) => void;
}

/* ================================================================
   LIST VIEW
   ================================================================ */
export function ListView({
  sortedTasks, tasks, handleSort, sortIndicator, openDetail, focusMode,
  toggleTaskStatus, handleTimerToggle, timerRunning, timerTaskId,
}: ListViewProps) {
  if (sortedTasks.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 8,
          color: "var(--text-tertiary)",
          fontSize: 13,
        }}
      >
        <List size={32} style={{ opacity: 0.3 }} />
        <span>{tasks.length === 0 ? "No tasks yet. Add one above." : "No matching tasks"}</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {/* Table header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 6px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          borderBottom: "1px solid var(--glass-border)",
          marginBottom: 4,
        }}
      >
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

      {sortedTasks.map((task) => (
        <div
          key={task.id}
          onClick={() => openDetail(task)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 6px",
            borderRadius: 6,
            background: "var(--glass)",
            cursor: "pointer",
            transition: "background 0.1s",
            opacity:
              focusMode && task.priority !== "high" && task.priority !== "urgent" ? 0.4 : 1,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-glass)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--glass)")}
        >
          {/* Checkbox */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleTaskStatus(task);
            }}
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              flexShrink: 0,
              background: task.status === "completed" ? "var(--teal)" : "transparent",
              border: task.status === "completed" ? "none" : "1px solid var(--glass-border)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {task.status === "completed" && <Check size={12} style={{ color: "#fff" }} />}
          </button>

          {/* Priority badge */}
          <span
            style={{
              width: 70,
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 600,
              color: priorityColor(task.priority),
              textTransform: "uppercase",
            }}
          >
            {task.priority}
          </span>

          {/* Title */}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              color: "var(--text-primary)",
              textDecoration: task.status === "completed" ? "line-through" : "none",
            }}
          >
            {task.title}
          </span>

          {/* Due date */}
          <span
            style={{
              width: 100,
              flexShrink: 0,
              fontSize: 10,
              color:
                task.dueDate && new Date(task.dueDate) < new Date() && task.status !== "completed"
                  ? "var(--coral)"
                  : "var(--text-secondary)",
            }}
          >
            {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : "-"}
          </span>

          {/* Tags */}
          <div style={{ width: 80, flexShrink: 0, display: "flex", gap: 2, flexWrap: "wrap" }}>
            {(task.tags || []).slice(0, 2).map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 8,
                  padding: "1px 4px",
                  borderRadius: 3,
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-tertiary)",
                }}
              >
                {t}
              </span>
            ))}
          </div>

          {/* Status */}
          <span
            style={{
              width: 90,
              flexShrink: 0,
              fontSize: 10,
              color: statusColor(task.status),
            }}
          >
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
              onClick={(e) => {
                e.stopPropagation();
                handleTimerToggle(task.id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: 4,
                background:
                  timerRunning && timerTaskId === task.id ? "var(--coral)" : "var(--glass)",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
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
export function KanbanView({ sortedTasks, openDetail, moveTaskStatus }: KanbanViewProps) {
  const columns: { status: TaskStatus; label: string }[] = [
    { status: "todo", label: "Todo" },
    { status: "in_progress", label: "In Progress" },
    { status: "deferred", label: "Deferred" },
    { status: "completed", label: "Completed" },
  ];

  return (
    <div style={{ display: "flex", gap: 8, height: "100%", overflow: "auto" }}>
      {columns.map((col) => {
        const colTasks = sortedTasks.filter((t) => t.status === col.status);
        return (
          <div
            key={col.status}
            style={{
              flex: 1,
              minWidth: 200,
              display: "flex",
              flexDirection: "column",
              background: "var(--glass)",
              borderRadius: 8,
              border: "1px solid var(--glass-border)",
              overflow: "hidden",
            }}
          >
            {/* Column header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 10px",
                borderBottom: "1px solid var(--glass-border)",
                background: statusColor(col.status),
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <span>{col.label}</span>
              <span style={{ fontSize: 10, opacity: 0.8 }}>{colTasks.length}</span>
            </div>

            {/* Cards */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: 6,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {colTasks.length === 0 && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                    textAlign: "center",
                    padding: 16,
                  }}
                >
                  Empty
                </div>
              )}
              {colTasks.map((task) => (
            <KanbanCard key={task.id} task={task} openDetail={openDetail} moveTaskStatus={moveTaskStatus} />
          ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({
  task, openDetail, moveTaskStatus,
}: { task: TaskItem } & Pick<KanbanViewProps, "openDetail" | "moveTaskStatus">) {
  return (
    <div
      key={task.id}
      onClick={() => openDetail(task)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 8px",
        borderRadius: 6,
        background: "var(--surface-glass)",
        border: "1px solid var(--glass-border)",
        cursor: "pointer",
        transition: "box-shadow 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: priorityColor(task.priority),
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: 500,
            color: "var(--text-primary)",
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.title}
        </span>
      </div>
      {task.dueDate && (
        <span
          style={{
            fontSize: 10,
            color: "var(--text-tertiary)",
            display: "flex",
            alignItems: "center",
            gap: 3,
          }}
        >
          <Calendar size={10} />
          {new Date(task.dueDate).toLocaleDateString()}
        </span>
      )}
      {task.tags && task.tags.length > 0 && (
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {task.tags.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 8,
                padding: "1px 4px",
                borderRadius: 3,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                color: "var(--text-tertiary)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {task.checklist && task.checklist.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: "var(--glass)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${(task.checklist.filter((c) => c.completed).length / task.checklist.length) * 100}%`,
                background: "var(--teal)",
                borderRadius: 2,
                transition: "width 0.2s",
              }}
            />
          </div>
          <span style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
            {task.checklist.filter((c) => c.completed).length}/{task.checklist.length}
          </span>
        </div>
      )}
      <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
        {(["todo", "in_progress", "deferred", "completed"] as TaskStatus[])
          .filter((s) => s !== task.status)
          .map((s) => (
            <button
              key={s}
              onClick={(e) => {
                e.stopPropagation();
                moveTaskStatus(task.id, s);
              }}
              style={{
                padding: "2px 6px",
                borderRadius: 3,
                fontSize: 9,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                color: "var(--text-secondary)",
                cursor: "pointer",
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
export function CalendarView({
  calendarYear, calendarMonth, prevMonth, nextMonth, calendarTasks, openDetail,
}: CalendarViewProps) {
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  /* Неделя начинается с понедельника: getDay() даёт 0=вс..6=сб, сдвигаем на пн=0. */
  const firstDayOfWeek = (new Date(calendarYear, calendarMonth, 1).getDay() + 6) % 7;
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 0",
        }}
      >
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
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div
            key={d}
            style={{
              textAlign: "center",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--text-tertiary)",
              padding: "4px 0",
              textTransform: "uppercase",
            }}
          >
            {d}
          </div>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 2,
          flex: 1,
          alignContent: "start",
        }}
      >
        {Array.from({ length: firstDayOfWeek }).map((_, i) => (
          <div key={`empty-${i}`} style={{ minHeight: 84, opacity: 0.2 }} />
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
                minHeight: 84,
                borderRadius: 6,
                padding: 2,
                cursor: "pointer",
                background: isToday ? "var(--glass)" : "transparent",
                border: isToday ? "1px solid var(--glass-border)" : "none",
                display: "flex",
                flexDirection: "column",
                gap: 1,
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: isToday ? 700 : 400,
                  color: isToday ? "var(--teal)" : "var(--text-secondary)",
                  lineHeight: 1,
                }}
              >
                {day}
              </span>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 1, overflow: "hidden" }}
              >
                {dayTasks.slice(0, 3).map((t) => {
                  const comp = t.status === "completed";
                  return (
                    <div
                      key={t.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(t);
                      }}
                      title={t.title}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 2,
                        padding: "1px 3px",
                        borderRadius: 2,
                        fontSize: 8,
                        background: comp ? "var(--teal)" : "var(--surface-glass)",
                        color: comp ? "#fff" : "var(--text-primary)",
                        opacity: comp ? 0.7 : 1,
                        cursor: "pointer",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                        lineHeight: 1.2,
                      }}
                    >
                      <div
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: priorityColor(t.priority),
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
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
