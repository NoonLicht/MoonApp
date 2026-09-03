import React from "react";
import { FileText, Folder, Plus, Search, Trash2 } from "lucide-react";
import type { Note } from "../api/types";

interface Props {
  notes: Note[]; folders: string[];
  activeId?: number;
  onSelect: (note: Note) => void;
  onNewNote: (folder?: string) => void;
  onImportVault: () => void;
  onDeleteAll: () => void;
  query: string; onQueryChange: (q: string) => void;
}

export default function NoteExplorer({ notes, folders, activeId, onSelect, onNewNote, onImportVault, onDeleteAll, query, onQueryChange }: Props) {
  const filtered = query.trim() ? notes.filter(n => n.title.toLowerCase().includes(query.toLowerCase()) || n.content.toLowerCase().includes(query.toLowerCase())) : notes;
  const byFolder: Record<string, Note[]> = {};
  for (const n of filtered) { const f = n.folder || "(root)"; if (!byFolder[f]) byFolder[f] = []; byFolder[f].push(n); }

  return (
    <div className="note-explorer">
      <div className="note-explorer-header">
        <span className="note-explorer-title">Files</span>
        <button className="icon-btn" onClick={() => onNewNote()} title="New note"><Plus size={14} /></button>
        <button className="icon-btn" onClick={onImportVault} title="Import Obsidian vault"><Folder size={14} /></button>
        <button className="icon-btn" onClick={onDeleteAll} title="Delete all notes"><Trash2 size={14} /></button>
      </div>
      <div className="note-explorer-search">
        <Search size={13} />
        <input placeholder="Search notes..." value={query} onChange={e => onQueryChange(e.target.value)} />
      </div>
      <div className="note-explorer-list">
        {Object.entries(byFolder).map(([folder, items]) => (
          <div key={folder} className="note-explorer-group">
            <div className="note-explorer-folder"><Folder size={12} /> {folder}</div>
            {items.map(n => (
              <div key={n.id} className={`note-explorer-item ${n.id === activeId ? "is-active" : ""}`} onClick={() => onSelect(n)}>
                <FileText size={12} /> {n.title}
              </div>
            ))}
          </div>
        ))}
        {filtered.length === 0 && <div className="muted-sm" style={{ padding: 8, textAlign: "center" }}>No notes yet</div>}
      </div>
    </div>
  );
}