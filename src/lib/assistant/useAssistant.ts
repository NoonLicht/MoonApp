import { useCallback, useEffect, useRef, useState } from "react";
import { runAgent } from "@/lib/assistant/agent";
import type { AssistantSettings, ChatItem, ChatStep, DocAdapter } from "@/lib/assistant/types";

const KEY = "moonapp.assistant.v2";

export const DEFAULT_SETTINGS: AssistantSettings = {
  model: "",
  agent: true,
  edit: true,
  commands: true,
  web: true,
  images: false,
  think: false,
};

function load(): AssistantSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<AssistantSettings>;
    return { ...DEFAULT_SETTINGS, ...v };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const CHATS_KEY = "moonapp.assistant.chats.v1";
/** Сколько реплик и документов хранится: хватает на прошлые беседы, не раздувая хранилище. */
const KEEP_ITEMS = 60;
const KEEP_DOCS = 40;

/** Беседы по документам из браузерного хранилища: картинки не сохраняем (они тяжёлые), шаги — да. */
function loadChats(): Record<string, ChatItem[]> {
  try {
    const v = JSON.parse(localStorage.getItem(CHATS_KEY) || "{}") as Record<string, ChatItem[]>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function saveChats(all: Record<string, ChatItem[]>): void {
  try {
    const keys = Object.keys(all).filter((k) => all[k]?.length);
    const out: Record<string, ChatItem[]> = {};
    for (const k of keys.slice(-KEEP_DOCS))
      out[k] = all[k].slice(-KEEP_ITEMS).map(({ images: _i, pictures: _p, ...rest }) => rest);
    localStorage.setItem(CHATS_KEY, JSON.stringify(out));
  } catch {
    /* без хранилища история живёт до перезагрузки */
  }
}

const uid = (): string => Math.random().toString(36).slice(2, 10);

/** Сколько предыдущих реплик беседы уходит модели вместе с новым запросом. */
const HISTORY = 8;

/**
 * Состояние помощника: настройки (общие для Word и Excel, живут в браузере) и беседы по документам.
 * `getAdapter` отдаёт актуальный адаптер страницы; `docId` — ключ беседы: у документа он постоянный
 * (имя файла), поэтому история возвращается при повторном открытии.
 */
export function useAssistant(getAdapter: () => DocAdapter | null, docId: string) {
  const [settings, setSettingsState] = useState<AssistantSettings>(load);
  const [chats, setChats] = useState<Record<string, ChatItem[]>>(loadChats);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const setSettings = useCallback((patch: Partial<AssistantSettings>) => {
    setSettingsState((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* без хранилища настройки живут до перезагрузки */
      }
      return next;
    });
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  // История сохраняется, когда ответ закончен: потоковые обновления не пишем в хранилище на каждый токен.
  useEffect(() => {
    if (!busy) saveChats(chats);
  }, [busy, chats]);

  const items = chats[docId] ?? [];

  const patchItem = useCallback(
    (id: string, fn: (it: ChatItem) => ChatItem) =>
      setChats((all) => ({
        ...all,
        [docId]: (all[docId] ?? []).map((it) => (it.id === id ? fn(it) : it)),
      })),
    [docId],
  );

  const send = useCallback(
    async (text: string, images: string[] = []): Promise<void> => {
      const adapter = getAdapter();
      const q = text.trim();
      if (!adapter || !q || abort.current) return;
      const history = (chatsRef.current[docId] ?? [])
        .filter((it) => it.text && !it.error)
        .slice(-HISTORY)
        .map((it) => ({ role: it.role, text: it.text }));
      const user: ChatItem = {
        id: uid(),
        role: "user",
        text: q,
        ...(images.length ? { images } : {}),
      };
      const bot: ChatItem = { id: uid(), role: "assistant", text: "", steps: [] };
      setChats((all) => ({ ...all, [docId]: [...(all[docId] ?? []), user, bot] }));
      const ac = new AbortController();
      abort.current = ac;
      setBusy(true);
      const s = settingsRef.current;
      adapter.setPictureSink((url) =>
        patchItem(bot.id, (it) => ({ ...it, pictures: [...(it.pictures ?? []), url] })),
      );
      try {
        await runAgent({
          adapter,
          settings: s,
          history,
          user: q,
          images,
          snapshot: s.agent ? undefined : await adapter.snapshot(9000),
          signal: ac.signal,
          events: {
            onText: (d) => patchItem(bot.id, (it) => ({ ...it, text: it.text + d })),
            onStep: (step: ChatStep) =>
              patchItem(bot.id, (it) => {
                const steps = it.steps ?? [];
                return {
                  ...it,
                  steps: steps.some((x) => x.id === step.id)
                    ? steps.map((x) => (x.id === step.id ? step : x))
                    : [...steps, step],
                };
              }),
          },
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError" && !ac.signal.aborted)
          patchItem(bot.id, (it) => ({ ...it, error: String((e as Error).message || e) }));
      } finally {
        adapter.setPictureSink(null);
        abort.current = null;
        setBusy(false);
        patchItem(bot.id, (it) => ({
          ...it,
          text: it.text.trim(),
          steps: (it.steps ?? []).map((x) => (x.state === "run" ? { ...x, state: "err" } : x)),
        }));
      }
    },
    [docId, getAdapter, patchItem],
  );

  const stop = useCallback(() => abort.current?.abort(), []);
  const clear = useCallback(() => {
    abort.current?.abort();
    setChats((all) => ({ ...all, [docId]: [] }));
  }, [docId]);

  return { settings, setSettings, items, busy, send, stop, clear };
}

export type AssistantState = ReturnType<typeof useAssistant>;
