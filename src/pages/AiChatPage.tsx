import React, { useState, useEffect, useRef, useMemo } from "react";
import { Settings2, Send, Plus, Trash2, KeyRound } from "lucide-react";
import { Glass, Btn, IconBtn, Field, Select, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api, streamChatSend } from "../api/client";
import type { ProviderInfo, Conversation, ChatMessage } from "../api/types";

export default function AiChatPage() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [chatCfg, setChatCfg] = useState({ temperature: 0.7, maxTokens: 1024, model: "", provider: "openai" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState<ProviderInfo | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.getProviders().then(setProviders).catch(() => {});
    api.getConversations().then((c) => { setConvs(c); if (c.length) setActiveId(c[0].id); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeId) return;
    api.getMessages(activeId).then(setMessages).catch(() => setMessages([]));
  }, [activeId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const provider = useMemo(() => providers.find((p) => p.id === chatCfg.provider), [providers, chatCfg.provider]);
  const activeConv = convs.find((c) => c.id === activeId);

  usePageToolbar(
    <>
      <Field label={t("aichat.provider")} w={150}>
        <Select value={chatCfg.provider} onChange={(e) => setChatCfg((s) => ({ ...s, provider: e.target.value }))} options={providers.map((p) => p.id)} />
      </Field>
      <Field label={t("aichat.model")} w={170}>
        <Select value={chatCfg.model || provider?.models?.[0] || ""} onChange={(e) => setChatCfg((s) => ({ ...s, model: e.target.value }))} options={provider?.models || []} />
      </Field>
      <IconBtn icon={Settings2} active={settingsOpen} onClick={() => setSettingsOpen((v) => !v)} title={t("aichat.modelSettings")} />
    </>,
    [providers, chatCfg.provider, chatCfg.model, settingsOpen, t]
  );

  const newChat = async () => {
    const conv = await api.createConversation(chatCfg.provider, t("aichat.newChat"));
    setConvs((c) => [conv, ...c]);
    setActiveId(conv.id);
    setMessages([]);
  };

  const saveKey = async () => {
    if (!keyPrompt) return;
    try {
      await api.saveKey(keyPrompt.id, input);
      setKeyPrompt(null);
      setInput("");
      api.getProviders().then(setProviders).catch(() => {});
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠ ${(e as Error).message}` }]);
    }
  };

  const send = async () => {
    if (!input.trim() || sending) return;
    if (!activeId) return;
    if (!provider?.configured) { setKeyPrompt(provider ?? null); return; }
    const roleMsg: ChatMessage = { role: "user", text: input };
    setMessages((m) => [...m, roleMsg]);
    setInput("");
    setSending(true);
    try {
      await streamChatSend(activeId, {
        text: roleMsg.text,
        model: chatCfg.model || provider.models[0],
        temperature: chatCfg.temperature,
        maxTokens: chatCfg.maxTokens,
        stream: true,
      }, (ev) => {
        if (ev.type === "token") {
          setMessages((m) => [...m, { role: "assistant", text: ev.text || "" }]);
        } else if (ev.type === "error") {
          setMessages((m) => [...m, { role: "assistant", text: `⚠ ${ev.message || "error"}` }]);
        }
      });
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠ ${(e as Error).message}` }]);
    } finally {
      setSending(false);
    }
  };

  const delConv = async (id: number) => {
    await api.deleteConversation(id);
    const rest = convs.filter((c) => c.id !== id);
    setConvs(rest);
    if (activeId === id) { setActiveId(rest[0]?.id || null); setMessages([]); }
  };

  return (
    <div className="page page-flush">
      {settingsOpen && (
        <Glass className="settings-drawer">
          <Field label={t("aichat.temperature", { v: chatCfg.temperature.toFixed(1) })} w={180}>
            <input type="range" min="0" max="1.5" step="0.1" value={chatCfg.temperature} onChange={(e) => setChatCfg((s) => ({ ...s, temperature: parseFloat(e.target.value) }))} />
          </Field>
          <Field label={t("aichat.maxTokens")} w={130}>
            <input type="number" className="num-input" value={chatCfg.maxTokens} onChange={(e) => setChatCfg((s) => ({ ...s, maxTokens: parseInt(e.target.value, 10) || 0 }))} />
          </Field>
          <Btn icon={Plus} onClick={newChat}>{t("aichat.newChat")}</Btn>
        </Glass>
      )}

      {keyPrompt && (
        <Glass className="settings-drawer" style={{ borderColor: "var(--coral)" }}>
          <KeyRound size={16} style={{ marginTop: 8 }} />
          <Field label={t("aichat.apiKey", { label: keyPrompt.label })} w={380}>
            <input type="password" className="text-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="sk-..." onKeyDown={(e) => e.key === "Enter" && saveKey()} />
          </Field>
          <Btn variant="primary" icon={KeyRound} onClick={saveKey} style={{ marginTop: 22 }}>{t("aichat.saveKey")}</Btn>
          <Btn onClick={() => setKeyPrompt(null)} style={{ marginTop: 22 }}>{t("aichat.cancel")}</Btn>
        </Glass>
      )}

      <div className="chat-side">
        <Glass className="chat-conv-list" style={{ padding: 8 }}>
          <Btn icon={Plus} onClick={newChat} style={{ marginBottom: 6 }}>{t("aichat.newChat")}</Btn>
          {convs.map((c) => (
            <div key={c.id} className={`chat-conv ${c.id === activeId ? "is-active" : ""}`} onClick={() => setActiveId(c.id)}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
              <span className="x"><IconBtn icon={Trash2} size={13} onClick={(e) => { e.stopPropagation(); delConv(c.id); }} /></span>
            </div>
          ))}
          {convs.length === 0 && <div className="muted-sm" style={{ padding: 8 }}>{t("aichat.noChats")}</div>}
        </Glass>

        <div className="glass chat-scroll" ref={scrollRef} style={{ flex: 1, padding: 14, minHeight: 0 }}>
          {messages.map((m, i) => (
            <div key={i} className={`chat-bubble-row ${m.role === "user" ? "is-user" : ""}`}>
              <div className={`chat-bubble ${m.role === "user" ? "is-user" : "is-assistant"}`}>{m.text}</div>
            </div>
          ))}
          {sending && (
            <div className="chat-bubble-row">
              <div className="chat-bubble is-assistant typing"><span /><span /><span /></div>
            </div>
          )}
          {!messages.length && !sending && <EmptyHint icon={Send} text={t("aichat.start")} />}
        </div>
      </div>

      <Glass className="chat-input-bar">
        <textarea
          rows={1}
          placeholder={activeConv ? t("aichat.placeholder", { provider: activeConv.provider }) : t("aichat.createFirst")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <IconBtn icon={Send} onClick={send} title={t("aichat.send")} />
      </Glass>
    </div>
  );
}