import { FileText, Folder, Search, Tags, PanelLeftClose, Plus, X, Hash, Sparkles } from "lucide-react";
import { api } from "@/api/client";
import type React from "react";
import type { Side, OFile } from "@/pages/myspace/parts/MyspaceHelpers";
import type { VaultFile, VaultSearchResult, VaultTag } from "@/api/types";
import type { TranslateFn } from "@/app/i18n";

export interface LeftSidebarProps {
  narrowLeft: boolean;
  leftW: number;
  setLeftTab: React.Dispatch<React.SetStateAction<Side>>;
  leftTab: Side;
  setLeftOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCreate: React.Dispatch<React.SetStateAction<boolean>>;
  setCrType: React.Dispatch<React.SetStateAction<"note" | "folder">>;
  setCrName: React.Dispatch<React.SetStateAction<string>>;
  inputRef: React.RefObject<HTMLInputElement>;
  showCreate: boolean;
  crType: "note" | "folder";
  crName: string;
  createItem: () => Promise<void>;
  tree: VaultFile[];
  setError: React.Dispatch<React.SetStateAction<string>>;
  loadTree: () => void;
  setOpenFiles: React.Dispatch<React.SetStateAction<OFile[]>>;
  setActiveTab: React.Dispatch<React.SetStateAction<string | null>>;
  setSelPath: React.Dispatch<React.SetStateAction<string | null>>;
  renderNode: (node: VaultFile, depth?: number) => React.JSX.Element;
  setSemSearch: React.Dispatch<React.SetStateAction<boolean>>;
  t: TranslateFn;
  semSearch: boolean;
  sq: string;
  setSq: React.Dispatch<React.SetStateAction<string>>;
  sres: VaultSearchResult[];
  openFile: (p: string) => Promise<void>;
  tags: VaultTag[];
  startRes: (s: string, e: React.MouseEvent) => void;
}

