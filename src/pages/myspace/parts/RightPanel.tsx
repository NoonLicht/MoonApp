import { Search, Sparkles, PanelRightClose, Link2, Type, Globe, Maximize2 } from "lucide-react";
import { SemanticPanel } from "@/pages/myspace/parts/SemanticPanel";
import GraphView from "@/pages/myspace/parts/GraphLazy";
import type React from "react";
import type { Right, OFile } from "@/pages/myspace/parts/MyspaceHelpers";
import type { GraphData } from "@/api/types";

export interface RightPanelProps {
  narrowRight: boolean;
  rightW: number;
  setRightTab: React.Dispatch<React.SetStateAction<Right>>;
  rightTab: Right;
  setRightOpen: React.Dispatch<React.SetStateAction<boolean>>;
  activeTab: string | null;
  edContent: string;
  openFile: (p: string) => Promise<void>;
  updContent: (p: string, c: string) => void;
  rightSplit: number;
  openFiles: OFile[];
  setRightSplit: React.Dispatch<React.SetStateAction<number>>;
  setGraphFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  setGraphDepth: React.Dispatch<React.SetStateAction<number>>;
  setGraphShowOrphans: React.Dispatch<React.SetStateAction<boolean>>;
  setGraphSearch: React.Dispatch<React.SetStateAction<string>>;
  graphData: GraphData;
  graphSearch: string;
  graphShowOrphans: boolean;
  graphDepth: number;
  startRes: (s: string, e: React.MouseEvent) => void;
}

