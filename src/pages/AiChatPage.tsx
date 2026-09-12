import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Settings2, Send, Plus, Trash2, KeyRound, StopCircle,
  Copy, Volume2, Paperclip, Mic, FileText, Square, Pencil, Pin, PinOff,
  Download, Swords, Search, Code2, ChevronDown, Check, X, Sparkles,
} from "lucide-react";
import { Glass, Btn, IconBtn, Field, Select, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api, streamChatSend, streamArena } from "../api/client";
import type { ProviderInfo, Conversation, ChatMessage } from "../api/types";
import CodeBlock from "./AiChat/CodeBlock";
import MsgList, { type MsgStats } from "./AiChat/MsgList";
import { sanitizeHtml } from "../utils/sanitize";
import { useContextMenu } from "../components/ContextMenu";
import {
  renderInlineMd, parseSegments, approxTokens,
  SYSTEM_PROMPT_PRESETS, type SysPreset,
  loadCfg, saveCfg, type ChatCfg,
  loadCustomPresets, saveCustomPresets,
  loadLast, saveLast,
  createRecognition, exportChatMd, exportChatJson,
} from "./AiChat/chatUtils";

interface Attachment { name: string; type: "image" | "text"; data: string }
interface SideState { text: string; done: boolean; error?: string }

const HYPER_PRESETS: { id: string; label: string; cfg: Partial<ChatCfg> }[] = [
  { id: "precise", label: "🎯", cfg: { temperature: 0.2, topP: 0.9, frequencyPenalty: 0, presencePenalty: 0 } },
  { id: "balance", label: "⚖️", cfg: { temperature: 0.7, topP: 1, frequencyPenalty: 0, presencePenalty: 0 } },
  { id: "creative", label: "🎨", cfg: { temperature: 1.2, topP: 1, frequencyPenalty: 0.4, presencePenalty: 0.4 } },
];