export default function LeftSidebar({ narrowLeft, leftW, setLeftTab, leftTab, setLeftOpen, setShowCreate, setCrType, setCrName, inputRef, showCreate, crType, crName, createItem, tree, setError, loadTree, setOpenFiles, setActiveTab, setSelPath, renderNode, setSemSearch, t, semSearch, sq, setSq, sres, openFile, tags, startRes }: LeftSidebarProps) {
  return (
    <div
                  onClick={(e) => narrowLeft && e.stopPropagation()}
                  style={{
                    width: leftW,
                    minWidth: 220,
                    display: "flex",
                    flexDirection: "column",
                    background: "var(--surface-glass)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 12,
                    margin: "4px 0 4px 4px",
                    backdropFilter: "blur(8px)",
                    position: narrowLeft ? "absolute" : "relative",
                    left: narrowLeft ? 0 : undefined,
                    top: narrowLeft ? 0 : undefined,
                    bottom: narrowLeft ? 0 : undefined,
                    zIndex: narrowLeft ? 31 : undefined,
                    boxShadow: narrowLeft ? "var(--shadow)" : undefined,
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
                          ["explorer", FileText],
                          ["search", Search],
                          ["tags", Tags],
                        ] as const
                      ).map(([id, Icon]) => (
                        <button
                          key={id}
                          onClick={() => setLeftTab(id)}
                          style={{
                            background: leftTab === id ? "var(--track)" : "transparent",
                            border: "none",
                            padding: "4px 7px",
                            borderRadius: 6,
                            cursor: "pointer",
                            color: leftTab === id ? "var(--text-primary)" : "var(--text-tertiary)",
                          }}
                        >
                          <Icon size={13} />
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => setLeftOpen(false)}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 3,
                        cursor: "pointer",
                        color: "var(--text-tertiary)",
                      }}
                    >
                      <PanelLeftClose size={13} />
                    </button>
                  </div>
                  <div
                    style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
                  >
                    {leftTab === "explorer" && (
                      <>
                        <div style={{ display: "flex", gap: 4, padding: "4px 8px" }}>
                          <button
                            onClick={() => {
                              setShowCreate(true);
                              setCrType("note");
                              setCrName("");
                              setTimeout(() => inputRef.current?.focus(), 50);
                            }}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: "2px 5px",
                              borderRadius: 4,
                              cursor: "pointer",
                              color: "var(--text-tertiary)",
                            }}
                            title="New note"
                          >
                            <Plus size={14} />
                          </button>
                          <button
                            onClick={() => {
                              setShowCreate(true);
                              setCrType("folder");
                              setCrName("");
                              setTimeout(() => inputRef.current?.focus(), 50);
                            }}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: "2px 5px",
                              borderRadius: 4,
                              cursor: "pointer",
                              color: "var(--text-tertiary)",
                            }}
                            title="New folder"
                          >
                            <Folder size={13} />
                          </button>
                        </div>
                        {showCreate && (
                          <div
                            style={{
                              display: "flex",
                              gap: 4,
                              padding: "0 8px 6px",
                              alignItems: "center",
                            }}
                          >
                            <input
                              ref={inputRef}
                              placeholder={crType === "note" ? "Note name..." : "Folder name..."}
                              value={crName}
                              onChange={(e) => setCrName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") createItem();
                                if (e.key === "Escape") {
                                  setShowCreate(false);
                                  setCrName("");
                                }
                              }}
                              style={{
                                flex: 1,
                                padding: "3px 7px",
                                borderRadius: 6,
                                border: "1px solid var(--glass-border)",
                                background: "var(--track)",
                                outline: "none",
                                color: "var(--text-primary)",
                                fontSize: 12,
                              }}
                            />
                            <button
                              onClick={() => {
                                setShowCreate(false);
                                setCrName("");
                              }}
                              style={{
                                background: "transparent",
                                border: "none",
                                padding: 2,
                                cursor: "pointer",
                                color: "var(--text-tertiary)",
                              }}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        )}
                        <div
                          style={{ flex: 1, overflow: "auto", padding: "2px 4px", minHeight: 50 }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                          }}
                          onDrop={async (e) => {
                            e.preventDefault();
                            const src = e.dataTransfer.getData("text/plain");
                            if (!src || !src.includes("/")) return;
                            const base = src.split("/").pop() || src;
                            const exists = tree.some((n) => n.path === base);
                            if (exists) {
                              setError('A file named "' + base + '" already exists at root');
                              return;
                            }
                            try {
                              await api.myspaceRename(src, base);
                              loadTree();
                              setOpenFiles((prev) =>
                                prev.map((f) =>
                                  f.path === src ? { ...f, path: base, name: base } : f,
                                ),
                              );
                              setActiveTab((prev) => (prev === src ? base : prev));
                              setSelPath((prev) => (prev === src ? base : prev));
                              setError("");
                            } catch (ex: any) {
                              setError("Move failed: " + ex.message);
                            }
                          }}
                        >
                          {tree.length === 0 && (
                            <div
                              style={{
                                padding: 16,
                                textAlign: "center",
                                fontSize: 12,
                                color: "var(--text-tertiary)",
                              }}
                            >
                              Loading...
                            </div>
                          )}
                          {tree.map((n) => renderNode(n))}
                        </div>
                      </>
                    )}
                    {leftTab === "search" && (
                      <>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "4px 8px",
                            color: "var(--text-tertiary)",
                          }}
                        >
                          <Search size={13} style={{ flexShrink: 0 }} />
                          <button
                            type="button"
                            onClick={() => setSemSearch((v) => !v)}
                            title={t("sem.searchByMeaning")}
                            aria-pressed={semSearch}
                            style={{
                              background: semSearch ? "var(--track)" : "transparent",
                              border: "none",
                              padding: 3,
                              borderRadius: 5,
                              cursor: "pointer",
                              display: "flex",
                              flexShrink: 0,
                              color: semSearch ? "var(--amber)" : "var(--text-tertiary)",
                            }}
                          >
                            <Sparkles size={13} />
                          </button>
                          <input
                            placeholder={semSearch ? "Search by meaning..." : "Search notes..."}
                            value={sq}
                            onChange={(e) => setSq(e.target.value)}
                            autoFocus
                            style={{
                              flex: 1,
                              minWidth: 0,
                              width: 0,
                              padding: "3px 7px",
                              borderRadius: 6,
                              border: "1px solid var(--glass-border)",
                              background: "var(--track)",
                              outline: "none",
                              color: "var(--text-primary)",
                              fontSize: 12,
                            }}
                          />
                        </div>
                        <div style={{ flex: 1, overflow: "auto", padding: "2px 4px" }}>
                          {sres.map((r) => (
                            <div
                              key={r.path}
                              onClick={() => {
                                openFile(r.path);
                                setLeftTab("explorer");
                              }}
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
                              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                                {r.name}
                              </span>
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-tertiary)",
                                  lineHeight: 1.3,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {r.snippet}
                              </span>
                            </div>
                          ))}
                          {sq.trim() && sres.length === 0 && (
                            <div
                              style={{
                                padding: 16,
                                textAlign: "center",
                                fontSize: 12,
                                color: "var(--text-tertiary)",
                              }}
                            >
                              No results
                            </div>
                          )}
                        </div>
                      </>
                    )}
                    {leftTab === "tags" && (
                      <div style={{ flex: 1, overflow: "auto", padding: "2px 4px" }}>
                        {tags.map((t) => (
                          <div
                            key={t.tag}
                            onClick={() => {
                              setLeftTab("search");
                              setSq(t.tag);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "5px 8px",
                              borderRadius: 6,
                              cursor: "pointer",
                              fontSize: 12,
                            }}
                          >
                            <Hash size={12} style={{ color: "var(--amber)" }} />
                            <span style={{ flex: 1, color: "var(--text-secondary)" }}>{t.tag}</span>
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--text-tertiary)",
                                fontFamily: "var(--font-mono)",
                              }}
                            >
                              {t.count}
                            </span>
                          </div>
                        ))}
                        {tags.length === 0 && (
                          <div
                            style={{
                              padding: 16,
                              textAlign: "center",
                              fontSize: 12,
                              color: "var(--text-tertiary)",
                            }}
                          >
                            No tags yet
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div
                    onMouseDown={(e) => startRes("l", e)}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: 4,
                      cursor: "col-resize",
                    }}
                  />
                </div>
  );
}
