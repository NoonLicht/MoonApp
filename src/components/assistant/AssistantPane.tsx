import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ClipboardPaste,
  Copy,
  Image as ImageIcon,
  Loader2,
  Send,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/api/client";
import type { LlamaStatus } from "@/api/client";
import type { WebSettings } from "@/api/apiAssistant";
import type { ChatItem, ChatStep, DocAdapter } from "@/lib/assistant/types";
import { useAssistant } from "@/lib/assistant/useAssistant";

type Tw = (key: string, vars?: Record<string, string | number>) => string;

/** Модели, которые стоит предложить в первую очередь: id семейства в каталоге → подпись. */
const RECOMMENDED: { group: string; name: string; note: string }[] = [
  { group: "gemma4-e4b", name: "Gemma 4 E4B", note: "text · images · audio" },
  { group: "gemma4-e2b", name: "Gemma 4 E2B", note: "light, runs on a weak PC" },
  { group: "qwen35-9b", name: "Qwen3.5 9B", note: "best quality for 8 GB" },
  { group: "qwen35-4b", name: "Qwen3.5 4B", note: "fast and capable" },
  { group: "qwen3vl-8b-instruct", name: "Qwen3-VL 8B", note: "strong at images" },
];

const NOT_CHAT = /embedding|mmproj|chandra|tts|translategemma/i;

/** Подпись шага «Заголовок: деталь» — заголовок переводится, деталь остаётся как есть. */
const stepLabel = (label: string, tw: Tw): string => {
  const [head, ...rest] = label.split(": ");
  return rest.length ? `${tw(head)}: ${rest.join(": ")}` : tw(head);
};

const URL_RE = /(https?:\/\/[^\s)>\]]+)/g;

function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer noopener">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Step({ s, tw }: { s: ChatStep; tw: Tw }) {
  return (
    <div className={`as-step ${s.state}`} title={s.detail}>
      {s.state === "run" ? (
        <Loader2 size={12} className="as-spin" />
      ) : s.state === "ok" ? (
        <Check size={12} />
      ) : (
        <AlertCircle size={12} />
      )}
      <span>{stepLabel(s.label, tw)}</span>
      {s.state === "err" && s.detail ? <em>{s.detail.slice(0, 120)}</em> : null}
    </div>
  );
}

