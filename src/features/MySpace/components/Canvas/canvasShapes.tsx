import { BaseBoxShapeUtil, HTMLContainer } from "tldraw";

export interface HolstNoteData {
  type: "note";
  title: string;
  body: string;
  tags?: string[];
  filePath?: string;
}

export interface HolstTaskData {
  type: "task";
  title: string;
  status: string;
  priority?: string;
  progress?: number;
  taskId?: string;
}

export class NoteCardUtil extends BaseBoxShapeUtil<HolstNoteData> {
  static type = "noteCard" as const;

  getDefaultProps(): HolstNoteData {
    return { type: "note", title: "Note", body: "", tags: [] };
  }

  component(shape: any) {
    const { title, body } = shape.props as HolstNoteData;
    return (
      <HTMLContainer>
        <div className="holst-note-card">
          <div className="title">{title || "Note"}</div>
          {body && <div className="body">{body.slice(0, 200)}</div>}
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />;
  }
}

export class TaskCardUtil extends BaseBoxShapeUtil<HolstTaskData> {
  static type = "taskCard" as const;

  getDefaultProps(): HolstTaskData {
    return { type: "task", title: "Task", status: "todo", progress: 0 };
  }

  component(shape: any) {
    const { title, status, progress } = shape.props as HolstTaskData;
    const statusColor =
      status === "done" ? "#00d4d4" :
      status === "in_progress" ? "#f0c040" :
      status === "deferred" ? "#888" : "#668";
    return (
      <HTMLContainer>
        <div className="holst-task-card">
          <div className="title">{title || "Task"}</div>
          <span className="status-badge" style={{ background: statusColor + "22", color: statusColor }}>
            {status.replace("_", " ")}
          </span>
          {typeof progress === "number" && progress > 0 && (
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%`, background: statusColor }} />
            </div>
          )}
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />;
  }
}