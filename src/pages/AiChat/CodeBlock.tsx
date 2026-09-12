import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlightCode } from "./chatUtils";
import { sanitizeHtml } from "../../utils/sanitize";

/** Код-блок с копированием на React (без onclick-инъекций в HTML). */
export default function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <pre>
      <div className="code-header">
        <span>{lang}</span>
        <button onClick={copy}>
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "✓" : "Copy"}
        </button>
      </div>
      <code className={`language-${lang}`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(highlightCode(code, lang)) }} />
    </pre>
  );
}
