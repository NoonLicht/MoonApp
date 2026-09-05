import ELK from "elkjs/lib/elk.bundled.js";

const elk = new ELK();

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface LayoutResult {
  nodes: Array<{ id: string; x: number; y: number }>;
}

/**
 * Auto-arrange shapes using ELK (hierarchical / layered layout).
 * @param nodes  Shapes to arrange
 * @param edges  Connections between shapes
 * @returns      Map of id → { x, y }
 */
export async function autoLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Promise<LayoutResult> {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing": "60",
      "elk.layered.nodePlacement.strategy": "INTERACTIVE",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const result = await elk.layout(graph);

  const positions: Array<{ id: string; x: number; y: number }> = [];
  for (const child of result.children || []) {
    positions.push({
      id: child.id,
      x: child.x ?? 0,
      y: child.y ?? 0,
    });
  }
  return { nodes: positions };
}

/**
 * Arrange nodes in a horizontal pipeline sequence.
 */
export function pipelineLayout(
  nodes: LayoutNode[],
  startX = 100,
  startY = 100,
  spacing = 120
): LayoutResult {
  const positioned = nodes.map((n, i) => ({
    id: n.id,
    x: startX + i * (n.width + spacing),
    y: startY,
  }));
  return { nodes: positioned };
}