export default function RightPanel({ narrowRight, rightW, setRightTab, rightTab, setRightOpen, activeTab, edContent, openFile, updContent, rightSplit, openFiles, setRightSplit, setGraphFullscreen, setGraphDepth, setGraphShowOrphans, setGraphSearch, graphData, graphSearch, graphShowOrphans, graphDepth, startRes }: RightPanelProps) {
  return (
    <div
                  onClick={(e) => narrowRight && e.stopPropagation()}
                  style={{
                    width: rightW,
                    minWidth: 200,
                    display: "flex",
                    flexDirection: "column",
                    background: "var(--surface-glass)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 12,
                    margin: "4px 4px 4px 0",
                    backdropFilter: "blur(8px)",
                    position: narrowRight ? "absolute" : "relative",
                    right: narrowRight ? 0 : undefined,
                    top: narrowRight ? 0 : undefined,
                    bottom: narrowRight ? 0 : undefined,
                    zIndex: narrowRight ? 31 : undefined,
                    boxShadow: narrowRight ? "var(--shadow)" : undefined,
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      borderBottom: "1px solid var(--glass-border)",
                    }}
                  >
                    <div style={{ display: "flex", gap: 2 }}>
                      {(
                        [
                          ["backlinks", Link2],
                          ["outline", Type],
                          ["graph", Globe],
                          ["similar", Sparkles],
                        ] as const
                      ).map(([id, Icon]) => (
                        <button
                          key={id}
                          onClick={() => setRightTab(id as any)}
                          style={{
                            background: rightTab === id ? "var(--track)" : "transparent",
                            border: "none",
                            padding: "4px 7px",
                            borderRadius: 6,
                            cursor: "pointer",
                            color: rightTab === id ? "var(--text-primary)" : "var(--text-tertiary)",
                          }}
                        >
                          <Icon size={13} />
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => setRightOpen(false)}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 3,
                        cursor: "pointer",
                        color: "var(--text-tertiary)",
                      }}
                    >
                      <PanelRightClose size={13} />
                    </button>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      minHeight: 0,
                      overflow: "hidden",
                    }}
                  >
                    {rightTab === "similar" && (
                      <SemanticPanel
                        note={activeTab}
                        content={edContent}
                        onOpenNote={(p) => void openFile(p)}
                        onInsertLink={(name) => {
                          if (!activeTab) return;
                          const base = edContent.replace(/\s+$/, "");
                          updContent(activeTab, `${base}${base ? " " : ""}[[${name}]]\n`);
                        }}
                        onAddTag={(tag) => {
                          if (!activeTab) return;
                          const t = tag.startsWith("#") ? tag : `#${tag}`;
                          const lines = edContent.replace(/\s+$/, "").split("\n");
                          const last = lines[lines.length - 1] ?? "";
                          if (/^(#\S+\s*)+$/.test(last)) lines[lines.length - 1] = `${last} ${t}`;
                          else lines.push("", t);
                          updContent(activeTab, `${lines.join("\n")}\n`);
                        }}
                      />
                    )}
                    {rightTab === "backlinks" && (
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          minHeight: 0,
                          position: "relative",
                        }}
                      >
                        {/* Top: Backlinks panel (resizable) */}
                        <div
                          style={{
                            flex: rightSplit,
                            overflow: "auto",
                            padding: "4px 6px",
                            minHeight: 100,
                          }}
                        >
                          {(() => {
                            const af = openFiles.find((f) => f.path === activeTab);
                            if (!af)
                              return (
                                <div
                                  style={{
                                    padding: 16,
                                    textAlign: "center",
                                    fontSize: 12,
                                    color: "var(--text-tertiary)",
                                  }}
                                >
                                  Open a note to see backlinks
                                </div>
                              );
                            const bl = af.backlinks;
                            const linked = bl.filter((b) => b.type === "linked");
                            const unlinked = bl.filter((b) => b.type === "unlinked");
                            return (
                              <>
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: "var(--text-secondary)",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.03em",
                                    padding: "4px 8px",
                                    marginBottom: 2,
                                  }}
                                >
                                  Linked ({linked.length})
                                </div>
                                {linked.map((b) => (
                                  <div
                                    key={b.path}
                                    onClick={() => openFile(b.path)}
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 2,
                                      padding: "5px 8px",
                                      borderRadius: 6,
                                      cursor: "pointer",
                                      fontSize: 12,
                                      borderBottom: "1px solid var(--glass-border)",
                                    }}
                                  >
                                    <span style={{ fontWeight: 600, color: "var(--amber)" }}>
                                      {b.name}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 11,
                                        color: "var(--text-tertiary)",
                                        lineHeight: 1.3,
                                      }}
                                    >
                                      {b.snippet}
                                    </span>
                                  </div>
                                ))}
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: "var(--text-secondary)",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.03em",
                                    padding: "4px 8px",
                                    marginTop: 8,
                                    marginBottom: 2,
                                  }}
                                >
                                  Unlinked ({unlinked.length})
                                </div>
                                {unlinked.map((b) => (
                                  <div
                                    key={b.path}
                                    onClick={() => openFile(b.path)}
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 2,
                                      padding: "5px 8px",
                                      borderRadius: 6,
                                      cursor: "pointer",
                                      fontSize: 12,
                                      borderBottom: "1px solid var(--glass-border)",
                                    }}
                                  >
                                    <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
                                      {b.name}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 11,
                                        color: "var(--text-tertiary)",
                                        lineHeight: 1.3,
                                      }}
                                    >
                                      {b.snippet}
                                    </span>
                                  </div>
                                ))}
                                {bl.length === 0 && (
                                  <div
                                    style={{
                                      padding: 16,
                                      textAlign: "center",
                                      fontSize: 12,
                                      color: "var(--text-tertiary)",
                                    }}
                                  >
                                    No backlinks
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                        {/* Horizontal resize handle */}
                        <div
                          style={{
                            height: 4,
                            cursor: "row-resize",
                            background: "transparent",
                            flexShrink: 0,
                            position: "relative",
                            zIndex: 5,
                          }}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            const el = e.currentTarget.parentElement;
                            if (!el) return;
                            const startY = e.clientY;
                            const startPct = rightSplit;
                            const totalH = el.clientHeight;
                            const onMove = (ev: MouseEvent) => {
                              const dy = ev.clientY - startY;
                              let pct = startPct + (dy / totalH) * 100;
                              pct = Math.max(25, Math.min(80, pct));
                              setRightSplit(pct);
                            };
                            const onUp = () => {
                              document.removeEventListener("mousemove", onMove);
                              document.removeEventListener("mouseup", onUp);
                            };
                            document.addEventListener("mousemove", onMove);
                            document.addEventListener("mouseup", onUp);
                          }}
                        />
                        {/* Bottom: Mini graph */}
                        <div
                          style={{
                            flex: 100 - rightSplit,
                            display: "flex",
                            flexDirection: "column",
                            minHeight: 80,
                            overflow: "hidden",
                            borderTop: "1px solid var(--glass-border)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "4px 6px",
                              borderBottom: "1px solid var(--glass-border)",
                              flexShrink: 0,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: "var(--text-secondary)",
                                textTransform: "uppercase",
                                letterSpacing: "0.03em",
                              }}
                            >
                              Local Graph
                            </span>
                            <button
                              onClick={() => setGraphFullscreen(true)}
                              style={{
                                background: "transparent",
                                border: "none",
                                padding: 3,
                                cursor: "pointer",
                                color: "var(--text-tertiary)",
                                display: "flex",
                              }}
                              title="Expand graph"
                            >
                              <Maximize2 size={12} />
                            </button>
                            <button
                              onClick={() => {
                                setGraphDepth(5);
                                setGraphShowOrphans(true);
                                setGraphSearch("");
                              }}
                              style={{
                                background: "transparent",
                                border: "1px solid var(--glass-border)",
                                padding: "1px 5px",
                                cursor: "pointer",
                                color: "var(--teal)",
                                display: "flex",
                                borderRadius: 4,
                                fontSize: 10,
                                alignItems: "center",
                                gap: 2,
                              }}
                              title="Show all"
                            >
                              <Globe size={10} /> All
                            </button>
                          </div>
                          <div
                            style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}
                          >
                            <GraphView
                              data={graphData}
                              onNodeClick={(node) => {
                                openFile(node.id);
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    {rightTab === "outline" && (
                      <div style={{ flex: 1, overflow: "auto", padding: "4px 6px" }}>
                        {(() => {
                          const af = openFiles.find((f) => f.path === activeTab);
                          if (!af)
                            return (
                              <div
                                style={{
                                  padding: 16,
                                  textAlign: "center",
                                  fontSize: 12,
                                  color: "var(--text-tertiary)",
                                }}
                              >
                                Open a note to see outline
                              </div>
                            );
                          return (
                            <>
                              {af.outline.map((h, i) => (
                                <div
                                  key={i}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 4,
                                    padding: "3px 6px",
                                    paddingLeft: 6 + (h.level - 1) * 14,
                                    cursor: "pointer",
                                    borderRadius: 4,
                                    fontSize: 12,
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: 10,
                                      color: "var(--text-tertiary)",
                                      fontFamily: "var(--font-mono)",
                                      minWidth: 14,
                                    }}
                                  >
                                    H{h.level}
                                  </span>
                                  <span style={{ color: "var(--text-secondary)" }}>{h.text}</span>
                                </div>
                              ))}
                              {af.outline.length === 0 && (
                                <div
                                  style={{
                                    padding: 16,
                                    textAlign: "center",
                                    fontSize: 12,
                                    color: "var(--text-tertiary)",
                                  }}
                                >
                                  No headings
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                    {rightTab === "graph" && (
                      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "4px 6px",
                            borderBottom: "1px solid var(--glass-border)",
                            flexShrink: 0,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: "var(--text-secondary)",
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                            }}
                          >
                            Global Graph
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
                              padding: "1px 6px",
                              cursor: "pointer",
                              color: "var(--teal)",
                              display: "flex",
                              borderRadius: 4,
                              fontSize: 10,
                              alignItems: "center",
                              gap: 2,
                              marginLeft: "auto",
                            }}
                            title="Show all"
                          >
                            <Globe size={10} /> All
                          </button>
                          <button
                            onClick={() => setGraphFullscreen(true)}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: 3,
                              cursor: "pointer",
                              color: "var(--text-tertiary)",
                              display: "flex",
                            }}
                            title="Fullscreen"
                          >
                            <Maximize2 size={12} />
                          </button>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "3px 6px",
                            borderBottom: "1px solid var(--glass-border)",
                            flexShrink: 0,
                            flexWrap: "wrap",
                          }}
                        >
                          <Search size={11} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                          <input
                            placeholder="Filter nodes..."
                            value={graphSearch}
                            onChange={(e) => setGraphSearch(e.target.value)}
                            style={{
                              flex: 1,
                              minWidth: 40,
                              padding: "2px 4px",
                              border: "none",
                              background: "transparent",
                              outline: "none",
                              color: "var(--text-primary)",
                              fontSize: 11,
                            }}
                          />
                          <label
                            style={{
                              fontSize: 10,
                              color: "var(--text-tertiary)",
                              display: "flex",
                              alignItems: "center",
                              gap: 2,
                              flexShrink: 0,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={graphShowOrphans}
                              onChange={(e) => setGraphShowOrphans(e.target.checked)}
                            />{" "}
                            Orphans
                          </label>
                          <label
                            style={{
                              fontSize: 10,
                              color: "var(--text-tertiary)",
                              display: "flex",
                              alignItems: "center",
                              gap: 2,
                              flexShrink: 0,
                            }}
                          >
                            Depth
                            <select
                              value={graphDepth}
                              onChange={(e) => setGraphDepth(Number(e.target.value))}
                              style={{
                                padding: "1px 2px",
                                border: "1px solid var(--glass-border)",
                                background: "var(--track)",
                                color: "var(--text-primary)",
                                fontSize: 10,
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
                        </div>
                        <div
                          style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}
                        >
                          <GraphView
                            data={graphData}
                            onNodeClick={(node) => {
                              openFile(node.id);
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div
                    onMouseDown={(e) => startRes("r", e)}
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: 4,
                      cursor: "col-resize",
                    }}
                  />
                </div>
  );
}