export default function AiChatPage() {
  const menu = useContextMenu();
  const { t, lang } = useI18n();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [chatCfg, setChatCfgState] = useState<ChatCfg>(() => loadCfg());
  const setChatCfg = useCallback((patch: Partial<ChatCfg>) => {
    // М7: вручную изменённые поля запоминаются — настройки приложения их
    // больше не перезаписывают при следующем заходе.
    try {
      const touched = new Set<string>(JSON.parse(localStorage.getItem("aichat.cfg.touched") || "[]"));
      for (const k of Object.keys(patch)) touched.add(k);
      localStorage.setItem("aichat.cfg.touched", JSON.stringify([...touched]));
    } catch { /* noop */ }
    setChatCfgState((s) => { const n = { ...s, ...patch }; saveCfg(n); return n; });
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState<ProviderInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState(SYSTEM_PROMPT_PRESETS[0].prompt);
  const [sysPreset, setSysPreset] = useState(SYSTEM_PROMPT_PRESETS[0].name);
  const [customPresets, setCustomPresets] = useState<SysPreset[]>(() => loadCustomPresets());
  const [presetDraft, setPresetDraft] = useState<{ open: boolean; name: string }>({ open: false, name: "" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [arena, setArena] = useState<{ on: boolean; a: string; b: string; aText: SideState; bText: SideState }>(
    { on: false, a: "", b: "", aText: { text: "", done: false }, bText: { text: "", done: false } }
  );
  const [lastStats, setLastStats] = useState<MsgStats | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null);
  const [palette, setPalette] = useState<null | { query: string }>(null);
  const [listening, setListening] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showDown, setShowDown] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recogRef = useRef<any>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /* ── первичная загрузка ── */
  useEffect(() => {
    api.getProviders().then(setProviders).catch(() => {});
    api.getConversations().then((c) => {
      setConvs(c);
      if (c.length) setActiveId(c[0].id);
    }).catch(() => {});
    const last = loadLast();
    if (last.provider || last.model) {
      setChatCfgState((s) => ({ ...s, provider: last.provider || s.provider, model: last.model || s.model }));
    }
    // Дефолты из настроек (chat.*) применяются один раз — если юзер ещё ни разу
    // М7: настройки chat.* синхронизируются при КАЖДОМ заходе на страницу,
    // но перезаписывают только те поля, которые пользователь не менял вручную
    // (ручные изменения пишутся в localStorage с флагом "cfg.touched").
    try {
      api.getSettings().then((s: any) => {
        const c = s?.chat;
        if (!c) return;
        const touched = new Set(JSON.parse(localStorage.getItem("aichat.cfg.touched") || "[]"));
        setChatCfgState((p: ChatCfg) => ({
          ...p,
          provider: touched.has("provider") ? p.provider : (c.provider || p.provider),
          model: touched.has("model") ? p.model : (c.model || p.model),
          temperature: touched.has("temperature") || typeof c.temperature !== "number" ? p.temperature : c.temperature,
          maxTokens: touched.has("maxTokens") || typeof c.maxTokens !== "number" ? p.maxTokens : c.maxTokens,
          streaming: touched.has("streaming") || typeof c.stream !== "boolean" ? p.streaming : c.stream,
        }));
      }).catch(() => { /* настройки недоступны — остаётся localStorage */ });
    } catch { /* localStorage недоступен */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── модели провайдера (сервер тянет живой список + кэш 10 мин) ── */
  useEffect(() => {
    if (!chatCfg.provider) return;
    const prov = providers.find((p) => p.id === chatCfg.provider);
    if (prov?.models && prov.models.length > 0) {
      setModels(prov.models);
      if (!chatCfg.model || !prov.models.includes(chatCfg.model)) {
        setChatCfgState((s) => ({ ...s, model: prov.models[0] }));
      }
    } else {
      api.chatModels(chatCfg.provider).then((m) => {
        setModels(m);
        if (m.length > 0 && (!chatCfg.model || !m.includes(chatCfg.model))) {
          setChatCfgState((s) => ({ ...s, model: m[0] }));
        }
      }).catch(() => setModels(prov?.models || []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatCfg.provider, providers]);

  useEffect(() => { saveLast(chatCfg.provider, chatCfg.model); }, [chatCfg.provider, chatCfg.model]);

  /* ── сообщения активного чата ── */
  const refreshMessages = useCallback(async (id: number) => {
    try { setMessages(await api.getMessages(id)); } catch { setMessages([]); }
  }, []);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    refreshMessages(activeId);
  }, [activeId, refreshMessages]);

  /* ── автоскролл ── */
  useEffect(() => {
    if (autoScroll) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamingText, arena.aText.text, arena.bText.text, sending, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(nearBottom);
    setShowDown(!nearBottom && el.scrollHeight > el.clientHeight + 200);
  };

  const provider = useMemo(() => providers.find((p) => p.id === chatCfg.provider), [providers, chatCfg.provider]);
  const activeConv = convs.find((c) => c.id === activeId);
  const allPresets = useMemo(() => [...customPresets, ...SYSTEM_PROMPT_PRESETS], [customPresets]);

  /* ── чаты ── */
  const newChat = async () => {
    try {
      const conv = await api.createConversation(chatCfg.provider, "New chat");
      setConvs((c) => [conv, ...c]);
      setActiveId(conv.id);
      setMessages([]);
      setLastStats(null);
      inputRef.current?.focus();
    } catch { /* noop */ }
  };

  const delConv = async (id: number) => {
    await api.deleteConversation(id);
    setConvs((c) => c.filter((x) => x.id !== id));
    if (activeId === id) { setActiveId(null); setMessages([]); }
  };

  const renameConv = async (id: number, title: string) => {
    setRenaming(null);
    if (!title.trim()) return;
    try {
      const upd = await api.chatUpdateConv(id, { title });
      setConvs((c) => c.map((x) => (x.id === id ? upd : x)));
    } catch { /* noop */ }
  };

  const togglePin = async (conv: Conversation) => {
    try {
      const upd = await api.chatUpdateConv(conv.id, { pinned: !conv.pinned });
      setConvs((c) => c.map((x) => (x.id === conv.id ? upd : x)));
    } catch { /* noop */ }
  };

  /* ── группировка чатов: закреплённые сверху, затем по датам ── */
  const groupedConvs = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? convs.filter((c) => c.title.toLowerCase().includes(q)) : convs;
    const pinned = filtered.filter((c) => c.pinned);
    const rest = filtered.filter((c) => !c.pinned);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const yesterday = new Date(dayStart); yesterday.setDate(yesterday.getDate() - 1);
    const groups: { label: string; items: Conversation[] }[] = [];
    if (pinned.length) groups.push({ label: `📌 ${t("aichat.pinned")}`, items: pinned });
    const g1 = rest.filter((c) => new Date(c.updated_at.replace(" ", "T")) >= dayStart);
    const g2 = rest.filter((c) => new Date(c.updated_at.replace(" ", "T")) >= yesterday && new Date(c.updated_at.replace(" ", "T")) < dayStart);
    const g3 = rest.filter((c) => new Date(c.updated_at.replace(" ", "T")) < yesterday);
    if (g1.length) groups.push({ label: t("aichat.today"), items: g1 });
    if (g2.length) groups.push({ label: t("aichat.yesterday"), items: g2 });
    if (g3.length) groups.push({ label: t("aichat.earlier"), items: g3 });
    return groups;
  }, [convs, search, t]);

  /* ── экспорт ── */
  const doExport = (fmt: "md" | "json") => {
    if (!activeConv) return;
    if (fmt === "md") exportChatMd(activeConv.title, messages);
    else exportChatJson(activeConv, messages);
  };

  /* ── ключи API ── */
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

  /* ── отправка ── */
  const send = async (overrideText?: string) => {
    const txt = (overrideText ?? input).trim();
    if (!txt || sending || !activeId) return;
    if (!provider?.configured) { setKeyPrompt(provider ?? null); return; }
    const imgUrls = attachments.filter((a) => a.type === "image").map((a) => a.data);
    const textFiles = attachments.filter((a) => a.type === "text");
    const attachmentText = textFiles.length
      ? "\n\n[Attachments]:\n" + textFiles.map((a) => `--- ${a.name} ---\n${a.data.slice(0, 3000)}`).join("\n\n")
      : "";

    const userMsg: ChatMessage = { role: "user", text: txt };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setAttachments([]);
    setSending(true);
    setStreamingText("");
    setLastStats(null);

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    try {
      await streamChatSend(activeId, {
        text: txt + attachmentText,
        images: imgUrls.length ? imgUrls : undefined,
        model: chatCfg.model || models[0] || "",
        temperature: chatCfg.temperature, maxTokens: chatCfg.maxTokens,
        stream: chatCfg.streaming, topP: chatCfg.topP,
        frequencyPenalty: chatCfg.frequencyPenalty,
        presencePenalty: chatCfg.presencePenalty,
        systemPrompt: systemPrompt || undefined,
      }, (ev) => {
        if (ev.type === "token" && chatCfg.streaming) {
          setStreamingText((prev) => prev + (ev.text || ""));
        } else if (ev.type === "meta" && ev.title) {
          setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, title: ev.title! } : c)));
        } else if (ev.type === "done") {
          setMessages((m) => [...m, { role: "assistant", text: ev.text || "" }]);
          if (ev.stats) {
            setLastStats({ ms: ev.stats.ms, tokens: Math.round(ev.stats.tokensApprox / (ev.stats.ms / 1000)) });
          }
          setStreamingText(""); setSending(false);
        } else if (ev.type === "error") {
          setMessages((m) => [...m, { role: "assistant", text: `⚠ ${ev.message || "Error"}` }]);
          setStreamingText(""); setSending(false);
        }
      }, signal);
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setMessages((m) => [...m, { role: "assistant", text: `⚠ ${e.message}` }]);
      }
      setStreamingText(""); setSending(false);
    }
  };

  const stopGeneration = () => {
    abortRef.current?.abort();
    setSending(false);
    setStreamingText("");
  };

  /* ── Arena: прогон вопроса через две модели (persist=false — ответы в базу не пишутся) ── */
  const runArena = async (questionText: string) => {
    if (!activeId || sending || !arena.a || !arena.b) return;
    if (!provider?.configured) { setKeyPrompt(provider ?? null); return; }
    setSending(true);
    setArena((a) => ({ ...a, aText: { text: "", done: false }, bText: { text: "", done: false } }));
    try {
      await streamArena(activeId, {
        text: questionText, models: [arena.a, arena.b], persist: false,
        temperature: chatCfg.temperature, maxTokens: chatCfg.maxTokens,
        topP: chatCfg.topP, frequencyPenalty: chatCfg.frequencyPenalty,
        presencePenalty: chatCfg.presencePenalty,
        systemPrompt: systemPrompt || undefined,
      }, (ev) => {
        const key = ev.side === "a" ? "aText" : "bText";
        if (ev.type === "token" && ev.side) {
          setArena((a) => ({ ...a, [key]: { ...a[key], text: a[key].text + (ev.text || "") } }));
        } else if (ev.type === "done" && ev.side) {
          setArena((a) => ({ ...a, [key]: { text: ev.text || "", done: true } }));
        } else if (ev.type === "error" && ev.side) {
          setArena((a) => ({ ...a, [key]: { text: `⚠ ${ev.message}`, done: true } }));
        }
      });
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠ ${e.message}` }]);
    } finally {
      setSending(false);
    }
  };

  /* Включение Arena: если в чате уже есть последний вопрос — сразу прогоняем его (авто-регенерация) */
  const toggleArena = () => {
    if (arena.on) { setArena((a) => ({ ...a, on: false })); return; }
    const a = models.includes(chatCfg.model) ? chatCfg.model : (models[0] || "");
    const b = models[1] || models[0] || "";
    if (!activeId) { setArena({ on: true, a, b, aText: { text: "", done: false }, bText: { text: "", done: false } }); return; }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser?.id) {
      // авто-регенерация: убираем вопрос и всё после него из истории, прогоняем через обе модели
      const q = lastUser.text;
      api.chatTruncateFrom(activeId, lastUser.id).catch(() => {});
      setMessages((m) => m.filter((x) => (x.id || 0) < lastUser.id!));
      setArena({ on: true, a, b, aText: { text: "", done: false }, bText: { text: "", done: false } });
      setTimeout(() => runArenaWith(a, b, q), 0);
    } else {
      setArena({ on: true, a, b, aText: { text: "", done: false }, bText: { text: "", done: false } });
    }
  };

  /* Прогон с явно заданными моделями (используется при авто-регенерации до установки стейта) */
  const runArenaWith = async (ma: string, mb: string, questionText: string) => {
    if (!activeId || sending || !ma || !mb) return;
    if (!provider?.configured) { setKeyPrompt(provider ?? null); return; }
    setSending(true);
    setArena((a) => ({ ...a, aText: { text: "", done: false }, bText: { text: "", done: false } }));
    try {
      await streamArena(activeId, {
        text: questionText, models: [ma, mb], persist: false,
        temperature: chatCfg.temperature, maxTokens: chatCfg.maxTokens,
        topP: chatCfg.topP, frequencyPenalty: chatCfg.frequencyPenalty,
        presencePenalty: chatCfg.presencePenalty,
        systemPrompt: systemPrompt || undefined,
      }, (ev) => {
        const key = ev.side === "a" ? "aText" : "bText";
        if (ev.type === "token" && ev.side) {
          setArena((a) => ({ ...a, [key]: { ...a[key], text: a[key].text + (ev.text || "") } }));
        } else if (ev.type === "done" && ev.side) {
          setArena((a) => ({ ...a, [key]: { text: ev.text || "", done: true } }));
        } else if (ev.type === "error" && ev.side) {
          setArena((a) => ({ ...a, [key]: { text: `⚠ ${ev.message}`, done: true } }));
        }
      });
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠ ${e.message}` }]);
    } finally {
      setSending(false);
    }
  };

  /* Выбор понравившегося ответа: сохраняем в чат и выходим из Arena */
  const chooseArenaSide = async (side: "a" | "b") => {
    if (!activeId) return;
    const st = side === "a" ? arena.aText : arena.bText;
    if (!st.done || !st.text.trim() || st.text.startsWith("⚠")) return;
    try {
      await api.chatChoose(activeId, st.text);
      setArena((a) => ({ ...a, on: false }));
      await refreshMessages(activeId);
      inputRef.current?.focus();
    } catch { /* noop */ }
  };

  /* ── тулбар страницы ── */
  usePageToolbar(
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Field label={t("aichat.provider")} w={130}>
        <Select value={chatCfg.provider}
          onChange={(e) => setChatCfg({ provider: e.target.value, model: "" })}
          options={providers.map((p) => p.id)} />
      </Field>
      <Field label={t("aichat.model")} w={200}>
        <Select value={chatCfg.model} onChange={(e) => setChatCfg({ model: e.target.value })} options={models} />
      </Field>
      <IconBtn icon={Swords} active={arena.on} onClick={toggleArena} title={t("aichat.arena")} />
      <IconBtn icon={Settings2} active={settingsOpen} onClick={() => setSettingsOpen((v) => !v)} title={t("aichat.modelSettings")} />
      <IconBtn icon={Search} active={palette !== null} onClick={() => setPalette({ query: "" })} title="Ctrl+K" />
    </div>,
    [providers, chatCfg.provider, chatCfg.model, models, settingsOpen, arena.on, t]
  );

  /* ── регенерация последнего ответа ── */
  const regenerate = async () => {
    if (!activeId || sending) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser?.id) return;
    try { await api.chatTruncateFrom(activeId, lastUser.id); } catch { return; }
    setMessages((m) => m.filter((x) => (x.id || 0) < lastUser.id!));
    await send(lastUser.text);
  };

  const saveEdit = async () => {
    if (!editing || !activeId) return;
    const newText = editing.text.trim();
    const target = messages.find((m) => m.id === editing.id);
    setEditing(null);
    if (!target || !newText || newText === target.text) return;
    try { await api.chatTruncateFrom(activeId, target.id!); } catch { return; }
    setMessages((m) => m.filter((x) => (x.id || 0) < target.id!));
    await send(newText);
  };

  /* ── голосовой ввод ── */
  const toggleMic = () => {
    if (listening) { recogRef.current?.stop(); return; }
    const rec = createRecognition(lang === "ru" ? "ru-RU" : lang === "es" ? "es-ES" : lang === "fr" ? "fr-FR" : lang === "zh" ? "zh-CN" : lang === "ar" ? "ar-SA" : "en-US");
    if (!rec) return;
    recogRef.current = rec;
    let base = input;
    rec.onresult = (e: any) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      setInput((base + " " + final + interim).trim());
      if (final) base = (base + " " + final).trim();
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  /* ── вложения (в т.ч. вставка скриншотов Ctrl+V и drag&drop) ── */
  const addImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setAttachments((a) => [...a, { name: file.name || "image.png", type: "image", data: reader.result as string }]);
    reader.readAsDataURL(file);
  };
  const addTextFile = async (file: File) => {
    const text = await file.text();
    setAttachments((a) => [...a, { name: file.name, type: "text", data: text.slice(0, 10000) }]);
  };

  const handleFileAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) addImageFile(file);
      else if (["txt", "md", "csv"].includes(ext)) await addTextFile(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items || []);
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { addImageFile(f); e.preventDefault(); return; }
      }
    }
  };

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault();
    for (const f of Array.from(e.dataTransfer.files || [])) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (f.type.startsWith("image/")) addImageFile(f);
      else if (["txt", "md", "csv"].includes(ext)) addTextFile(f);
    }
  };

  const removeAttachment = (idx: number) => setAttachments((a) => a.filter((_, i) => i !== idx));

  const copyMessage = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const speak = (text: string) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "ru" ? "ru-RU" : "en-US";
    speechSynthesis.speak(u);
  };

  /* ── системные пресеты: выбор + свои ── */
  const handleSysPreset = (name: string) => {
    setSysPreset(name);
    const p = allPresets.find((x) => x.name === name);
    if (p) setSystemPrompt(p.prompt);
  };
  const addCustomPreset = () => {
    const name = presetDraft.name.trim();
    if (!name) return;
    const list = [...customPresets, { name, prompt: systemPrompt }];
    setCustomPresets(list);
    saveCustomPresets(list);
    setSysPreset(name);
    setPresetDraft({ open: false, name: "" });
  };
  const delCustomPreset = (name: string) => {
    const list = customPresets.filter((p) => p.name !== name);
    setCustomPresets(list);
    saveCustomPresets(list);
    if (sysPreset === name) handleSysPreset(SYSTEM_PROMPT_PRESETS[0].name);
  };

  /* ── Ctrl+K палитра: переход к чату / смена модели ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => (p ? null : { query: "" }));
      }
      if (e.key === "Escape") { setPalette(null); setPresetDraft((d) => ({ ...d, open: false })); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const paletteChats = useMemo(() => {
    const q = (palette?.query || "").trim().toLowerCase();
    return convs.filter((c) => !q || c.title.toLowerCase().includes(q)).slice(0, 8);
  }, [palette, convs]);
  const paletteModels = useMemo(() => {
    const q = (palette?.query || "").trim().toLowerCase();
    return models.filter((m) => !q || m.toLowerCase().includes(q)).slice(0, 6);
  }, [palette, models]);

  return (
    <div className="page page-flush">
      {/* ─── панель настроек ─── */}
      {settingsOpen && (
        <Glass className="settings-drawer">
          <div className="hyperparams-panel">
            <div className="hyper-presets">
              {HYPER_PRESETS.map((hp) => (
                <button key={hp.id} title={hp.id} onClick={() => setChatCfg(hp.cfg)}>{hp.label}</button>
              ))}
            </div>
            <label><span>{t("aichat.temperature")}</span><input type="range" min="0" max="2" step="0.05" value={chatCfg.temperature}
              onChange={(e) => setChatCfg({ temperature: parseFloat(e.target.value) })} />
              <span className="val">{chatCfg.temperature.toFixed(2)}</span></label>
            <label><span>Top P</span><input type="range" min="0" max="1" step="0.05" value={chatCfg.topP}
              onChange={(e) => setChatCfg({ topP: parseFloat(e.target.value) })} />
              <span className="val">{chatCfg.topP.toFixed(2)}</span></label>
            <label><span>Freq P</span><input type="range" min="0" max="2" step="0.1" value={chatCfg.frequencyPenalty}
              onChange={(e) => setChatCfg({ frequencyPenalty: parseFloat(e.target.value) })} />
              <span className="val">{chatCfg.frequencyPenalty.toFixed(1)}</span></label>
            <label><span>Pres P</span><input type="range" min="0" max="2" step="0.1" value={chatCfg.presencePenalty}
              onChange={(e) => setChatCfg({ presencePenalty: parseFloat(e.target.value) })} />
              <span className="val">{chatCfg.presencePenalty.toFixed(1)}</span></label>
            <label><span>{t("aichat.maxTokens")}</span><input type="number" min="64" max="65536" step="64" value={chatCfg.maxTokens}
              onChange={(e) => setChatCfg({ maxTokens: parseInt(e.target.value, 10) || 256 })} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={chatCfg.streaming}
                onChange={(e) => setChatCfg({ streaming: e.target.checked })} />
              {t("aichat.streaming")}
            </label>
          </div>
          <div style={{ width: 1, background: "var(--glass-border)", alignSelf: "stretch" }} />
          <div className="sys-panel">
            <select value={allPresets.some((p) => p.name === sysPreset) ? sysPreset : ""} onChange={(e) => handleSysPreset(e.target.value)}>
              {customPresets.length > 0 && <optgroup label={t("aichat.customPresets")}>
                {customPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </optgroup>}
              <optgroup label="System">
                {SYSTEM_PROMPT_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </optgroup>
            </select>
            <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("aichat.systemPlaceholder")} />
            <div className="sys-presets-actions">
              {presetDraft.open ? (
                <>
                  <input className="text-input" value={presetDraft.name} autoFocus
                    onChange={(e) => setPresetDraft((d) => ({ ...d, name: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && addCustomPreset()}
                    placeholder={t("aichat.presetName")} style={{ flex: 1, minWidth: 0 }} />
                  <Btn variant="primary" icon={Check} onClick={addCustomPreset}>{t("aichat.presetSave")}</Btn>
                  <Btn icon={X} onClick={() => setPresetDraft({ open: false, name: "" })}>{t("aichat.cancel")}</Btn>
                </>
              ) : (
                <>
                  <Btn icon={Plus} onClick={() => setPresetDraft({ open: true, name: "" })}>{t("aichat.presetNew")}</Btn>
                  {customPresets.map((p) => (
                    <button key={p.name} className="sys-preset-del" onClick={() => delCustomPreset(p.name)} title={t("aichat.delete")}>
                      {p.name} <X size={10} />
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Btn icon={Download} onClick={() => doExport("md")}>{t("aichat.exportMd")}</Btn>
            <Btn icon={Code2} onClick={() => doExport("json")}>{t("aichat.exportJson")}</Btn>
          </div>
        </Glass>
      )}

      {/* ─── Ctrl+K палитра ─── */}
      {palette && (
        <div className="palette-overlay" onMouseDown={() => setPalette(null)}>
          <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
            <input className="palette-input" autoFocus value={palette.query}
              onChange={(e) => setPalette({ query: e.target.value })}
              placeholder={`${t("aichat.search")}… (⌘K)`} />
            {paletteChats.length > 0 && (
              <>
                <div className="palette-group">{t("aichat.newChat")}</div>
                {paletteChats.map((c) => (
                  <button key={c.id} className="palette-item" onClick={() => { setActiveId(c.id); setPalette(null); }}>
                    💬 {c.title}
                  </button>
                ))}
              </>
            )}
            {paletteModels.length > 0 && (
              <>
                <div className="palette-group">{t("aichat.model")}</div>
                {paletteModels.map((m) => (
                  <button key={m} className={`palette-item ${m === chatCfg.model ? "is-active" : ""}`}
                    onClick={() => { setChatCfg({ model: m }); setPalette(null); }}>
                    {m === chatCfg.model ? "✓ " : ""}{m}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="chat-side">
        {/* ─── сайдбар чатов ─── */}
        <Glass className="chat-conv-list" style={{ padding: 8 }}>
          <div className="conv-search">
            <Search size={12} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={t("aichat.search")} />
            {search && <button onClick={() => setSearch("")}><X size={11} /></button>}
          </div>
          <Btn icon={Plus} onClick={newChat} style={{ marginBottom: 6 }}>{t("aichat.newChat")}</Btn>
          {groupedConvs.map((g) => (
            <div key={g.label} className="conv-group">
              <div className="conv-group-label">{g.label}</div>
              {g.items.map((c) => (
                renaming?.id === c.id ? (
                  <input key={c.id} className="conv-rename" autoFocus defaultValue={c.title}
                    onBlur={(e) => renameConv(c.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") renameConv(c.id, (e.target as HTMLInputElement).value); if (e.key === "Escape") setRenaming(null); }} />
                ) : (
                  <div key={c.id} className={`chat-conv ${c.id === activeId ? "is-active" : ""}`} onClick={() => setActiveId(c.id)}
                    onContextMenu={(e) => menu.open(e, [
                      { label: t("ctx.open"), icon: FileText, onClick: () => setActiveId(c.id) },
                      { label: t("ctx.rename"), icon: Pencil, onClick: () => setRenaming({ id: c.id, text: c.title }) },
                      { label: c.pinned ? t("ctx.unpin") : t("ctx.pin"), icon: c.pinned ? PinOff : Pin, onClick: () => togglePin(c) },
                      { separator: true },
                      { label: t("ctx.del"), icon: Trash2, danger: true, onClick: () => delConv(c.id) },
                    ])}>
                    {c.pinned ? <Pin size={11} style={{ color: "var(--amber)", flexShrink: 0 }} /> : null}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                    <span className="x">
                      <IconBtn icon={c.pinned ? PinOff : Pin} size={12} onClick={(e) => { e.stopPropagation(); togglePin(c); }} title={c.pinned ? t("aichat.unpin") : t("aichat.pin")} />
                      <IconBtn icon={Pencil} size={12} onClick={(e) => { e.stopPropagation(); setRenaming({ id: c.id, text: c.title }); }} title={t("aichat.rename")} />
                      <IconBtn icon={Trash2} size={13} onClick={(e) => { e.stopPropagation(); delConv(c.id); }} title={t("aichat.delete")} />
                    </span>
                  </div>
                )
              ))}
            </div>
          ))}
          {convs.length === 0 && <div className="muted-sm" style={{ padding: 8 }}>{t("aichat.noChats")}</div>}
        </Glass>

        {/* ─── основная колонка ─── */}
        <div className="chat-main">
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            {arena.on ? (
              /* ─── Arena: сравнение двух моделей ─── */
              <div className="arena-grid">
                {(["a", "b"] as const).map((side) => {
                  const st = side === "a" ? arena.aText : arena.bText;
                  const mdl = side === "a" ? arena.a : arena.b;
                  return (
                    <div key={side} className="arena-col">
                      <div className="arena-col-head">
                        <span className="arena-badge">{side.toUpperCase()}</span>
                        <select value={mdl} onChange={(e) => setArena((a) => ({ ...a, [side]: e.target.value }))}>
                          {models.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                      <div className="arena-col-body">
                        <div className="chat-bubble is-assistant" style={{ maxWidth: "100%" }}>
                          {st.text
                            ? parseSegments(st.text).map((seg, i) =>
                                seg.type === "code"
                                  ? <CodeBlock key={i} code={seg.text} lang={seg.lang || "text"} />
                                  : <span key={i} dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderInlineMd(seg.text)) }} />)
                            : !st.done && <div className="typing"><span /><span /><span /></div>}
                        </div>
                        {st.done && st.text && (
                          <>
                            <div className="arena-stats">{t("aichat.chars", { n: st.text.length })} · {mdl}</div>
                            {!st.text.startsWith("⚠") && (
                              <Btn variant="primary" icon={Check} onClick={() => chooseArenaSide(side)}>
                                {t("aichat.chooseAnswer")}
                              </Btn>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <MsgList
                messages={messages} sending={sending} streamingText={streamingText}
                editing={editing} setEditing={setEditing} copiedIdx={copiedIdx}
                onCopy={copyMessage} onRegenerate={regenerate} onSaveEdit={saveEdit}
                onSpeak={speak} stopGeneration={stopGeneration} lastStats={lastStats}
                t={t}
              />
            )}
            {showDown && (
              <button className="scroll-down-btn" onClick={() => { setAutoScroll(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}>
                <ChevronDown size={16} />
              </button>
            )}
          </div>

          {/* ─── панель ввода ─── */}
          <Glass className="chat-input-bar" style={{ position: "relative" }}
            onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
            {attachments.length > 0 && (
              <div className="chat-attachments" style={{ position: "absolute", bottom: "100%", left: 16, marginBottom: 4 }}>
                {attachments.map((a, i) => (
                  <div key={i} className="chat-attachment">
                    {a.type === "image" ? <img src={a.data} alt="" style={{ width: 20, height: 20, borderRadius: 4 }} /> : <FileText size={14} />}
                    <span>{a.name}</span>
                    <button onClick={() => removeAttachment(i)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: 0, fontSize: 14 }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea rows={1} ref={inputRef}
              placeholder={activeConv ? t("aichat.placeholder", { provider: activeConv.provider }) : t("aichat.createFirst")}
              value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (arena.on) { const q = input.trim(); if (q) { setInput(""); runArena(q); } } else send(); } }}
              disabled={!activeId} />
            <span className="char-counter" title={t("aichat.chars", { n: input.length })}>
              {input.length > 0 ? `${input.length} · ~${approxTokens(input)}` : ""}
            </span>
            <input ref={fileInputRef} type="file" accept="image/*,.txt,.md,.csv" multiple onChange={handleFileAttach}
              style={{ display: "none" }} />
            <IconBtn icon={Paperclip} onClick={() => fileInputRef.current?.click()} title={t("aichat.attach")} />
            <IconBtn icon={Mic} onClick={toggleMic} title={listening ? t("aichat.listening") : t("aichat.voiceInput")}
              style={listening ? { color: "var(--coral)" } : undefined} />
            {sending ? (
              <IconBtn icon={Square} onClick={stopGeneration} title={t("aichat.stop")} style={{ color: "var(--coral)" }} />
            ) : (
              <IconBtn icon={Send} onClick={() => { if (arena.on) { const q = input.trim(); if (q) { setInput(""); runArena(q); } } else send(); }} title={t("aichat.send")} disabled={!activeId || !input.trim()} />
            )}
          </Glass>
        </div>
      </div>
    </div>
  );
}
