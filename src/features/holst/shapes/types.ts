import { T } from "@tldraw/tldraw";

/**
 * Shape props for custom Holst shapes.
 * Each shape stores minimal metadata; note content lives in .md files on disk.
 */

export const customNoteShapeProps = {
  /** Path to the referenced .md file (relative to vault/notes/) */
  notePath: T.string,
  /** Rendered Markdown preview (cached) */
  markdown: T.string,
  /** List of associated tag names */
  tags: T.arrayOf(T.string),
  /** [[WikiLinks]] extracted from the note */
  wikiLinks: T.arrayOf(T.string),
  /** Completion ratio 0–1 for task-style rendering */
  progress: T.number,
  /** Color accent (theme token name) */
  accentColor: T.string,
  /** Creation timestamp ISO */
  createdAt: T.string,
  /** Last-modified timestamp ISO */
  modifiedAt: T.string,
};

export const customTaskShapeProps = {
  title: T.string,
  description: T.string,
  status: T.string, // "todo" | "in_progress" | "done" | "deferred"
  assignee: T.string,
  dueDate: T.string,
  priority: T.string, // "low" | "medium" | "high" | "urgent"
  progress: T.number, // 0–100
  tags: T.arrayOf(T.string),
  /** Backlink to task ID in the tasks DB */
  taskId: T.string,
};

export const pipelineNodeShapeProps = {
  title: T.string,
  status: T.string, // "queued" | "running" | "passed" | "failed" | "skipped"
  stage: T.number,
  logs: T.string,
  duration: T.number, // ms
  inputPorts: T.arrayOf(T.string),
  outputPorts: T.arrayOf(T.string),
};

export const kanbanFrameShapeProps = {
  title: T.string,
  columnStatus: T.string, // maps to task status
  color: T.string,
  /** Child shape IDs that are cards within this column */
  cardIds: T.arrayOf(T.string),
};