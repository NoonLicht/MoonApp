import type { TasksPanelProps } from "@/pages/myspace/parts/TasksPanelUi";
import { useTasksPanel } from "@/pages/myspace/parts/useTasksPanel";
import TasksPanelView from "@/pages/myspace/parts/TasksPanelView";

export default function TasksPanel({ onOpenNote }: TasksPanelProps) {
  const c = useTasksPanel({ onOpenNote });
  return <TasksPanelView c={c} />;
}
