import React from "react";

interface Props {
  content: string;
  onWikiLink?: (title: string) => void;
  onTagClick?: (tag: string) => void;
  onToggleCheckbox?: (lineIndex: number) => void;
}

export default function MarkdownRenderer({ content, onWikiLink, onTagClick, onToggleCheckbox }: Props) {
  const lines = content.split("\n");
  const els: React.ReactNode[] = [];
  let inCode = false, buf: string[] = [], lang = "";

  const flush = (k: number | string) => {
    if (!buf.length) return;
    els.push(<pre key={`cb${k}`} className="md-code-block">{lang ? <div className="md-code-lang">{lang}</div> : null}<code>{buf.join("\n")}</code></pre>);
    buf = []; lang = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trimStart().startsWith("```")) {
      if (inCode) { flush(i); inCode = false; continue; }
      else { inCode = true; lang = l.trim().slice(3).trim(); continue; }
    }
    if (inCode) { buf.push(l); continue; }

    const t = l.trim();
    if (!t) { els.push(<div key={i} className="md-empty" />); continue; }

    const cb = l.match(/^(?:[-*+]\s+)?\[([ xX])\]\s*(.*)/);
    if (cb) {
      const c = cb[1].toLowerCase() === "x";
      els.push(<div key={i} className="md-checkbox-row" onClick={() => onToggleCheckbox?.(i)}>
        <span className={`md-checkbox ${c ? "is-checked" : ""}`}>{c ? "✓" : ""}</span>
        <span style={{ textDecoration: c ? "line-through" : "none", opacity: c ? 0.6 : 1 }}>{renderInline(cb[2], onWikiLink, onTagClick, i)}</span>
      </div>);
      continue;
    }

    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const Tag = `h${h[1].length}` as keyof JSX.IntrinsicElements;
      els.push(<Tag key={i} className={`md-h md-h${h[1].length}`}>{renderInline(h[2], onWikiLink, onTagClick, i)}</Tag>);
      continue;
    }

    if (l.trimStart().startsWith("> ")) {
      els.push(<blockquote key={i} className="md-blockquote">{renderInline(l.replace(/^>\s*/, ""), onWikiLink, onTagClick, i)}</blockquote>);
      continue;
    }

    if (/^[-*_]{3,}$/.test(t)) { els.push(<hr key={i} className="md-hr" />); continue; }

    els.push(<p key={i} className="md-p">{renderInline(l, onWikiLink, onTagClick, i)}</p>);
  }
  if (inCode) flush("end");
  return <div className="md-renderer">{els}</div>;
}

function renderInline(text: string, onWikiLink?: (t: string) => void, onTagClick?: (t: string) => void, kp?: number | string): React.ReactNode[] {
  const re = /(\[\[([^\]]+)\]\]|`[^`]+`|#[a-zA-Zа-яА-Я0-9_\/-]+|\[([^\]]+)\]\(([^)]+)\)|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  const out: React.ReactNode[] = [];
  let last = 0, idx = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={`t${kp}-${idx++}`}>{text.slice(last, m.index)}</span>);
    const f = m[0];
    if (f.startsWith("[[")) out.push(<span key={`w${kp}-${idx++}`} className="md-wiki-link" onClick={() => onWikiLink?.(m![2])}>{m![2]}</span>);
    else if (f.startsWith("`") && f.endsWith("`")) out.push(<code key={`c${kp}-${idx++}`} className="md-inline-code">{f.slice(1, -1)}</code>);
    else if (f.startsWith("#")) out.push(<span key={`tag${kp}-${idx++}`} className="md-tag" onClick={() => onTagClick?.(f)}>{f}</span>);
    else if (f.startsWith("[")) out.push(<a key={`a${kp}-${idx++}`} className="md-link" href={m[4]!} target="_blank" rel="noreferrer">{m[3]}</a>);
    else if (f.startsWith("***")) out.push(<strong key={`bi${kp}-${idx++}`}><em>{m[5]}</em></strong>);
    else if (f.startsWith("**")) out.push(<strong key={`b${kp}-${idx++}`}>{m[6]}</strong>);
    else if (f.startsWith("*")) out.push(<em key={`i${kp}-${idx++}`}>{m[7]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<span key={`t${kp}-${idx++}`}>{text.slice(last)}</span>);
  return out.length ? out : [text];
}
