import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { api } from "@/api/client";
import type { TaskItem, TaskPriority, TaskStatus } from "@/api/types";
import { ObjectView } from "@/pages/myspace/canvas/ObjectView";
import { boundsOf, unionBox, type Obj } from "@/pages/myspace/canvas/model";
import { mapById } from "@/pages/myspace/canvas/board";
import { lineGeom } from "@/pages/myspace/canvas/model";
import { openTarget, targetFor } from "@/lib/deepLink";

const STATUS: { v: TaskStatus; label: string; color: string }[] = [
  { v: "todo", label: "К выполнению", color: "#94a3b8" },
  { v: "in_progress", label: "В работе", color: "#f59e0b" },
  { v: "deferred", label: "Отложена", color: "#8b7bf0" },
  { v: "completed", label: "Готово", color: "#22c55e" },
];
const PRIO: { v: TaskPriority; label: string; color: string }[] = [
  { v: "low", label: "Низкий", color: "#22c55e" },
  { v: "medium", label: "Средний", color: "#f59e0b" },
  { v: "high", label: "Высокий", color: "#f97316" },
  { v: "urgent", label: "Срочный", color: "#ef4444" },
];

/** Задача прямо в тексте заметки: статус, приоритет, срок и «готово» меняются на месте. */
function TaskEmbed({ id, onRemove }: { id: string; onRemove: () => void }) {
  const [task, setTask] = useState<TaskItem | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api
      .tasksList()
      .then((l) => live && setTask(l.find((t) => t.id === id) ?? null))
      .catch(() => live && setTask(null));
    return () => {
      live = false;
    };
  }, [id]);

  const save = (patch: Partial<TaskItem>) => {
    if (!task) return;
    setTask({ ...task, ...patch });
    void api.tasksUpdate(task.id, patch).then((t) => setTask(t));
  };

  if (task === undefined) return <div className="emb emb-task muted-sm">Загрузка задачи…</div>;
  if (task === null)
    return (
      <div className="emb emb-task">
        <span className="muted-sm">Задача не найдена (возможно, удалена)</span>
        <button type="button" className="emb-x" title="Убрать из заметки" onClick={onRemove}>
          <X size={13} />
        </button>
      </div>
    );
  const st = STATUS.find((s) => s.v === task.status) ?? STATUS[0];
  const done = task.status === "completed";
  return (
    <div className="emb emb-task" style={{ borderLeftColor: st.color }}>
      <div className="emb-row">
        <input
          type="checkbox"
          className="emb-check"
          checked={done}
          onChange={(e) => save({ status: e.target.checked ? "completed" : "todo" })}
        />
        <span className={`emb-title${done ? " is-done" : ""}`}>{task.title}</span>
        <button
          type="button"
          className="emb-x"
          title="Открыть на странице задач"
          onClick={() => openTarget(targetFor("task", task.id))}
        >
          <ExternalLink size={13} />
        </button>
        <button type="button" className="emb-x" title="Убрать из заметки" onClick={onRemove}>
          <X size={13} />
        </button>
      </div>
      <div className="emb-row emb-fields">
        <label>
          <span>Статус</span>
          <select
            className="emb-sel"
            value={task.status}
            style={{ color: st.color }}
            onChange={(e) => save({ status: e.target.value as TaskStatus })}
          >
            {STATUS.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Приоритет</span>
          <select
            className="emb-sel"
            value={task.priority}
            style={{ color: (PRIO.find((p) => p.v === task.priority) ?? PRIO[1]).color }}
            onChange={(e) => save({ priority: e.target.value as TaskPriority })}
          >
            {PRIO.map((p) => (
              <option key={p.v} value={p.v}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Срок</span>
          <input
            type="date"
            className="emb-sel"
            value={(task.dueDate ?? "").slice(0, 10)}
            onChange={(e) => save({ dueDate: e.target.value || undefined } as Partial<TaskItem>)}
          />
        </label>
        {task.tags?.length > 0 && (
          <span className="emb-tags">
            {task.tags.map((t) => (
              <span key={t} className="emb-tag">
                #{t}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/** Доска Canvas прямо в заметке: на всю ширину текста, видно, как она выглядит. */
function CanvasEmbed({ file, onRemove }: { file: string; onRemove: () => void }) {
  const [objs, setObjs] = useState<Obj[] | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [width, setWidth] = useState(0);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api
      .myspaceReadHolst(file)
      .then((r) => {
        const d = (r as { data?: { objs?: Obj[]; name?: string } } | null)?.data;
        if (!live) return;
        setObjs(Array.isArray(d?.objs) ? d!.objs : null);
        setTitle(d?.name ?? file.replace(/_/g, " "));
      })
      .catch(() => live && setObjs(null));
    return () => {
      live = false;
    };
  }, [file]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    if (!objs?.length) return null;
    const map = mapById(objs);
    const vis = objs.filter((o) => !o.hidden);
    const box = unionBox(vis.map((o) => boundsOf(o, map)));
    if (!box) return null;
    const geoms = new Map<string, ReturnType<typeof lineGeom>>();
    for (const o of vis) if (o.type === "line") geoms.set(o.id, lineGeom(o, map));
    return { vis, box, geoms };
  }, [objs]);

  const PAD = 24;
  const MAX_H = 360;
  const k =
    view && width ? Math.min(1, (width - PAD * 2) / view.box.w, (MAX_H - PAD * 2) / view.box.h) : 1;
  const h = view ? Math.round(view.box.h * k + PAD * 2) : 120;
  const noop = () => undefined;

  return (
    <div className="emb emb-canvas">
      <div className="emb-row emb-head">
        <span className="emb-title">🎨 {title || file}</span>
        <button
          type="button"
          className="emb-x"
          title="Открыть доску"
          onClick={() => openTarget(targetFor("canvas", file))}
        >
          <ExternalLink size={13} />
        </button>
        <button type="button" className="emb-x" title="Убрать из заметки" onClick={onRemove}>
          <X size={13} />
        </button>
      </div>
      <div
        ref={host}
        className="emb-stage"
        style={{ height: h }}
        onDoubleClick={() => openTarget(targetFor("canvas", file))}
        title="Двойной клик — открыть доску"
      >
        {objs === undefined && <span className="muted-sm">Загрузка доски…</span>}
        {objs === null && <span className="muted-sm">Доска не найдена</span>}
        {objs && !view && <span className="muted-sm">Доска пуста</span>}
        {view && (
          <div
            style={{
              position: "absolute",
              left: PAD + (width - PAD * 2 - view.box.w * k) / 2,
              top: PAD,
              width: view.box.w,
              height: view.box.h,
              transform: `scale(${k})`,
              transformOrigin: "0 0",
              pointerEvents: "none",
            }}
          >
            <div style={{ position: "absolute", left: -view.box.x, top: -view.box.y }}>
              {view.vis.map((o) => (
                <ObjectView
                  key={o.id}
                  o={o}
                  editing={false}
                  selected={false}
                  geom={view.geoms.get(o.id)}
                  onCommit={noop}
                  onPatch={noop}
                  onMeasure={noop}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function EmbedBlock({
  kind,
  refId,
  onRemove,
}: {
  kind: string;
  refId: string;
  onRemove: () => void;
}) {
  if (kind === "task") return <TaskEmbed id={refId} onRemove={onRemove} />;
  if (kind === "canvas") return <CanvasEmbed file={refId.split("#")[0]} onRemove={onRemove} />;
  return null;
}
