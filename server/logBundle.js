const fs = require("fs");
const os = require("os");
const path = require("path");
const { DIRS, FILES } = require("./config");
const logger = require("./logger");

/**
 * Сборка диагностического файла для кнопки «Собрать логи» (Настройки).
 *
 * Файл — обычный .txt, который создаётся в корне storage (рядом с exe у
 * установленного приложения), чтобы пользователь легко нашёл его и переслал
 * разработчику. Содержит:
 *   - окружение (версии, ОС, пути, аптайм);
 *   - настройки приложения (secrets.json НЕ включается — только имена ключей);
 *   - скачанные файлы (storage/downloads);
 *   - ПОЛНЫЙ журнал событий logs/audit.log (клики, навигация, ошибки, warn);
 *   - хвост рабочего лога logs/app.log и лог main-процесса logs/main.log.
 *
 * Держим последние MAX_REPORTS файлов, чтобы папка не пухла от повторных нажатий.
 */
const MAX_REPORTS = 10;
const MAX_AUDIT_BYTES = 24 * 1024 * 1024; // полный журнал (хвост, если больше)
const MAX_TAIL_BYTES = 2 * 1024 * 1024; // хвост app.log / main.log
const REPORT_PREFIX = "MoonApp-logs-";

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// Хвост файла по байтам: если файл больше лимита — берём последние строки.
function readTail(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return { text: fs.readFileSync(file, "utf8"), truncated: false };
    const fd = fs.openSync(file, "r");
    try {
      const start = st.size - maxBytes;
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, start);
      // первая строка может быть обрезана — отбрасываем её
      const raw = buf.toString("utf8");
      return { text: raw.slice(raw.indexOf("\n") + 1), truncated: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
}

function appVersion() {
  try {
    const { app } = require("electron");
    if (app?.getVersion) return app.getVersion();
  } catch {
    /* сервер запущен без Electron (dev/тесты) */
  }
  try {
    return require("../package.json").version || "unknown";
  } catch {
    return "unknown";
  }
}

function section(title) {
  return `\n==== ${title} ====\n`;
}

function describeEnvironment() {
  const cpu = os.cpus()[0]?.model || "unknown";
  let installDir = "unknown";
  try {
    const { app } = require("electron");
    if (app?.getPath) installDir = path.dirname(app.getPath("exe"));
  } catch {
    /* dev */
  }
  const v = process.versions;
  const lines = [
    `Создан:            ${new Date().toISOString()}`,
    `Версия приложения: ${appVersion()}`,
    `Electron:          ${v.electron || "-"}   Chromium: ${v.chrome || "-"}`,
    `Node:              ${v.node}   V8: ${v.v8}`,
    `ОС:                ${os.type()} ${os.release()} (${os.arch()})`.trim(),
    `Хост:              ${os.hostname()}`,
    `Процессор:         ${cpu} × ${os.cpus().length}`,
    `Память:            ${Math.round(os.totalmem() / 1024 ** 3)} GB (свободно ${Math.round(os.freemem() / 1024 ** 3)} GB)`,
    `Аптайм процесса:   ${Math.round(process.uptime())} сек`,
    `Каталог установки: ${installDir}`,
    `Storage:           ${DIRS.storage}`,
  ];
  return lines.join("\n") + "\n";
}

// Настройки: секреты (secrets.json) не включаются — только имена ключей.
function describeSettings() {
  let out = "";
  const settings = readFileSafe(FILES.settings);
  if (settings) {
    try {
      out += JSON.stringify(JSON.parse(settings), null, 2) + "\n";
    } catch {
      out += settings + "\n";
    }
  } else {
    out += "(settings.json отсутствует)\n";
  }
  out += section("Секреты (значения скрыты, только имена полей)");
  try {
    const secrets = JSON.parse(readFileSafe(FILES.secrets) || "{}");
    const keys = Object.keys(secrets);
    out += keys.length ? keys.map((k) => `- ${k}`).join("\n") + "\n" : "(секретов нет)\n";
  } catch {
    out += "(secrets.json не читается)\n";
  }
  return out;
}

function describeDownloads() {
  let out = "";
  try {
    const files = fs.readdirSync(DIRS.downloads);
    if (!files.length) return "(загрузок нет)\n";
    for (const f of files.slice(-200)) {
      try {
        const st = fs.statSync(path.join(DIRS.downloads, f));
        out += `${f}\t${st.size} B\t${st.mtime.toISOString()}\n`;
      } catch {
        out += `${f}\t?\n`;
      }
    }
  } catch {
    out += "(каталог загрузок недоступен)\n";
  }
  return out;
}

// Счётчики БД: без самих данных (там личные заметки/задачи), только объёмы.
function describeDataCounts() {
  try {
    const { stmts } = require("./db");
    const counts = {};
    for (const [name, st] of Object.entries(stmts)) {
      if (st && typeof st.all === "function" && name.endsWith("All")) {
        try {
          counts[name] = st.all().length;
        } catch {
          /* пропускаем */
        }
      }
    }
    return JSON.stringify(counts, null, 2) + "\n";
  } catch (e) {
    return `(недоступно: ${e.message})\n`;
  }
}

/* --- Настройки по страницам --- */
// Какая секция settings.json относится к какой странице приложения.
// Порядок = порядок страниц в доке; значения выводятся эффективные
// (дефолт, перекрытый сохранённым), чтобы отчёт был самодостаточным.
const PAGE_SETTINGS = [
  { id: "store", title: "Магазин приложений", sections: ["store"] },
  { id: "convert", title: "Конвертер файлов", sections: ["converter"] },
  { id: "compress", title: "Видеосжатие", sections: ["compressor"] },
  { id: "video", title: "Видео (загрузка)", sections: ["video", "media"] },
  { id: "music", title: "Музыка", sections: ["music"] },
  { id: "books", title: "Книги", sections: ["books"] },
  { id: "monitor", title: "Монитор системы", sections: ["monitor"] },
  { id: "myspace", title: "Моё пространство", sections: ["myspace"] },
  { id: "aichat", title: "ИИ-чат", sections: ["chat"] },
  { id: "voice", title: "Синтез речи", sections: ["voice"] },
  { id: "lecture", title: "Диктофон лекций", sections: ["lecture"] },
  { id: "bypass", title: "Обход блокировок", sections: ["zapret"] },
  { id: "archive", title: "Web Archive", sections: ["sitebak", "archiver"] },
  {
    id: "settings",
    title: "Настройки приложения",
    sections: ["general", "appearance", "performance", "window", "backup", "advanced"],
  },
];

// Выводит настройки каждой страницы с понятным заголовком.
function describePageSettings() {
  let merged;
  try {
    merged = require("./settings").load();
  } catch {
    return "(настройки недоступны)\n";
  }
  const used = new Set();
  let out = "";
  for (const page of PAGE_SETTINGS) {
    out += `\n--- ${page.title}  [страница: ${page.id}] ---\n`;
    for (const sec of page.sections) {
      if (used.has(sec)) continue; // общая секция (media) выводится в первой странице
      used.add(sec);
      out += `${sec}: ${JSON.stringify(merged[sec], null, 2)}\n`;
    }
  }
  const rest = Object.keys(merged).filter((k) => !used.has(k));
  if (rest.length) {
    out += `\n--- Прочие секции (к страницам не привязаны) ---\n`;
    for (const sec of rest) out += `${sec}: ${JSON.stringify(merged[sec], null, 2)}\n`;
  }
  return out;
}

/**
 * Локальные настройки интерфейса: снимок localStorage, который фронт
 * отправляет событием ui.settings.snapshot перед сбором логов (тут живут
 * вещи, не попадающие в settings.json: прогресс панели задач, флаги
 * редактирования конфига ИИ и т.п.). Берём последний снимок из audit.log.
 */
function describeUiSnapshot() {
  const audit = readTail(logger.files.audit, MAX_AUDIT_BYTES);
  let last = null;
  for (const line of audit.text.split("\n")) {
    const s = line.trim();
    if (!s.includes("ui.settings.snapshot")) continue;
    try {
      const e = JSON.parse(s);
      if (e.event === "ui.settings.snapshot") last = e;
    } catch {
      /* строка не JSON — пропускаем */
    }
  }
  if (!last)
    return "(снимок не найден — локальные настройки ещё не отправлялись; нажмите «Собрать логи» в интерфейсе)\n";
  return `Снято: ${last.ts}\n${JSON.stringify(last.data, null, 2)}\n`;
}

const LOG_LEVEL_TAG = { error: "ERROR", warn: "WARN ", info: "INFO ", action: "ACTION" };
// NDJSON → читаемые строки: "2026-09-13T13:20:11.123Z  ACTION  ui.click  {...}"
function formatNdjson(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      const tag = LOG_LEVEL_TAG[e.level] || String(e.level || "").toUpperCase();
      const data = e.data === undefined ? "" : "  " + JSON.stringify(e.data);
      out.push(`${e.ts || "?"}  ${tag}  ${e.event || "?"}${data}`);
    } catch {
      out.push(s); // строка не JSON (например, обрезанный хвост) — как есть
    }
  }
  return out.join("\n") + "\n";
}

