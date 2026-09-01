import React from "react";
import type { Task } from "../api/types";

interface Props {
  tasks: Task[];
  onToggle: (id: number) => void;
  onEdit: (task: Task) => void;
  onDelete: (id: number) => void;
}

const STATUSES = ["To Do", "In Progress", "Done"];

export default function KanbanBoard({ tasks, onToggle, onEdit, onDelete }: Props) {
  const cols = STATUSES.map(status => ({
    status,
    items: tasks.filter(t => status === "Done" ? !!t.done : status === "To Do" ? !t.done && !(t as any).inProgress : (t as any).inProgress),
  }));

  return (
    <div className="kanban">
      {cols.map(col => (
        <div key={col.status} className="kanban-col">
          <div className="kanban-col-head">{col.status} <span className="kanban-count">{col.items.length}</span></div>
          {col.items.map(t => (
            <div key={t.id} className="kanban-card" onClick={() => onEdit(t)}>
              <div className="kanban-card-top">
                <input type="checkbox" checked={!!t.done} onChange={() => onToggle(t.id)} onClick={e => e.stopPropagation()} />
                <span className={`kanban-card-text ${t.done ? "is-done" : ""}`}>{t.text}</span>
              </div>
              <div className="kanban-card-meta">
                <span className={`priority-dot ${(t.priority || "").toLowerCase()}`} /> {t.priority}
                {t.tag && <span className="kanban-tag">{t.tag}</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}