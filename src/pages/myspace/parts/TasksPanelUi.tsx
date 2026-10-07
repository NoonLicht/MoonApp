/**
 * Выделено из TasksPanel.tsx при разбиении крупного файла (поведение не менялось).
 */
import React from "react";
import type { TaskPriority, TaskStatus } from "@/api/types";

/* ---------- types ---------- */
export interface TasksPanelProps {
  onOpenNote?: (path: string) => void;
  vaultFiles?: string[];
}

export interface ParsedChip {
  type: string;
  value: string;
}

export type ViewMode = "list" | "kanban" | "calendar";
export type SmartFilter = "all" | "today" | "upcoming" | "overdue" | "high";

export interface SortConfig {
  key: string;
  direction: "asc" | "desc";
}

/* ---------- helpers ---------- */
export const ChevronLeft = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export const tabStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "5px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: active ? 600 : 400,
  background: active ? "var(--glass)" : "transparent",
  border: "none",
  color: active ? "var(--text-primary)" : "var(--text-secondary)",
  cursor: "pointer",
  transition: "all 0.15s",
});

export const btnBadge: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 6,
  fontSize: 11,
  border: "1px solid var(--glass-border)",
  cursor: "pointer",
  color: "var(--text-secondary)",
};

export const priorityColor = (p: TaskPriority): string => {
  if (p === "urgent") return "var(--coral)";
  if (p === "high") return "var(--amber)";
  if (p === "medium") return "#e8b83a";
  return "var(--text-tertiary)";
};

export const statusLabel: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  deferred: "Deferred",
  completed: "Completed",
};

export const statusColor = (s: TaskStatus): string => {
  const map: Record<TaskStatus, string> = {
    todo: "var(--text-secondary)",
    in_progress: "var(--amber)",
    deferred: "var(--violet)",
    completed: "var(--teal)",
  };
  return map[s] || "var(--text-secondary)";
};

export function formatTimer(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
