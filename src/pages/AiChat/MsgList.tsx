import React from "react";
import { Copy, RefreshCw, Pencil, Volume2, StopCircle, Check, X, Send } from "lucide-react";
import { Btn, EmptyHint } from "../../components/ui";
import { useContextMenu } from "../../components/ContextMenu";
import CodeBlock from "./CodeBlock";
import { renderInlineMd, parseSegments } from "./chatUtils";
import { sanitizeHtml } from "../../utils/sanitize";

export interface MsgStats { ms: number; tokens: number }

export default function MsgList(props: {
  messages: { id?: number; role: "user" | "assistant"; text: string }[];
  sending: boolean;
  streamingText: string;
  editing: { id: number; text: string } | null;
  setEditing: (v: { id: number; text: string } | null) => void;
  copiedIdx: number | null;
  onCopy: (text: string, idx: number) => void;
  onRegenerate: () => void;
  onSaveEdit: () => void;
  onSpeak: (text: string) => void;
  stopGeneration: () => void;
  lastStats: MsgStats | null;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const { messages, sending, streamingText, editing, setEditing, copiedIdx, onCopy, onRegenerate, onSaveEdit, onSpeak, stopGeneration, lastStats, t } = props;
  const menu = useContextMenu();
  return (
    <>
      {messages.map((m, i) => (
        <div key={m.id ?? `i${i}`}>
          <div className={`chat-bubble-row ${m.role === "user" ? "is-user" : ""}`}>
            {editing && editing.id === m.id ? (
              <div className="msg-edit">
                <textarea value={editing.text} autoFocus
                  onChange={(e) => setEditing({ id: m.id!, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSaveEdit(); }
                    if (e.key === "Escape") setEditing(null);
                  }} />
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn variant="primary" icon={Check} onClick={onSaveEdit}>{t("aichat.saveEdit")}</Btn>
                  <Btn icon={X} onClick={() => setEditing(null)}>{t("aichat.cancel")}</Btn>
                </div>
              </div>
            ) : (
              <div
                className={`chat-bubble ${m.role === "user" ? "is-user" : "is-assistant"}`}
                onContextMenu={(e) => menu.open(e, [
                  { label: t("aichat.copy"), icon: Copy, onClick: () => onCopy(m.text, i) },
                ])}
              >
                {m.role === "user"
                  ? m.text
                  : parseSegments(m.text).map((seg, k) =>
                      seg.type === "code"
                        ? <CodeBlock key={k} code={seg.text} lang={seg.lang || "text"} />
                        : <span key={k} dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderInlineMd(seg.text)) }} />)}
              </div>
            )}
          </div>
          <div className="msg-actions" style={{ justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            {m.role === "assistant" && (
              <button onClick={() => onCopy(m.text, i)} title="Copy">
                <Copy size={11} /> {copiedIdx === i ? t("aichat.copied") : t("aichat.copy")}
              </button>
            )}
            {m.role === "assistant" && i === messages.length - 1 && !sending && (
              <button onClick={onRegenerate} title={t("aichat.regenerate")}>
                <RefreshCw size={11} /> {t("aichat.regenerate")}
              </button>
            )}
            {m.role === "user" && m.id && !sending && (
              <button onClick={() => setEditing({ id: m.id!, text: m.text })} title={t("aichat.edit")}>
                <Pencil size={11} /> {t("aichat.edit")}
              </button>
            )}
            <button onClick={() => onSpeak(m.text)} title={t("aichat.listen")}>
              <Volume2 size={11} /> {t("aichat.listen")}
            </button>
          </div>
        </div>
      ))}
      {streamingText && (
        <div className="chat-bubble-row">
          <div className="chat-bubble is-assistant">
            {parseSegments(streamingText).map((seg, k) =>
              seg.type === "code"
                ? <CodeBlock key={k} code={seg.text} lang={seg.lang || "text"} />
                : <span key={k} dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderInlineMd(seg.text)) }} />)}
            <span className="streaming-cursor" />
          </div>
        </div>
      )}
      {sending && !streamingText && (
        <div className="chat-bubble-row">
          <div className="chat-bubble is-assistant"><div className="typing"><span /><span /><span /></div></div>
        </div>
      )}
      {sending && (
        <div className="chat-bubble-row" style={{ justifyContent: "center" }}>
          <button onClick={stopGeneration} className="stop-btn">
            <StopCircle size={14} /> {t("aichat.stop")}
          </button>
        </div>
      )}
      {lastStats && !sending && (
        <div className="gen-stats">⚡ {t("aichat.stats", { s: (lastStats.ms / 1000).toFixed(1), t: String(lastStats.tokens) })}</div>
      )}
      {!messages.length && !sending && <EmptyHint icon={Send} text={t("aichat.start")} />}
    </>
  );
}
