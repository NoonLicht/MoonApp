import { tNow } from "@/app/i18n";
import type { TaskPriority, TaskStatus } from "@/api/types";
import {
  Plus,
  List,
  Columns,
  CalendarDays,
  Focus,
  TrendingUp,
  Calendar,
  ArrowUp,
  AlertCircle,
  Star,
  Search,
  Check,
  Trash2,
  X,
  Pause,
  Play,
} from "lucide-react";
import {
  btnBadge,
  formatTimer,
  priorityColor,
  statusColor,
  statusLabel,
  tabStyle,
  type SmartFilter,
} from "@/pages/myspace/parts/TasksPanelUi";
import { ListView, KanbanView, CalendarView } from "@/pages/myspace/parts/TasksViews";
import type { useTasksPanelResult } from "@/pages/myspace/parts/useTasksPanel";

/** Разметка страницы; всё состояние приходит из useTasksPanel. */
export default function TasksPanelView({ c }: { c: useTasksPanelResult }) {
  const {
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
    closeDetail,
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
  } = c;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        width: "100%",
        background: "var(--surface-glass)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* ------ error toast ------ */}
      {errorMsg && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 200,
            padding: "6px 16px",
            borderRadius: 8,
            background: "var(--coral)",
            color: "#fff",
            fontSize: 12,
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* ========== QUICK ADD BAR ========== */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          borderBottom: "1px solid var(--glass-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "8px 12px",
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            borderRadius: 10,
            margin: "8px 12px",
          }}
        >
          <input
            placeholder={tNow("tasksUi.quickAdd")}
            value={quickAddText}
            onChange={handleQuickAddChange}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleQuickAddCreate();
            }}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-primary)",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
            }}
          />
          <button
            onClick={handleQuickAddCreate}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              background: "var(--teal)",
              border: "none",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        {metaHint && (
          <div style={{ padding: "0 12px 4px 12px", fontSize: 11 }}>
            <button
              type="button"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--amber)",
                padding: 0,
              }}
              onClick={() => {
                if (metaHint.project) setHintProject(metaHint.project);
                const add = metaHint.tags.filter((tg) => !quickAddText.includes(`#${tg}`));
                if (add.length)
                  setQuickAddText((v) => `${v} ${add.map((tg) => `#${tg}`).join(" ")}`);
                setMetaHint(null);
              }}
            >
              ✨{" "}
              {t("sem.similarTasks", {
                project: metaHint.project ? t("sem.projectN", { name: metaHint.project }) : "",
                tags: metaHint.tags.length
                  ? ` ${metaHint.tags.map((tg) => `#${tg}`).join(" ")}`
                  : "",
              })}
            </button>
          </div>
        )}
        {parsedChips.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "0 12px 4px 12px" }}>
            {parsedChips.map((chip, i) => (
              <span
                key={i}
                style={{
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-secondary)",
                }}
              >
                {chip.type}: <strong>{chip.value}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ========== HEADER TABS & CONTROLS ========== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px",
          borderBottom: "1px solid var(--glass-border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setViewMode("list")} style={tabStyle(viewMode === "list")}>
            <List size={14} /> {tNow("tasksUi.viewList")}
          </button>
          <button onClick={() => setViewMode("kanban")} style={tabStyle(viewMode === "kanban")}>
            <Columns size={14} /> {tNow("tasksUi.viewBoard")}
          </button>
          <button onClick={() => setViewMode("calendar")} style={tabStyle(viewMode === "calendar")}>
            <CalendarDays size={14} /> {tNow("tasksUi.viewCalendar")}
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
            title={tNow("tasksUi.focusMode")}
          >
            <Focus size={14} /> {tNow("tasksUi.focus")}
          </button>
          <button
            onClick={() => setShowProgress(!showProgress)}
            style={{
              ...btnBadge,
              background: showProgress ? "var(--teal)" : "transparent",
              color: showProgress ? "#1a1a2e" : "var(--text-secondary)",
            }}
            title={tNow("tasksUi.progress")}
          >
            <TrendingUp size={14} /> {tNow("tasksUi.streakBtn")}
          </button>
        </div>
      </div>

      {/* ========== MAIN AREA ========== */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ------ SIDEBAR (smart filters) ------ */}
        <div
          style={{
            width: 200,
            borderRight: "1px solid var(--glass-border)",
            padding: "8px 4px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            overflowY: "auto",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              padding: "4px 8px",
              marginBottom: 4,
            }}
          >
            {tNow("tasksUi.smartFilters")}
          </div>
          {[
            { key: "all", label: tNow("tasksUi.fAll"), icon: List },
            { key: "today", label: tNow("tasksUi.fToday"), icon: Calendar },
            { key: "upcoming", label: tNow("tasksUi.fWeek"), icon: ArrowUp },
            { key: "overdue", label: tNow("tasksUi.fOverdue"), icon: AlertCircle },
            { key: "high", label: tNow("tasksUi.fHigh"), icon: Star },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilterSmart(f.key as SmartFilter)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                borderRadius: 6,
                fontSize: 12,
                cursor: "pointer",
                background: filterSmart === f.key ? "var(--glass)" : "transparent",
                border: "none",
                color: "var(--text-primary)",
                textAlign: "left",
                width: "100%",
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
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--text-tertiary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  padding: "4px 8px",
                  marginTop: 8,
                  marginBottom: 4,
                }}
              >
                {tNow("tasksUi.tags")}
              </div>
              {tags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setFilterTag(filterTag === tag ? "" : tag)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: "pointer",
                    background: filterTag === tag ? "var(--glass)" : "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    textAlign: "left",
                    width: "100%",
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
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--text-tertiary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  padding: "4px 8px",
                  marginTop: 8,
                  marginBottom: 4,
                }}
              >
                {tNow("tasksUi.projects")}
              </div>
              {projects.map((proj) => (
                <button
                  key={proj}
                  onClick={() => setFilterProject(filterProject === proj ? "" : proj)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: "pointer",
                    background: filterProject === proj ? "var(--glass)" : "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    textAlign: "left",
                    width: "100%",
                  }}
                >
                  <span style={{ flexShrink: 0 }}>{"\uD83D\uDCC1"}</span>
                  <span>{proj}</span>
                </button>
              ))}
            </>
          )}
          {/* Search */}
          <div style={{ marginTop: "auto", padding: "8px 4px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                borderRadius: 6,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
              }}
            >
              <Search size={12} style={{ color: "var(--text-tertiary)" }} />
              <input
                placeholder={tNow("tasksUi.search")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--text-primary)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
              />
            </div>
          </div>
        </div>
        {/* ------ CONTENT AREA ------ */}
        <div
          style={{ flex: 1, overflow: "auto", padding: 8, width: "100%", boxSizing: "border-box" }}
        >
          {viewMode === "list" && (
            <ListView
              sortedTasks={sortedTasks}
              tasks={tasks}
              handleSort={handleSort}
              sortIndicator={sortIndicator}
              openDetail={openDetail}
              focusMode={focusMode}
              toggleTaskStatus={toggleTaskStatus}
              handleTimerToggle={handleTimerToggle}
              timerRunning={timerRunning}
              timerTaskId={timerTaskId}
            />
          )}
          {viewMode === "kanban" && (
            <KanbanView
              sortedTasks={sortedTasks}
              openDetail={openDetail}
              moveTaskStatus={moveTaskStatus}
            />
          )}
          {viewMode === "calendar" && (
            <CalendarView
              calendarYear={calendarYear}
              calendarMonth={calendarMonth}
              prevMonth={prevMonth}
              nextMonth={nextMonth}
              calendarTasks={calendarTasks}
              openDetail={openDetail}
            />
          )}
        </div>
      </div>

      {/* ========== PROGRESS DASHBOARD ========== */}
      {showProgress && (
        <div
          style={{
            borderTop: "1px solid var(--glass-border)",
            padding: "8px 12px",
            background: "var(--glass)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 24,
              alignItems: "center",
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            <span>
              {"\uD83D\uDD25"} {tNow("tasksUi.streak")} <strong>{streakCount}</strong> {tNow("tasksUi.days")}
            </span>
            <span>
              {"\u2B50"} {tNow("tasksUi.points")} <strong>{points}</strong>
            </span>
            <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 24 }}>
              {weeklyData.map((val, i) => (
                <div
                  key={i}
                  style={{
                    width: 20,
                    height: Math.max(4, val),
                    borderRadius: "3px 3px 0 0",
                    background: "var(--teal)",
                    opacity: 0.7,
                    transition: "height 0.2s",
                  }}
                  title={tNow("tasksUi.dayTip", { n: i + 1, v: val })}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ========== TASK DETAIL DRAWER ========== */}
      {showDetail && selectedTask && (
        <>
        <div className="task-drawer-backdrop" onClick={closeDetail} />
        <div className="task-drawer">
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 12px 8px",
              borderBottom: "1px solid var(--glass-border)",
            }}
          >
            <span style={{ marginRight: "auto" }} />
            <button
              onClick={() => deleteTask(selectedTask.id)}
              style={{
                ...btnBadge,
                background: "transparent",
                border: "1px solid var(--coral)",
                color: "var(--coral)",
              }}
              title={tNow("tasksUi.delete")}
            >
              <Trash2 size={14} />
            </button>
            <button
              onClick={closeDetail}
              style={{
                ...btnBadge,
                background: "transparent",
              }}
              title={tNow("tasksUi.close")}
            >
              <X size={14} />
            </button>
          </div>

          {/* Body */}
          <div className="task-drawer-body">
            {/* Title */}
            <input
              value={detailTitle}
              onChange={(e) => setDetailTitle(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 8px",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                outline: "none",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
              }}
              placeholder={tNow("tasksUi.taskTitle")}
            />

            {/* Description */}
            <textarea
              value={detailDescription}
              onChange={(e) => setDetailDescription(e.target.value)}
              rows={3}
              style={{
                width: "100%",
                padding: "6px 8px",
                borderRadius: 6,
                fontSize: 12,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                outline: "none",
                color: "var(--text-primary)",
                resize: "vertical",
                fontFamily: "var(--font-mono)",
              }}
              placeholder={tNow("tasksUi.description")}
            />

            {/* Status */}
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {tNow("tasksUi.status")}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["todo", "in_progress", "deferred", "completed"] as TaskStatus[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setDetailStatus(s)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: 11,
                      background: detailStatus === s ? statusColor(s) : "var(--glass)",
                      border: "1px solid " + statusColor(s),
                      color: detailStatus === s ? "#fff" : "var(--text-secondary)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {statusLabel[s]}
                  </button>
                ))}
              </div>
              {/* Due Date */}
              <div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-tertiary)",
                    marginBottom: 4,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {tNow("tasksUi.dueDate")}
                </div>
                <input
                  type="date"
                  value={detailDueDate}
                  onChange={(e) => setDetailDueDate(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 6,
                    fontSize: 12,
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    outline: "none",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>

              {/* Tags */}
              <div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-tertiary)",
                    marginBottom: 4,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {tNow("tasksUi.tagsHint")}
                </div>
                <input
                  value={detailTags}
                  onChange={(e) => setDetailTags(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 6,
                    fontSize: 12,
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    outline: "none",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                  }}
                  placeholder={tNow("tasksUi.tagsPh")}
                />
              </div>

              {/* Estimated Time */}
              <div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-tertiary)",
                    marginBottom: 4,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {tNow("tasksUi.estTime")}
                </div>
                <input
                  type="number"
                  value={detailEstimatedTime}
                  onChange={(e) => setDetailEstimatedTime(Number(e.target.value))}
                  min={0}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 6,
                    fontSize: 12,
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    outline: "none",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>
            </div>

            {/* Priority */}
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {tNow("tasksUi.priority")}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["low", "medium", "high", "urgent"] as TaskPriority[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setDetailPriority(p)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: 11,
                      background: detailPriority === p ? priorityColor(p) : "var(--glass)",
                      border: "1px solid " + priorityColor(p),
                      color: detailPriority === p ? "#fff" : "var(--text-secondary)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {tNow("tasksUi.p_" + p)}
                  </button>
                ))}
              </div>
            </div>

            {/* Timer */}
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {tNow("tasksUi.timer")}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                }}
              >
                <button
                  onClick={() => handleTimerToggle(selectedTask.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    background:
                      timerRunning && timerTaskId === selectedTask.id
                        ? "var(--coral)"
                        : "var(--teal)",
                    border: "none",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  {timerRunning && timerTaskId === selectedTask.id ? (
                    <Pause size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                </button>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
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
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {tNow("tasksUi.checklist")} ({selectedTask.checklist?.filter((c) => c.completed).length || 0}/
                {selectedTask.checklist?.length || 0})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 6 }}>
                {(selectedTask.checklist || []).map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 6px",
                      borderRadius: 4,
                      background: "var(--glass)",
                    }}
                  >
                    <button
                      onClick={() => toggleChecklistItem(selectedTask.id, item.id)}
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 3,
                        background: item.completed ? "var(--teal)" : "transparent",
                        border: "1px solid var(--glass-border)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {item.completed && <Check size={10} style={{ color: "#fff" }} />}
                    </button>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 12,
                        color: "var(--text-primary)",
                        textDecoration: item.completed ? "line-through" : "none",
                        opacity: item.completed ? 0.6 : 1,
                      }}
                    >
                      {item.text}
                    </span>
                    <button
                      onClick={() => deleteChecklistItem(selectedTask.id, item.id)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--text-tertiary)",
                        padding: 2,
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
                  onChange={(e) => setDetailChecklistInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && detailChecklistInput.trim()) {
                      addChecklistItem(selectedTask.id, detailChecklistInput);
                      setDetailChecklistInput("");
                    }
                  }}
                  placeholder={tNow("tasksUi.addItem")}
                  style={{
                    flex: 1,
                    padding: "4px 8px",
                    borderRadius: 4,
                    fontSize: 11,
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    outline: "none",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
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
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    borderRadius: 4,
                    background: "var(--teal)",
                    border: "none",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>

            {/* Dependencies */}
            {selectedTask.dependencies && selectedTask.dependencies.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-tertiary)",
                    marginBottom: 4,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {tNow("tasksUi.dependencies")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {selectedTask.dependencies.map((depId) => {
                    const dep = tasks.find((t) => t.id === depId);
                    return (
                      <div
                        key={depId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "3px 6px",
                          borderRadius: 4,
                          fontSize: 11,
                          background: "var(--glass)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        <AlertCircle
                          size={10}
                          style={{
                            color: dep?.status === "completed" ? "var(--teal)" : "var(--amber)",
                          }}
                        />
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
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-tertiary)",
                    marginBottom: 4,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {tNow("tasksUi.backlinks")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {selectedTask.backlinks.map((bl, i) => (
                    <button
                      key={i}
                      onClick={() => onOpenNote?.(bl)}
                      style={{
                        textAlign: "left",
                        padding: "3px 6px",
                        borderRadius: 4,
                        fontSize: 11,
                        background: "var(--glass)",
                        border: "none",
                        color: "var(--teal)",
                        cursor: onOpenNote ? "pointer" : "default",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {"\uD83D\uDCC4"} {bl}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
}
