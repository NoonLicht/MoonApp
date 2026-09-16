import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlightCode } from "@/pages/ai-chat/lib/chatUtils";
import { sanitizeHtml } from "@/lib/sanitize";

/**
 * Код-блок с копированием на React (без onclick-инъекций в HTML).
 * Мемоизирован: во время стриминга история перерисовывается на каждый токен,
 * а подсветка кода — одна из самых дорогих операций (аудит B16).
 */
const CodeBlock = React.memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const html = useMemo(() => sanitizeHtml(highlightCode(code, lang)), [code, lang]);

  // Чистим таймер, чтобы не дёргать setState после размонтирования.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <pre>
      <div className="code-header">
        <span>{lang}</span>
        <button onClick={copy}>
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "✓" : "Copy"}
        </button>
      </div>
      <code className={`language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
});

export default CodeBlock;
