/* ============================================================
   Holst Canvas — types & flat JSON document model (.holst)
   ============================================================ */

export type ShapeKind = "rect" | "rounded" | "circle" | "diamond" | "star" | "cloud";
export type ConnectorStyle = "straight" | "bezier" | "step";
export type LineDash = "solid" | "dashed" | "dotted";
export type TaskStatus = "todo" | "inprogress" | "done";
export type CanvasTool =
  | "select" | "hand" | "sticky" | "text" | "shape" | "connector"
  | "frame" | "task" | "pen" | "sticker";

/** All node data payloads are plain JSON — never class instances (RAM guardrails). */
export interface StickyData { text: string; color: string; votes?: number }
export interface TextData { text: string; fontSize: number; weight: number; align: "left" | "center" | "right"; color?: string }
export interface ShapeData { shape: ShapeKind; label: string; fill: string; stroke: string }
export interface FrameData { label: string; color: string; w: number; h: number }
export interface TaskData { title: string; status: TaskStatus; due?: string; subtasks: { text: string; done: boolean }[] }
export interface MdData { path: string; name: string; preview?: string; loaded?: boolean }
export interface MatrixData { title: string; columns: string[]; items: { col: number; text: string; color: string }[] }
export interface StrokeData { points: [number, number][]; color: string; width: number; opacity: number }
export interface StickerData { emoji: string }

export interface ConnectorData {
  style: ConnectorStyle;
  dash: LineDash;
  arrowStart: boolean;
  arrowEnd: boolean;
  animated: boolean;
}

export interface HolstDoc {
  version: 2;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  viewport?: { x: number; y: number; zoom: number };
  updatedAt: string;
}

export const STICKY_COLORS = ["#fef08a", "#fbcfe8", "#bfdbfe", "#bbf7d0", "#e9d5ff", "#fed7aa"];
export const SHAPE_FILLS = ["#fef08a", "#fbcfe8", "#bfdbfe", "#bbf7d0", "#e9d5ff", "#fed7aa", "#e5e7eb"];

export const EMPTY_CONNECTOR: ConnectorData = {
  style: "bezier", dash: "solid", arrowStart: false, arrowEnd: true, animated: false,
};
