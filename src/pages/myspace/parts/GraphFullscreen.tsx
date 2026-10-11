import { Search, X, Globe } from "lucide-react";
import GraphView from "@/pages/myspace/parts/GraphView";
import type React from "react";
import type { GraphData } from "@/api/types";

export interface GraphFullscreenProps {
  setGraphFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  setGraphDepth: React.Dispatch<React.SetStateAction<number>>;
  setGraphShowOrphans: React.Dispatch<React.SetStateAction<boolean>>;
  setGraphSearch: React.Dispatch<React.SetStateAction<string>>;
  graphShowOrphans: boolean;
  graphDepth: number;
  graphSearch: string;
  graphData: GraphData;
  openFile: (p: string) => Promise<void>;
}

export default function GraphFullscreen({ setGraphFullscreen, setGraphDepth, setGraphShowOrphans, setGraphSearch, graphShowOrphans, graphDepth, graphSearch, graphData, openFile }: GraphFullscreenProps) {
  return (
    <div className="graph-fs-backdrop" onClick={() => setGraphFullscreen(false)}>
                <div className="graph-fs-panel glass-solid" onClick={(e) => e.stopPropagation()}>
                  <div className="graph-fs-header">
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
                        Graph View
                      </span>
                      <button
                        onClick={() => {
                          setGraphDepth(5);
                          setGraphShowOrphans(true);
                          setGraphSearch("");
                        }}
                        style={{
                          background: "transparent",
                          border: "1px solid var(--glass-border)",
                          padding: "3px 10px",
                          cursor: "pointer",
                          color: "var(--teal)",
                          display: "flex",
                          borderRadius: 6,
                          fontSize: 12,
                          alignItems: "center",
                          gap: 4,
                        }}
                        title="Show all nodes and connections"
                      >
                        <Globe size={13} /> Show all
                      </button>
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text-tertiary)",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
                          <input
                            type="checkbox"
                            checked={graphShowOrphans}
                            onChange={(e) => setGraphShowOrphans(e.target.checked)}
                          />{" "}
                          Orphans
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
                          Depth
                          <select
                            value={graphDepth}
                            onChange={(e) => setGraphDepth(Number(e.target.value))}
                            style={{
                              padding: "2px 6px",
                              border: "1px solid var(--glass-border)",
                              background: "var(--track)",
                              color: "var(--text-primary)",
                              fontSize: 11,
                              borderRadius: 4,
                            }}
                          >
                            {[1, 2, 3, 4, 5].map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </label>
                      </span>
                      <button
                        onClick={() => setGraphFullscreen(false)}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: "4px 10px",
                          cursor: "pointer",
                          color: "var(--text-tertiary)",
                          display: "flex",
                          borderRadius: 6,
                        }}
                        title="Close (Esc)"
                      >
                        <X size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="graph-fs-search">
                    <Search size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                    <input
                      placeholder="Search nodes..."
                      value={graphSearch}
                      onChange={(e) => setGraphSearch(e.target.value)}
                      style={{
                        flex: 1,
                        padding: "4px 8px",
                        border: "none",
                        background: "transparent",
                        outline: "none",
                        color: "var(--text-primary)",
                        fontSize: 13,
                      }}
                    />
                  </div>
                  <div className="graph-fs-canvas">
                    <GraphView
                      data={graphData}
                      onNodeClick={(node) => {
                        openFile(node.id);
                      }}
                    />
                  </div>
                </div>
              </div>
  );
}
