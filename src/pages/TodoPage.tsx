import React, { useState, useEffect, useRef } from "react";
import { Plus, GripVertical, Trash2, CheckSquare, Sparkles } from "lucide-react";
import { Btn, IconBtn, Glass, Badge, SectionHead, Select, EmptyHint, Checkbox } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { Task } from "../api/types";

const FILTERS = ["All", "Active", "Done"];

export default function TodoPage() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState("All");
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => { api.getTasks().then(setTasks).catch(() => setTasks([])).finally(() => setLoaded(true)); }, []);

  usePageToolbar(
    <Select value={filter} onChange={(e) => setFilter(e.target.value)} options={FILTERS} />,
    [filter]
  );

  const visible = tasks.filter((x) => (filter === "All" ? true : filter === "Active" ? !x.done : x.done));

  const addTask = async () => {
    if (!text.trim()) return;
    const task = await api.addTask(text.trim(), "Med", "General");
    setTasks((x) => [task, ...x]);
    setText("");
  };

  const toggle = async (id: number) => {
    const task = tasks.find((x) => x.id === id);
    if (!task) return;
    const next = await api.toggleTask(id, !task.done);
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, done: next.done } : x)));
  };

  const remove = async (id: number) => {
    await api.deleteTask(id);
    setTasks((prev) => prev.filter((x) => x.id !== id));
  };

  const onDragStart = (i: number) => () => { dragIndex.current = i; };
  const onDragOver = (e: React.DragEvent) => e.preventDefault();
  const onDrop = async (i: number) => {
    const from = dragIndex.current;
    if (from === null || from === i) return;
    setTasks((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(from, 1);
      copy.splice(i, 0, moved);
      api.reorderTasks(copy.map((x) => x.id)).catch(() => {});
      return copy;
    });
    dragIndex.current = null;
  };

  const open = tasks.filter((x) => !x.done).length;

  return (
    <div className="page">
      <SectionHead eyebrow={t("todo.eyebrow", { n: open })} title={t("todo.title")} />

      <Glass className="url-bar">
        <Plus size={16} />
        <input placeholder={t("todo.placeholder")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} />
        <Btn variant="primary" onClick={addTask}>{t("todo.add")}</Btn>
      </Glass>

      <div className="task-list">
        {visible.map((task, i) => (
          <Glass
            className={`task-row ${task.done ? "is-done" : ""}`}
            key={task.id}
            draggable
            onDragStart={onDragStart(i)}
            onDragOver={onDragOver}
            onDrop={() => onDrop(i)}
          >
            <GripVertical size={15} className="drag-handle" />
            <Checkbox checked={!!task.done} onClick={() => toggle(task.id)} />
            <span className="task-text">{task.text}</span>
            <Badge tone={task.priority === "High" ? "coral" : task.priority === "Med" ? "amber" : "teal"}>{task.priority}</Badge>
            <span className="tag-chip">{task.tag}</span>
            <IconBtn icon={Trash2} onClick={() => remove(task.id)} title={t("todo.deleteTitle")} />
          </Glass>
        ))}
        {loaded && visible.length === 0 && <EmptyHint icon={CheckSquare} text={t("todo.empty")} />}
      </div>

      <Glass className="source-placeholder">
        <Sparkles size={16} />
        <span>{t("todo.smart")}</span>
      </Glass>
    </div>
  );
}