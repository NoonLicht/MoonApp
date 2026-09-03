import React, { useState } from "react";
import {
  Undo2, Redo2, Bold, Italic, Strikethrough, Underline,
  ArrowUpDown, Link as LinkIcon, Table, CheckSquare, Quote,
  Type, List, ListOrdered, Highlighter, Maximize2, Minimize2,
  Heading2, Heading3, Pilcrow, Code, Image, Eraser, Paintbrush,
} from "lucide-react";
import type { Editor } from "@tiptap/core";

interface Props { editor: Editor | null; }

export default function FormatToolbar({ editor }: Props) {
  const [showHeading, setShowHeading] = useState(false);

  if (!editor) return null;

  const btn = (icon: React.ReactNode, title: string, onClick: () => void, active?: boolean) => (
    <button type="button" className={`fmt-btn ${active ? "is-active" : ""}`} title={title}
      onClick={onClick} onMouseDown={(e) => e.preventDefault()}>{icon}</button>
  );

  return (
    <div className="fmt-toolbar">
      {btn(<Undo2 size={14} />, "Undo (Ctrl+Z)", () => editor.chain().focus().undo().run())}
      {btn(<Redo2 size={14} />, "Redo (Ctrl+Shift+Z)", () => editor.chain().focus().redo().run())}
      <div className="fmt-sep" />
      {btn(<Paintbrush size={14} />, "Copy formatting", () => {})}
      {btn(<Eraser size={14} />, "Clear formatting", () => editor.chain().focus().clearNodes().unsetAllMarks().run())}
      <div className="fmt-sep" />
      {btn(<Heading2 size={14} />, "Heading 2", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
      {btn(<Heading3 size={14} />, "Heading 3", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
      <div className="fmt-btn-group">
        {btn(<Pilcrow size={13} />, "Heading level", () => setShowHeading(!showHeading))}
        <button type="button" className="fmt-drop-arrow" onClick={() => setShowHeading(!showHeading)} onMouseDown={e => e.preventDefault()}>
          <ArrowUpDown size={10} />
        </button>
        {showHeading && <div className="fmt-dropdown">{[1,2,3,4,5,6].map(l => (
          <button key={l} type="button" className="fmt-drop-item" onClick={() => { editor.chain().focus().toggleHeading({ level: l as any }).run(); setShowHeading(false); }}>H{l}</button>
        ))}</div>}
      </div>
      <div className="fmt-sep" />
      {btn(<Bold size={14} />, "Bold (Ctrl+B)", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"))}
      {btn(<Italic size={14} />, "Italic (Ctrl+I)", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"))}
      {btn(<Strikethrough size={14} />, "Strikethrough", () => editor.chain().focus().toggleStrike().run(), editor.isActive("strike"))}
      {btn(<Underline size={14} />, "Underline (Ctrl+U)", () => editor.chain().focus().toggleUnderline().run(), editor.isActive("underline"))}
      <div className="fmt-sep" />
      {btn(<Code size={14} />, "Inline code", () => editor.chain().focus().toggleCode().run(), editor.isActive("code"))}
      {btn(<Image size={14} />, "Image", () => { const url = prompt("Image URL:"); if (url) editor.chain().focus().setImage({ src: url }).run(); })}
      {btn(<LinkIcon size={14} />, "Link", () => { const url = prompt("URL:", editor.getAttributes("link").href || "https://"); if (url === null) return; if (!url) editor.chain().focus().unsetLink().run(); else editor.chain().focus().setLink({ href: url }).run(); }, editor.isActive("link"))}
      {btn(<Table size={14} />, "Table 2×2", () => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run())}
      <div className="fmt-sep" />
      {btn(<CheckSquare size={14} />, "Task list", () => { const active = editor.isActive("taskList"); if (active) editor.chain().focus().toggleTaskList().run(); else editor.chain().focus().toggleTaskList().run(); }, editor.isActive("taskList"))}
      {btn(<Quote size={14} />, "Quote", () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"))}
      {btn(<List size={14} />, "Bullet list", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"))}
      {btn(<ListOrdered size={14} />, "Numbered list", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"))}
      <div className="fmt-sep" />
      {btn(<Maximize2 size={14} />, "Fullscreen", () => { (document.querySelector(".note-main") as HTMLElement)?.classList.toggle("note-fullscreen"); })}
      {btn(<Minimize2 size={14} />, "Minimize", () => { (document.querySelector(".note-main") as HTMLElement)?.classList.remove("note-fullscreen"); })}
    </div>
  );
}