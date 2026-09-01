import React, { useState } from "react";
import { Edit3, Eye } from "lucide-react";
import MarkdownRenderer from "./MarkdownRenderer";

interface Props {
  content: string; onChange: (content: string) => void;
  onWikiLink?: (title: string) => void; onTagClick?: (tag: string) => void;
  placeholder?: string;
}

export default function NoteEditor({ content, onChange, onWikiLink, onTagClick, placeholder = "Start writing in Markdown..." }: Props) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="note-editor">
      <div className="note-editor-tabs">
        <button className={`note-editor-tab ${!preview ? "is-active" : ""}`} onClick={() => setPreview(false)}><Edit3 size={13} /> Edit</button>
        <button className={`note-editor-tab ${preview ? "is-active" : ""}`} onClick={() => setPreview(true)}><Eye size={13} /> Preview</button>
      </div>
      {preview ? (
        <div className="note-preview">
          <MarkdownRenderer content={content} onWikiLink={onWikiLink} onTagClick={onTagClick} />
        </div>
      ) : (
        <textarea className="note-textarea" value={content} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
      )}
    </div>
  );
}