function Switch({
  on,
  onChange,
  title,
  hint,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`as-switch${disabled ? " off" : ""}`}>
      <span className="as-switch-text">
        <b>{title}</b>
        {hint ? <small>{hint}</small> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={on && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i aria-hidden />
    </label>
  );
}

/** Настройки помощника: модель и то, что ему разрешено. */
function Settings({
  state,
  tw,
  imageReady,
}: {
  state: ReturnType<typeof useAssistant>;
  tw: Tw;
  imageReady: boolean;
}) {
  const { settings: s, setSettings } = state;
  const [st, setSt] = useState<LlamaStatus | null>(null);
  const [web, setWeb] = useState<WebSettings | null>(null);
  const [searx, setSearx] = useState("");
  const [brave, setBrave] = useState("");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(() => {
    api
      .llamaStatus()
      .then(setSt)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 3000);
    api
      .assistantWebSettings()
      .then((w) => {
        setWeb(w);
        setSearx(w.searxng);
      })
      .catch(() => undefined);
    return () => window.clearInterval(t);
  }, [refresh]);

  const installed = useMemo(
    () => (st?.models ?? []).filter((m) => !NOT_CHAT.test(m.file)).map((m) => m.file),
    [st],
  );
  const dl = st?.download;
  const downloading = dl?.status === "downloading";

  const saveWeb = async (): Promise<void> => {
    setErr("");
    try {
      const w = await api.assistantSetWebSettings({
        searxng: searx,
        ...(brave.trim() ? { braveKey: brave.trim() } : {}),
      });
      setWeb(w);
      setBrave("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr(String((e as Error).message || e));
    }
  };

  return (
    <div className="as-settings">
      <div className="as-sec">{tw("Model")}</div>
      <select
        className="as-select"
        value={s.model}
        onChange={(e) => setSettings({ model: e.target.value })}
        aria-label={tw("Model")}
      >
        <option value="">{tw("Automatic")}</option>
        {installed.map((f) => (
          <option key={f} value={f}>
            {f.replace(/\.gguf$/i, "")}
          </option>
        ))}
      </select>
      {!installed.length && <div className="as-note">{tw("No model installed")}</div>}

      <div className="as-sec">{tw("Recommended models")}</div>
      <div className="as-rec">
        {RECOMMENDED.map((r) => {
          const items = (st?.catalog ?? []).filter((m) => m.group === r.group);
          const q4 = items.find((m) => m.note === "q4km") ?? items[0];
          const have = items.some((m) => st?.models.some((x) => x.file === m.file));
          const active = downloading && items.some((m) => m.file === dl?.file || m.extra?.some((e) => (e.as ?? e.file) === dl?.file));
          return (
            <div key={r.group} className="as-rec-row">
              <div>
                <b>{r.name}</b>
                <small>{tw(r.note)}</small>
              </div>
              {have ? (
                <span className="as-ok">
                  <Check size={13} /> {tw("Installed")}
                </span>
              ) : active && dl ? (
                <span className="as-note">
                  {dl.total ? Math.round((dl.bytes / dl.total) * 100) : 0}%
                </span>
              ) : (
                <button
                  type="button"
                  className="as-btn"
                  disabled={!q4 || downloading}
                  onClick={() => {
                    if (q4) void api.llamaModelDownload({ id: q4.id }).then(refresh);
                  }}
                >
                  {tw("Download")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="as-sec">{tw("What the assistant may do")}</div>
      <Switch
        on={s.agent}
        onChange={(v) => setSettings({ agent: v })}
        title={tw("Agent mode")}
        hint={tw("Works in several steps on its own: reads the document, edits it, looks things up")}
      />
      <Switch
        on={s.edit}
        disabled={!s.agent}
        onChange={(v) => setSettings({ edit: v })}
        title={tw("Edit the document")}
        hint={tw("Insert, replace and delete text, write cells and formulas")}
      />
      <Switch
        on={s.commands}
        disabled={!s.agent}
        onChange={(v) => setSettings({ commands: v })}
        title={tw("App commands")}
        hint={tw("Any ribbon command: formatting, tables, charts, styles…")}
      />
      <Switch
        on={s.web}
        disabled={!s.agent}
        onChange={(v) => setSettings({ web: v })}
        title={tw("Web access")}
        hint={tw("Search the internet and read pages, with source links")}
      />
      <Switch
        on={s.images}
        disabled={!s.agent || !imageReady}
        onChange={(v) => setSettings({ images: v })}
        title={tw("Image generation")}
        hint={imageReady ? tw("Create pictures with Qwen-Image and insert them") : tw("Install a Qwen-Image model in Settings first")}
      />
      <Switch
        on={s.think}
        onChange={(v) => setSettings({ think: v })}
        title={tw("Thinking mode")}
        hint={tw("Slower, but more careful on hard tasks")}
      />

      <div className="as-sec">{tw("Web search sources")}</div>
      <div className="as-note">
        {tw("Wikipedia works without setup. For full web search add your own SearXNG address or a Brave Search key.")}
      </div>
      <input
        className="as-input"
        value={searx}
        placeholder="SearXNG: https://…"
        onChange={(e) => setSearx(e.target.value)}
      />
      <input
        className="as-input"
        type="password"
        value={brave}
        placeholder={web?.hasBrave ? `Brave API key: ${tw("saved")}` : "Brave Search API key"}
        onChange={(e) => setBrave(e.target.value)}
      />
      <div className="as-row">
        <button type="button" className="as-btn" onClick={() => void saveWeb()}>
          {tw("Save")}
        </button>
        {saved && <span className="as-ok">{tw("Saved")}</span>}
        {err && <span className="as-err">{err}</span>}
      </div>
    </div>
  );
}

function Bubble({
  it,
  tw,
  canInsert,
  onInsert,
  busy,
}: {
  it: ChatItem;
  tw: Tw;
  canInsert: boolean;
  onInsert: (t: string) => void;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (it.role === "user")
    return (
      <div className="as-msg user">
        {it.images?.map((src, i) => <img key={i} src={src} alt="" className="as-thumb" />)}
        <div className="as-text">{it.text}</div>
      </div>
    );
  return (
    <div className="as-msg bot">
      {it.steps?.length ? (
        <div className="as-steps">
          {it.steps.map((s) => (
            <Step key={s.id} s={s} tw={tw} />
          ))}
        </div>
      ) : null}
      {it.text ? (
        <div className="as-text">
          <Linkified text={it.text} />
        </div>
      ) : busy && !it.error ? (
        <div className="as-wait">
          <Loader2 size={13} className="as-spin" /> {tw("Working…")}
        </div>
      ) : null}
      {it.error ? (
        <div className="as-err">
          <AlertCircle size={13} /> {it.error}
        </div>
      ) : null}
      {it.text && !busy ? (
        <div className="as-actions">
          <button
            type="button"
            className="as-link"
            onClick={() => {
              void navigator.clipboard?.writeText(it.text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />} {tw("Copy")}
          </button>
          {canInsert ? (
            <button type="button" className="as-link" onClick={() => onInsert(it.text)}>
              <ClipboardPaste size={12} /> {tw("Insert into document")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const readImage = (f: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/**
 * Панель помощника справа от документа (Word и Excel): чат, шаги агента и настройка модели и прав.
 * Адаптер приложения (`getAdapter`) знает, как читать и править именно этот документ.
 */
export default function AssistantPane({
  getAdapter,
  docId,
  tw,
  quick,
  onClose,
  imageReady = false,
}: {
  getAdapter: () => DocAdapter | null;
  docId: string;
  tw: Tw;
  /** Готовые запросы для пустой беседы (английский текст — он же ключ перевода). */
  quick: string[];
  onClose: () => void;
  imageReady?: boolean;
}) {
  const state = useAssistant(getAdapter, docId);
  const { items, busy, send, stop, clear, settings } = state;
  const [showSettings, setShowSettings] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [noModel, setNoModel] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .llamaStatus()
      .then((s) => setNoModel(!s.models.some((m) => !NOT_CHAT.test(m.file))))
      .catch(() => undefined);
  }, [showSettings]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const submit = (q = text): void => {
    if (!q.trim() || busy) return;
    void send(q, images);
    setText("");
    setImages([]);
  };

  const addImages = async (files: FileList | null): Promise<void> => {
    if (!files) return;
    const list = [...files].filter((f) => f.type.startsWith("image/") && f.size < 8 * 1024 * 1024);
    const urls = await Promise.all(list.map(readImage));
    setImages((cur) => [...cur, ...urls].slice(0, 4));
  };

  return (
    <aside className="wd-pane right as-pane">
      <div className="wd-pane-head">
        <Sparkles size={14} />
        <span style={{ flex: 1 }}>{tw("Assistant")}</span>
        <button
          type="button"
          className={`wd-x-btn${showSettings ? " on" : ""}`}
          aria-label={tw("Assistant settings")}
          title={tw("Assistant settings")}
          onClick={() => setShowSettings((v) => !v)}
        >
          <SlidersHorizontal size={14} />
        </button>
        <button
          type="button"
          className="wd-x-btn"
          aria-label={tw("New chat")}
          title={tw("New chat")}
          disabled={!items.length}
          onClick={clear}
        >
          <Trash2 size={14} />
        </button>
        <button type="button" className="wd-x-btn" aria-label={tw("Close")} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {showSettings ? (
        <div className="as-scroll">
          <Settings state={state} tw={tw} imageReady={imageReady} />
        </div>
      ) : (
        <>
          <div className="as-scroll">
            {items.length === 0 ? (
              <div className="as-empty">
                <Sparkles size={22} />
                <p>{tw("Ask me to read, write, edit or look things up in this document.")}</p>
                {noModel && (
                  <button type="button" className="as-btn" onClick={() => setShowSettings(true)}>
                    {tw("Choose a model")}
                  </button>
                )}
                <div className="as-quick">
                  {quick.map((q) => (
                    <button key={q} type="button" onClick={() => submit(tw(q))} disabled={busy}>
                      {tw(q)}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              items.map((it, i) => (
                <Bubble
                  key={it.id}
                  it={it}
                  tw={tw}
                  busy={busy && i === items.length - 1}
                  canInsert={!settings.agent || !settings.edit}
                  onInsert={(t) => void getAdapter()?.insert(t)}
                />
              ))
            )}
            <div ref={end} />
          </div>
          <div className="as-composer">
            {images.length > 0 && (
              <div className="as-attached">
                {images.map((src, i) => (
                  <span key={i} className="as-att">
                    <img src={src} alt="" />
                    <button type="button" aria-label={tw("Remove")} onClick={() => setImages((c) => c.filter((_, j) => j !== i))}>
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={text}
              rows={2}
              placeholder={tw("Ask the assistant…")}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  void addImages(e.clipboardData.files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="as-composer-bar">
              <button type="button" className="wd-x-btn" title={tw("Attach image")} aria-label={tw("Attach image")} onClick={() => file.current?.click()}>
                <ImageIcon size={15} />
              </button>
              <input
                ref={file}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void addImages(e.target.files);
                  e.target.value = "";
                }}
              />
              <span className="as-mode">
                {settings.agent ? tw("Agent") : tw("Chat")}
                {settings.agent && settings.web ? " · web" : ""}
              </span>
              <span style={{ flex: 1 }} />
              {busy ? (
                <button type="button" className="as-send stop" onClick={stop} aria-label={tw("Stop")}>
                  <Square size={13} />
                </button>
              ) : (
                <button type="button" className="as-send" disabled={!text.trim()} onClick={() => submit()} aria-label={tw("Send")}>
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
