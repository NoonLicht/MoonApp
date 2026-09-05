/* MySpace Holst types */

export type HolstNodeType =
  | "sticky"
  | "shape"
  | "frame"
  | "noteCard"
  | "taskCard"
  | "text"
  | "image";

export type ShapeGeometry =
  | "rectangle"
  | "circle"
  | "triangle"
  | "diamond"
  | "star"
  | "speechBubble"
  | "hexagon";

export interface HolstNodeData extends Record<string, unknown> {
  text?: string;
  color?: string;
  shapeType?: ShapeGeometry;
  fontSize?: number;
  fontWeight?: string;
  fontFamily?: string;
  textAlign?: CanvasTextAlign;
  strokeColor?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  borderStyle?: "solid" | "dashed" | "dotted";
  notePath?: string;
  taskId?: string;
  src?: string;
  locked?: boolean;
  /** Frame - child node IDs */
  childNodeIds?: string[];
}

export interface HolstFile {
  version: number;
  viewport: { x: number; y: number; zoom: number };
  nodes: HolstNode[];
  edges: HolstEdge[];
  metadata: {
    name: string;
    created: string;
    modified: string;
  };
}

export interface HolstNode {
  id: string;
  type: HolstNodeType;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: HolstNodeData;
  style?: Record<string, string>;
  zIndex?: number;
  selected?: boolean;
  dragging?: boolean;
}

export interface HolstEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
  type?: "straight" | "smoothstep" | "bezier" | "default";
  style?: {
    stroke?: string;
    strokeWidth?: number;
    strokeDasharray?: string;
  };
  sourceHandle?: string;
  targetHandle?: string;
  startArrow?: "none" | "arrowclosed" | "arrowopen";
  endArrow?: "none" | "arrowclosed" | "arrowopen";
}