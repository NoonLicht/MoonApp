import React, { useState } from "react";
import { Edit3, Eye, Trash2, Plus, X } from "lucide-react";
import MarkdownRenderer from "./MarkdownRenderer";
import FormatToolbar from "./FormatToolbar";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { TextSelection } from "prosemirror-state";
import { marked } from "marked";
import Turndown from "turndown";

const turndown = new Turndown({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

interface Props {
  content: string;
  onChange: (content: string) => void;
  onWikiLink?: (title: string) => void;
  onTagClick?: (tag: string) => void;
  placeholder?: string;
}

function mdToHtml(md: string): string {
  if (!md) return "<p></p>";
  try { return marked.parse(md, { async: false }) as string; } catch { return md; }
}

function htmlToMd(html: string): string {
  if (!html) return "";
  return turndown.turndown(html);
}

function handleObsidianEnter(view: any, event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey) return false;
  const { state, dispatch } = view;
  const { $from } = state.selection;
  const node = $from.parent;
  if (node.type.name !== "paragraph") return false;
  const text = node.textContent;
  if (!text) return false;
  const patterns: [RegExp, (m: RegExpMatchArray) => any[]][] = [
    [/^(#{1,6})\s*(.*)$/, (m) => {
      const level = m[1].length;
      const c = m[2].trim();
      const h = state.schema.nodes.heading.create({ level }, c ? state.schema.text(c) : []);
      return [h, state.schema.nodes.paragraph.create()];
    }],
    [/^[-*]\s+(.+)$/, (m) => {
      const li = state.schema.nodes.listItem.create(null, state.schema.nodes.paragraph.create(null, state.schema.text(m[1])));
      return [state.schema.nodes.bulletList.create(null, li), state.schema.nodes.paragraph.create()];
    }],
    [/^(\d+)\.\s+(.+)$/, (m) => {
      const li = state.schema.nodes.listItem.create(null, state.schema.nodes.paragraph.create(null, state.schema.text(m[2])));
      return [state.schema.nodes.orderedList.create(null, li), state.schema.nodes.paragraph.create()];
    }],
    [/^>\s+(.+)$/, (m) => {
      const p = state.schema.nodes.paragraph.create(null, state.schema.text(m[1]));
      return [state.schema.nodes.blockquote.create(null, p), state.schema.nodes.paragraph.create()];
    }],
    [/^\[( |x|X)\]\s+(.+)$/, (m) => {
      const ti = state.schema.nodes.taskItem.create({ checked: m[1] !== " " },
        state.schema.nodes.paragraph.create(null, state.schema.text(m[2])));
      return [state.schema.nodes.taskList.create(null, ti), state.schema.nodes.paragraph.create()];
    }],
  ];
  for (const [re, factory] of patterns) {
    const m = text.match(re);
    if (!m) continue;
    event.preventDefault();
    const from = $from.before();
    const to = $from.after();
    const nodes = factory(m);
    const totalSize = nodes.reduce((a: number, n: any) => a + n.nodeSize, 0);
    const tr = state.tr
      .replaceWith(from, to, nodes)
      .setSelection(TextSelection.near(state.doc.resolve(from + totalSize - 1)));
    dispatch(tr.scrollIntoView());
    return true;
  }
  return false;
}
export default function NoteEditor({ content, onChange, onWikiLink, onTagClick, placeholder = "Start writing..." }: Props) {
  const [preview, setPreview] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const prevContentRef = React.useRef(content);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: false }),
      Underline,
      Link.configure({ openOnClick: false }),
      Image,
      Table.configure({ resizable: true }),
      TableRow, TableCell, TableHeader,
      TaskList, TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
    ],
    onUpdate: ({ editor }) => {
      if (isUpdating) return;
      const md = htmlToMd(editor.getHTML());
      prevContentRef.current = md;
      onChange(md);
    },
    editorProps: {
      attributes: { class: "note-tiptap" },
      handleKeyDown: handleObsidianEnter,
    },
    content: mdToHtml(content),
  });

  React.useEffect(() => {
    if (!editor || isUpdating) return;
    if (content !== prevContentRef.current) {
      prevContentRef.current = content;
      setIsUpdating(true);
      editor.commands.setContent(mdToHtml(content));
      setIsUpdating(false);
    }
  }, [content, editor, isUpdating]);

  return (
    <div className="note-editor">
      <FormatToolbar editor={editor} />
      <div className="note-editor-tabs">
        <button className={`note-editor-tab ${!preview ? "is-active" : ""}`} onClick={() => setPreview(false)}>
          <Edit3 size={13} /> Edit
        </button>
        <button className={`note-editor-tab ${preview ? "is-active" : ""}`} onClick={() => setPreview(true)}>
          <Eye size={13} /> Preview
        </button>
      </div>
      {preview ? (
        <div className="note-preview">
          <MarkdownRenderer content={content} onWikiLink={onWikiLink} onTagClick={onTagClick} />
        </div>
      ) : (
        <div className="note-tiptap-wrapper">
          {editor && editor.isActive("table") && <TableMenu editor={editor} />}
          <EditorContent editor={editor} className="note-editor-content" />
        </div>
      )}
    </div>
  );
}

function TableMenu({ editor }: { editor: any }) {
  return (
    <div className="note-table-menu">
      <span className="note-table-menu-label">Table</span>
      <button type="button" title="Add column before" onClick={() => editor.chain().focus().addColumnBefore().run()}>
        <Plus size={12} /> Col ↤
      </button>
      <button type="button" title="Add column after" onClick={() => editor.chain().focus().addColumnAfter().run()}>
        <Plus size={12} /> Col ↦
      </button>
      <button type="button" title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>
        <X size={12} /> Col
      </button>
      <button type="button" title="Add row before" onClick={() => editor.chain().focus().addRowBefore().run()}>
        <Plus size={12} /> Row ↥
      </button>
      <button type="button" title="Add row after" onClick={() => editor.chain().focus().addRowAfter().run()}>
        <Plus size={12} /> Row ↧
      </button>
      <button type="button" title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>
        <X size={12} /> Row
      </button>
      <button type="button" title="Merge cells" onClick={() => editor.chain().focus().mergeCells().run()}>
        Merge
      </button>
      <button type="button" title="Split cell" onClick={() => editor.chain().focus().splitCell().run()}>
        Split
      </button>
      <button type="button" title="Toggle header" onClick={() => editor.chain().focus().toggleHeaderCell().run()}>
        Header
      </button>
      <button type="button" title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
        <Trash2 size={12} /> Delete
      </button>
    </div>
  );
}