function describeJournals() {
  const audit = readTail(logger.files.audit, MAX_AUDIT_BYTES);
  const rotated = readTail(logger.files.auditRotated, MAX_AUDIT_BYTES);
  const app = readTail(logger.files.app, MAX_TAIL_BYTES);
  const main = readTail(path.join(DIRS.logs, "main.log"), MAX_TAIL_BYTES);
  const lines = audit.text ? audit.text.split("\n").length : 0;

  let out = "";
  out += `Число записей в полном журнале: ${lines}\n`;
  if (audit.truncated) out += "(журнал больше 24 МБ — включён только хвост)\n";
  out += section("Полный журнал событий: audit.log (все действия, клики, ошибки)");
  out += formatNdjson(audit.text) || "(пусто)\n";
  if (rotated.text) {
    out += section("Предыдущий архив журнала: audit.1.log");
    out += formatNdjson(rotated.text);
  }
  out += section("Рабочий лог: app.log (по фильтрам настроек advanced.*)");
  out += formatNdjson(app.text) || "(пусто)\n";
  out += section("Лог main-процесса: main.log (Electron, обновления, окно)");
  out += main.text || "(пусто)\n";
  return out;
}

function listReports() {
  try {
    return fs
      .readdirSync(DIRS.storage)
      .filter((f) => f.startsWith(REPORT_PREFIX) && f.endsWith(".txt"))
      .map((f) => {
        const full = path.join(DIRS.storage, f);
        let size = 0,
          mtime = "";
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {
          /* ignore */
        }
        return { file: full, size, mtime };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    return [];
  }
}

function cleanupOldReports() {
  for (const r of listReports().slice(MAX_REPORTS)) {
    try {
      fs.rmSync(r.file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Собрать диагностический файл. Возвращает { file, size, events }.
 * Файл создаётся в корне storage — рядом с приложением у установленной сборки.
 */
function collect() {
  const startedAt = Date.now();
  const parts = [];
  parts.push("MoonApp — диагностический отчёт\n");
  parts.push("Файл содержит все события приложения: навигацию, нажатия, загрузки,\n");
  parts.push("предупреждения и ошибки. Передайте его разработчику для разбора проблемы.\n");
  parts.push(section("Окружение"));
  parts.push(describeEnvironment());
  parts.push(section("Настройки по страницам (эффективные значения: дефолт + сохранённое)"));
  parts.push(describePageSettings());
  parts.push(section("Локальные настройки интерфейса (localStorage, снимок из UI)"));
  parts.push(describeUiSnapshot());
  parts.push(section("Настройки приложения (сырой settings.json, как сохранён)"));
  parts.push(describeSettings());
  parts.push(section("Скачанные файлы (storage/downloads)"));
  parts.push(describeDownloads());
  parts.push(section("Объём данных (счётчики, без личных записей)"));
  parts.push(describeDataCounts());
  parts.push(describeJournals());

  const text = parts.join("");
  const file = path.join(DIRS.storage, `${REPORT_PREFIX}${stamp()}.txt`);
  fs.writeFileSync(file, text, "utf8");
  cleanupOldReports();

  const size = fs.statSync(file).size;
  const events = text.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)).length;
  logger.info("diagnostics.collect", { file, size, events, ms: Date.now() - startedAt });
  return { file, size, events };
}

const pagesForSection = (section) => {
  for (const p of PAGE_SETTINGS) if (p.sections.includes(section)) return p;
  return null;
};

module.exports = { collect, listReports, PAGE_SETTINGS, pagesForSection, appVersion };
