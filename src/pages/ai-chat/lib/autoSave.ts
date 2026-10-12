import { useEffect, useRef } from "react";
import { api } from "@/api/client";

const KEY = "moonapp.chat.autosave";

/** Включено ли автосохранение ценных ответов (настройка этого устройства). */
export function isAutoSaveOn(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoSave(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(KEY, on ? "1" : "0");
  } catch {
    /* хранилище недоступно — настройка не сохранится */
  }
}

/**
 * Когда ответ дописан, отправляет его на сервер с auto=true: сервер сам решает,
 * ценный ли он (код, структура, объём) и сохраняет только такие.
 */
export function useAutoSaveAnswers(
  messages: { role: "user" | "assistant"; text: string }[],
  sending: boolean,
): void {
  const wasSending = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    // Срабатываем только после перехода «идёт генерация → закончилась», иначе
    // открытие старой переписки пересохраняло бы её последний ответ. Если
    // итоговое сообщение появилось в списке чуть позже, ждём его (pending).
    if (wasSending.current && !sending) pending.current = true;
    if (sending) pending.current = false;
    wasSending.current = sending;
    if (!pending.current || sending || !messages.length) return;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant" || !last.text.trim()) return;
    pending.current = false;
    if (!isAutoSaveOn()) return;
    const question = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
    api.chatSaveAnswer(question, last.text, { auto: true }).catch(() => undefined);
  }, [messages, sending]);
}
