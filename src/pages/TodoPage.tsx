import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, Trash2, CheckSquare, Sparkles, FileText, Folder, Search,
  LayoutList, Columns3, Share2, Download, Upload, ListChecks,
  X, Calendar, Clock, Hash, Tag, RefreshCw,
} from "lucide-react";
import { Btn, IconBtn, Glass, Badge, SectionHead, Select, EmptyHint, Checkbox } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { Task, Note, GraphData } from "../api/types";
import GraphView from "../components/GraphView";
import MarkdownRenderer from "../components/MarkdownRenderer";
import NoteEditor from "../components/NoteEditor";
import NoteExplorer from "../components/NoteExplorer";
import KanbanBoard from "../components/KanbanBoard";

type ViewMode = "list" | "kanban" | "notes" | "graph";

export default function TodoPage() {
  const { t } = useI18n();
  const [view, setView] = useState<ViewMode>("list");

  // ─── Tasks ───
  const [tasks, setTasks] = useState<Task[]>([]);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("All");
  const [loaded, setLoaded] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const dragIndex = useRef<number | null>(null);

  // ─── Notes ───
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<number | 0>(0);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [noteTags, setNoteTags] = useState("");
  const [noteFolder, setNoteFolder] = useState("");
  const [noteBacklinks, setNoteBacklinks] = useState<{ id: number; title: string }[]>([]);
  const [noteWikiLinks, setNoteWikiLinks] = useState<string[]>([]);
  const [noteSearch, setNoteSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Graph ───
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphMode, setGraphMode] = useState<"full" | "local">("full");

  // ─── Initial data load (tasks + notes) ───
  const loadAll = useCallback(async () => {
    try {
      const [ts, nd] = await Promise.all([api.getTasks(), api.getNotes()]);
      setTasks(ts);
      setNotes(nd.notes);
      setFolders(nd.folders);
    } catch {}
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Reload the note list every time the Notes/Galaxy view opens (fresh data).
  useEffect(() => {
    if (view === "notes" || view === "graph") {
      api.getNotes().then((d) => { setNotes(d.notes); setFolders(d.folders); }).catch(() => {});
    }
  }, [view]);
// ─── Task handlers ───
  const addTask = async () => {
    if (!text.trim()) return;
    const task = await api.addTask(text.trim(), "Med", "General");
    setTasks((x) => [task, ...x]);
    setText("");
  };

  const toggleTask = async (id: number) => {
    const task = tasks.find((x) => x.id === id);
    if (!task) return;
    await api.toggleTask(id, !task.done);
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, done: task.done ? 0 : 1 } : x)));
  };

  const removeTask = async (id: number) => {
    await api.deleteTask(id);
    setTasks((prev) => prev.filter((x) => x.id !== id));
  };

  const onDragStart = (i: number) => () => { dragIndex.current = i; };
  const onDragOver = (e: React.DragEvent) => e.preventDefault();
  const onDrop = async (i: number) => {
    const from = dragIndex.current;
    if (from === null || from === i) return;
    setTasks((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(from, 1);
      copy.splice(i, 0, moved);
      api.reorderTasks(copy.map((x) => x.id)).catch(() => {});
      return copy;
    });
    dragIndex.current = null;
  };

  // ─── Note handlers ───
  const loadNote = async (id: number) => {
    try {
      const note = await api.getNote(id);
      setActiveNoteId(note.id);
      setNoteTitle(note.title);
      setNoteContent(note.content);
      setNoteTags(note.tags || "");
      setNoteFolder(note.folder || "");
      setNoteBacklinks(note.backlinks || []);
      setNoteWikiLinks(note.wikiLinks || []);
    } catch {}
  };

  const createNote = async (folder?: string) => {
    try {
      const title = "Untitled";
      const note = await api.createNote(title, "", "", folder || "");
      setNotes((prev) => [...prev, note]);
      setFolders((prev) => (folder && !prev.includes(folder) ? [...prev, folder] : prev));
      loadNote(note.id);
    } catch {}
  };

  const saveNote = useCallback(() => {
    if (!activeNoteId) return;
    setSaving(true);
    api.updateNote(activeNoteId, { title: noteTitle, content: noteContent, tags: noteTags, folder: noteFolder })
      .then((updated) => {
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
        setSaving(false);
        if ((updated as any).createdNotes?.length) {
          api.getNotes().then((d) => { setNotes(d.notes); setFolders(d.folders); }).catch(() => {});
        }
      })
      .catch(() => setSaving(false));
  }, [activeNoteId, noteTitle, noteContent, noteTags, noteFolder]);

  // Auto-save debounce
  useEffect(() => {
    if (!activeNoteId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNote, 1000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [noteContent, noteTitle, noteTags, noteFolder, activeNoteId, saveNote]);

  const deleteNote = async (id: number) => {
    try {
      await api.deleteNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
      if (activeNoteId === id) {
        setActiveNoteId(0);
        setNoteTitle("");
        setNoteContent("");
        setNoteTags("");
        setNoteFolder("");
        setNoteBacklinks([]);
      }
    } catch {}
  };

  const deleteAllNotes = async () => {
    if (!window.confirm("Delete ALL notes? This cannot be undone.")) return;
    try {
      await api.deleteAllNotes();
      setNotes([]);
      setFolders([]);
      setActiveNoteId(0);
      setNoteTitle("");
      setNoteContent("");
      setNoteTags("");
      setNoteFolder("");
      setNoteBacklinks([]);
    } catch {}
  };

  const importVault = async () => {
    const dir = prompt("Enter path to your Obsidian vault folder:");
    if (!dir) return;
    try {
      const result = await api.importVault(dir);
      alert(`Imported ${result.imported}, skipped ${result.skipped} (total ${result.total} files)`);
      const d = await api.getNotes();
      setNotes(d.notes);
      setFolders(d.folders);
    } catch (e: any) { alert(e.message || "Import failed"); }
  };

  const handleWikiLink = (title: string) => {
    const found = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (found) loadNote(found.id);
  };

  const exportNote = (id: number) => {
    const a = document.createElement("a");
    a.href = "/api/tasks/notes/" + id + "/export";
    a.click();
  };
// ─── Graph ───
  const loadGraph = useCallback(async () => {
    try {
      const nid = graphMode === "local" && activeNoteId ? activeNoteId : 0;
      const g = await api.getGraph(nid || undefined);
      setGraph(g);
    } catch {}
  }, [graphMode, activeNoteId]);

  useEffect(() => { if (view === "graph") loadGraph(); }, [view, loadGraph]);

  const openNoteFromGraph = (node: any) => {
    if (node.type === "note" && node.noteId) {
      loadNote(node.noteId);
      setView("notes");
    }
  };

  // ─── View ───
  const open = tasks.filter((x) => !x.done).length;
  const visible = tasks.filter((x) => (filter === "All" ? true : filter === "Active" ? !x.done : x.done));

  usePageToolbar(
    view === "list" || view === "kanban" ? (
      <Select value={filter} onChange={(e) => setFilter(e.target.value)} options={["All", "Active", "Done"]} />
    ) : null,
    [filter, view]
  );
return (
    <div className="page page-fill">
      <SectionHead eyebrow={t("todo.eyebrow", { n: open })} title={t("todo.title")}
        action={
          <div className="view-tabs">
            <button className={`view-tab ${view === "list" ? "is-active" : ""}`} onClick={() => setView("list")}><ListChecks size={14} /> List</button>
            <button className={`view-tab ${view === "kanban" ? "is-active" : ""}`} onClick={() => setView("kanban")}><Columns3 size={14} /> Kanban</button>
            <button className={`view-tab ${view === "notes" ? "is-active" : ""}`} onClick={() => setView("notes")}><FileText size={14} /> Notes</button>
            <button className={`view-tab ${view === "graph" ? "is-active" : ""}`} onClick={() => setView("graph")}><Share2 size={14} /> Graph</button>
          </div>
        } />

      {/* ── LIST VIEW ── */}
      {view === "list" && (
        <>
          <Glass className="url-bar">
            <Plus size={16} />
            <input placeholder={t("todo.placeholder")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} />
            <Btn variant="primary" onClick={addTask}>{t("todo.add")}</Btn>
          </Glass>

          <div className="task-list">
            {visible.map((task, i) => (
              <Glass className={`task-row ${task.done ? "is-done" : ""}`} key={task.id}
                draggable onDragStart={onDragStart(i)} onDragOver={onDragOver} onDrop={() => onDrop(i)}>
                <span className="drag-handle" style={{ cursor: "grab" }}>⠿</span>
                <Checkbox checked={!!task.done} onClick={() => toggleTask(task.id)} />
                <span className="task-text">{task.text}</span>
                <Badge tone={task.priority === "High" ? "coral" : task.priority === "Med" ? "amber" : "teal"}>{task.priority}</Badge>
                <span className="tag-chip">{task.tag}</span>
                <IconBtn icon={Trash2} onClick={() => removeTask(task.id)} title={t("todo.deleteTitle")} />
              </Glass>
            ))}
            {loaded && visible.length === 0 && <EmptyHint icon={CheckSquare} text={t("todo.empty")} />}
          </div>

          <Glass className="source-placeholder">
            <Sparkles size={16} />
            <span>{t("todo.smart")}</span>
          </Glass>
        </>
      )}

      {/* ── KANBAN VIEW ── */}
      {view === "kanban" && (
        <KanbanBoard tasks={tasks} onToggle={toggleTask} onEdit={(t) => setEditTask(t)} onDelete={removeTask} />
      )}

      {/* ── NOTES VIEW (Obsidian-style) ── */}
      {view === "notes" && (
        <div className="todo-layout">
          <NoteExplorer notes={notes} folders={folders} activeId={activeNoteId}
            onSelect={(n) => loadNote(n.id)} onNewNote={createNote} onImportVault={importVault} onDeleteAll={deleteAllNotes}
            query={noteSearch} onQueryChange={setNoteSearch} />

          <div className="note-main">
            {activeNoteId ? (
              <>
                <div className="note-meta">
                  <input className="note-title-input" value={noteTitle}
                    onChange={(e) => setNoteTitle(e.target.value)} placeholder="Untitled" />
                  <div className="note-meta-right">
                    <span className="note-save-status">
                      {saving ? "Saving..." : "Auto-saved"}
                    </span>
                    <IconBtn icon={Download} onClick={() => exportNote(activeNoteId)} title="Export .md" />
                    <IconBtn icon={Trash2} onClick={() => deleteNote(activeNoteId)} title="Delete note" />
                  </div>
                </div>

                <div className="note-tags-row">
                  {noteTags.split(",").filter(Boolean).map((tag, i) => (
                    <span key={i} className="note-tag">#{tag.trim()}</span>
                  ))}
                  <input className="note-tag-input" value={noteTags}
                    onChange={(e) => setNoteTags(e.target.value)}
                    placeholder={noteTags ? "" : "#tag1, #tag2, ..."} />
                </div>

                <NoteEditor content={noteContent} onChange={setNoteContent}
                  onWikiLink={handleWikiLink} onTagClick={(tag) => setNoteTags((t) => t ? t + "," + tag.slice(1) : tag.slice(1))} />

                {noteBacklinks.length > 0 && (
                  <div className="note-backlinks">
                    <div className="note-backlinks-title">Backlinks ({noteBacklinks.length})</div>
                    {noteBacklinks.map((bl) => (
                      <div key={bl.id} className="note-backlinks-item" onClick={() => loadNote(bl.id)}>
                        {bl.title}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="note-empty">
                <FileText size={24} strokeWidth={1.4} />
                <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Select a note or create a new one</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── GRAPH VIEW ── */}
      {view === "graph" && (
        <div className="todo-layout">
          <div className="graph-panel">
            <div className="graph-mode-btns">
              <button className={`graph-mode-btn ${graphMode === "full" ? "is-active" : ""}`} onClick={() => setGraphMode("full")}>Full Graph</button>
              <button className={`graph-mode-btn ${graphMode === "local" ? "is-active" : ""}`} onClick={() => setGraphMode("local")}>Local Graph</button>
              <button className="graph-mode-btn" onClick={loadGraph}><RefreshCw size={12} /> Refresh</button>
            </div>
            {graph && graph.nodes.length > 0 ? (
              <div className="graph-wrap">
                <GraphView data={graph} onNodeClick={openNoteFromGraph} />
              </div>
            ) : (
              <EmptyHint icon={Share2} text="No connections yet. Add [[wiki links]] to your notes to build the graph." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}