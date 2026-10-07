/**
 * Выделено из lecture.ts при разбиении крупного файла (поведение не менялось).
 */
import * as diarize from "./diarize";
import path from "path";
import { getStatus } from "./lecture";

/* ------------------------- Экспорт ------------------------- */

export function fmtTs(ms: any) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return [h, m, sec].map((x) => String(x).padStart(2, "0")).join(":");
}

function fmtSrtTime(sec: any) {
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  const msPart = String(Math.round((sec % 1) * 1000)).padStart(3, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${msPart}`;
}

function fmtVttTime(sec: any) {
  return fmtSrtTime(sec).replace(",", ".");
}

/**
 * Подпись говорящего для строки расшифровки.
 *
 * Двухдорожечный режим уже даёт главное деление голосов БЕЗ отдельной модели:
 * системный звук (sys) — это эфир, т.е. лектор или запись курса; микрофон (mic) —
 * аудитория в комнате (студенты, вопросы). Разделение голосов ВНУТРИ дорожки
 * (кто именно из студентов) требует диаризации по отпечаткам голоса — сейчас её
 * нет: одна дорожка = один говорящий.
 *
 * labels приходят с клиента уже переведёнными: экспорт читает пользователь, а
 * сервер не знает язык интерфейса.
 */
function speakerOf(chunk: any, labels: Record<string, any> = {}) {
  if (!labels || labels.mode === "off") return "";
  const src = chunk.source === "sys" ? "sys" : "mic";
  // Диаризация (sherpa) даёт говорящего ВНУТРИ дорожки: «Лектор 2», «Аудитория 1».
  // Если разбора не было — остаётся подпись дорожки.
  const sp = String(chunk.speaker || "");
  const named = sp && labels.speakers ? labels.speakers[sp] : "";
  const who = named || (labels[src] ? String(labels[src]) : "");
  if (!who) return "";
  // «?» — в чанке звучали двое (доля доминирующего голоса ниже 55%). Приписать
  // реплику одному говорящему было бы враньём, поэтому помечаем сомнение.
  return Number(chunk.speakerRatio ?? 1) < 0.55 ? `${who}?` : who;
}

function buildMarkdown(id: any, labels = {}) {
  const st = getStatus(id);
  if (!st) return "";
  const lines = [
    `# ${st.lecture.title}`,
    "",
    `> Запись от ${st.lecture.started_at} · длительность ${fmtTs(st.recordingSec * 1000)}`,
    "",
  ];
  if (st.lecture.notes) lines.push("## Важное (маркеры)", "", st.lecture.notes, "");
  lines.push("## Расшифровка", "");
  for (const c of st.chunks) {
    if (!c.text) continue;
    const who = speakerOf(c, labels);
    lines.push(`**[${fmtTs(c.start_ms)}]**${who ? ` **${who}:**` : ""} ${c.text}`, "");
  }
  return lines.join("\n");
}

function buildSrt(id: any, labels = {}) {
  const st = getStatus(id);
  if (!st) return "";
  let idx = 0;
  const out = [];
  for (const c of st.chunks) {
    if (!c.text) continue;
    const start = c.start_ms / 1000;
    const end = Math.max(c.end_ms / 1000, start + 1);
    const who = speakerOf(c, labels);
    out.push(
      `${++idx}`,
      `${fmtSrtTime(start)} --> ${fmtSrtTime(end)}`,
      `${who ? `— ${who}: ` : ""}${c.text}`,
      "",
    );
  }
  return out.join("\n");
}

function buildVtt(id: any, labels = {}) {
  const st = getStatus(id);
  if (!st) return "";
  const out = ["WEBVTT", ""];
  for (const c of st.chunks) {
    if (!c.text) continue;
    const start = c.start_ms / 1000;
    const end = Math.max(c.end_ms / 1000, start + 1);
    const who = speakerOf(c, labels);
    // Голос — блоком <v>: плееры (VLC и др.) читают это как имя говорящего.
    out.push(
      `${fmtVttTime(start)} --> ${fmtVttTime(end)}`,
      who ? `<v ${who}>${c.text}` : c.text,
      "",
    );
  }
  return out.join("\n");
}

/** Экспорт расшифровки: labels — подписи говорящих с клиента (переведённые). */
export function exportContent(id: any, format: any, labels: Record<string, any> = {}) {
  // Подписи говорящих по диаризации (если она запускалась): sys_0 → «Лектор»,
  // sys_1 → «Лектор 2». Считаем один раз на экспорт, а не на каждый чанк.
  const withSpeakers =
    labels && labels.mode !== "off"
      ? { ...labels, speakers: diarize.speakerNames(id, labels) }
      : labels;
  if (format === "srt")
    return {
      mime: "application/x-subrip",
      body: buildSrt(id, withSpeakers),
      name: `lecture_${id}.srt`,
    };
  if (format === "vtt")
    return { mime: "text/vtt", body: buildVtt(id, withSpeakers), name: `lecture_${id}.vtt` };
  return {
    mime: "text/markdown",
    body: buildMarkdown(id, withSpeakers),
    name: `${safeName(getStatus(id)?.lecture.title || "lecture")}.md`,
  };
}

function safeName(name: any) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 80) || "lecture"
  );
}

/**
 * Заголовок Content-Disposition с именем файла.
 *
 * Почему не просто filename="…": в имя MD-файла попадает НАЗВАНИЕ лекции, а оно
 * почти всегда на русском. Node запрещает символы вне ASCII в заголовках и
 * отвечает 400 «Invalid character in header content» — именно поэтому падала
 * выгрузка .md (а srt/vtt выживали: у них имя lecture_<id>). Здесь ASCII-копию
 * чистим без потери читаемости, а настоящее имя отдаём в filename*=UTF-8''
 * (RFC 5987): браузер и Electron понимают его и сохраняют файл по-русски.
 */
export function contentDisposition(name: any) {
  const full = String(name || "lecture");
  const ext = (path.extname(full).match(/^\.[A-Za-z0-9]{1,8}$/) || [""])[0];
  // Кириллицу выкидываем целиком. Проверяем ИМЯ без расширения: у «.md» есть
  // буква, поэтому проверка по всему имени пропускала бы «filename=".md"».
  const base = full.slice(0, full.length - ext.length);
  let asciiBase = base
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  if (!/[A-Za-z0-9]/.test(asciiBase)) asciiBase = "lecture";
  return `attachment; filename="${asciiBase}${ext}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}
