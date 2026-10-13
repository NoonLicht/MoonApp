/**
 * Команды ИИ в редакторе заметок: строка вида `...факт про луну` + Enter.
 *
 * `...` в начале строки открывает подсказку со списком команд; Tab дополняет первую, клик по
 * пункту вставляет её. Enter выполняет команду: на месте строки появляется метка «⏳ …», а когда
 * модель ответит, метка заменяется результатом. Слова вне списка — свободный запрос к модели
 * (`...напиши стих про осень`). Всё заменяется обычными транзакциями — Ctrl+Z возвращает текст.
 */
import { Prec, StateField, type EditorState } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { tNow } from "@/app/i18n";

export type CommandId =
  | "format"
  | "fix"
  | "short"
  | "expand"
  | "simplify"
  | "formal"
  | "translate"
  | "table"
  | "list"
  | "summary"
  | "todo"
  | "plan"
  | "fact"
  | "continue"
  | "title"
  | "ideas"
  | "explain"
  | "tags"
  | "ask";

/** Команда: id, основное слово (то, что подставляется) и синонимы. */
// i18n-ignore-start
export const COMMANDS: { id: CommandId; word: string; aliases: string[] }[] = [
  { id: "format", word: "формат", aliases: ["оформи", "оформить", "markdown", "md", "format"] },
  { id: "fix", word: "исправь", aliases: ["исправить", "ошибки", "fix", "правка"] },
  { id: "short", word: "кратко", aliases: ["сократи", "short", "shorten"] },
  { id: "expand", word: "подробнее", aliases: ["расширь", "expand"] },
  { id: "simplify", word: "проще", aliases: ["упрости", "simplify"] },
  { id: "formal", word: "официально", aliases: ["формально", "деловой", "formal"] },
  { id: "translate", word: "перевод", aliases: ["переведи", "translate"] },
  { id: "table", word: "таблица", aliases: ["table"] },
  { id: "list", word: "список", aliases: ["list"] },
  { id: "summary", word: "резюме", aliases: ["итог", "тезисы", "суть", "summary", "tldr"] },
  { id: "todo", word: "задачи", aliases: ["todo", "чеклист"] },
  { id: "plan", word: "план", aliases: ["plan"] },
  { id: "fact", word: "факт", aliases: ["факты", "fact"] },
  { id: "continue", word: "продолжи", aliases: ["дальше", "continue"] },
  { id: "title", word: "заголовок", aliases: ["название", "title"] },
  { id: "ideas", word: "идеи", aliases: ["ideas"] },
  { id: "explain", word: "объясни", aliases: ["explain"] },
  { id: "tags", word: "теги", aliases: ["tags"] },
];
// i18n-ignore-end

const PREFIX = /^(\s*)(?:\.{3}|…)/;

export interface ParsedCommand {
  command: CommandId;
  args: string;
  /** Исходная строка (для возврата при ошибке). */
  raw: string;
}

/** Разбор строки: `...команда аргументы` или `...свободный запрос`. null — не команда. */
export function parseCommand(line: string): ParsedCommand | null {
  const m = PREFIX.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length).trim();
  if (!rest) return null;
  const [first, ...tail] = rest.split(/\s+/);
  const w = first.toLowerCase();
  const hit = COMMANDS.find((c) => c.word === w || c.aliases.includes(w));
  if (hit) return { command: hit.id, args: tail.join(" "), raw: line };
  return { command: "ask", args: rest, raw: line };
}

export interface AiCommandRequest {
  command: CommandId;
  args: string;
  content: string;
  selection: string;
}

export interface AiCommandResult {
  mode: "replace" | "insert";
  target: "selection" | "note";
  text: string;
}

export interface AiCommandHooks {
  run: (r: AiCommandRequest) => Promise<AiCommandResult>;
  onError: (message: string) => void;
}

/** Подсказка выбирается только пока набрано `...` и (необязательно) начало слова команды. */
function menuFor(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  const m = /^(\s*)(?:\.{3}|…)(\S*)$/.exec(line.text);
  if (!m || sel.head !== line.to) return null;
  const typed = m[2].toLowerCase();
  const items = COMMANDS.filter(
    (c) => !typed || c.word.startsWith(typed) || c.aliases.some((a) => a.startsWith(typed)),
  );
  if (!items.length) return null;
  return {
    pos: line.from + m[1].length,
    above: false,
    strictSide: true,
    arrow: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "ms-cmd-menu";
      const head = document.createElement("div");
      head.className = "ms-cmd-head";
      head.textContent = tNow("myspace.cmd.menuTitle");
      dom.appendChild(head);
      for (const c of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ms-cmd-item";
        const w = document.createElement("b");
        w.textContent = `...${c.word}`;
        const d = document.createElement("span");
        d.textContent = tNow(`myspace.cmd.${c.id}`);
        b.append(w, d);
        // mousedown, а не click: иначе редактор теряет фокус раньше, чем срабатывает вставка
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const l = view.state.doc.lineAt(view.state.selection.main.head);
          const text = `${m[1]}...${c.word} `;
          view.dispatch({
            changes: { from: l.from, to: l.to, insert: text },
            selection: { anchor: l.from + text.length },
          });
          view.focus();
        });
        dom.appendChild(b);
      }
      return { dom };
    },
  };
}

const menuField = StateField.define<Tooltip | null>({
  create: (state) => menuFor(state),
  update(v, tr) {
    return tr.docChanged || tr.selection ? menuFor(tr.state) : v;
  },
  provide: (f) => showTooltip.from(f),
});

/** Заменить точный фрагмент (ближайший к `near`); false — фрагмента уже нет. */
function replaceNear(view: EditorView, from: string, to: string, near: number): boolean {
  if (!view.dom.isConnected) return false;
  const doc = view.state.doc.toString();
  let best = -1;
  for (let i = doc.indexOf(from); i >= 0; i = doc.indexOf(from, i + 1))
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  if (best < 0) return false;
  view.dispatch({ changes: { from: best, to: best + from.length, insert: to } });
  return true;
}

function execute(view: EditorView, hooks: AiCommandHooks): boolean {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const parsed = parseCommand(line.text);
  if (!parsed) return false;
  // Выделение на другой строке — над ним и работает команда (иначе над всей заметкой).
  const selection =
    !sel.empty && (sel.to < line.from || sel.from > line.to)
      ? view.state.sliceDoc(sel.from, sel.to)
      : "";
  const marker = `⏳ ${tNow("myspace.cmd.running", { cmd: parsed.command === "ask" ? "…" : `...${parsed.command}` })} [${Math.random().toString(36).slice(2, 7)}]`;
  const indent = /^\s*/.exec(line.text)?.[0] ?? "";
  const before = view.state.doc.toString();
  const content = (before.slice(0, line.from) + before.slice(line.to + 1)).trim();
  const at = line.from;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: indent + marker },
    selection: { anchor: line.from + indent.length + marker.length },
  });
  void hooks
    .run({ command: parsed.command, args: parsed.args, content, selection })
    .then((r) => {
      const full = indent + marker;
      if (r.mode === "insert") {
        if (!replaceNear(view, full, r.text, at)) hooks.onError(tNow("myspace.cmd.gone"));
        return;
      }
      // Преобразование: метку убираем, текст заменяем.
      if (!replaceNear(view, `${full}\n`, "", at)) replaceNear(view, full, "", at);
      if (r.target === "selection" && selection) {
        if (!replaceNear(view, selection, r.text, at)) hooks.onError(tNow("myspace.cmd.gone"));
      } else {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.text } });
      }
    })
    .catch((e: unknown) => {
      replaceNear(view, indent + marker, parsed.raw, at);
      hooks.onError(e instanceof Error ? e.message : String(e));
    });
  return true;
}

/** Расширение редактора: подсказка по `...` и выполнение команд по Enter. */
export function aiCommandExtension(getHooks: () => AiCommandHooks | null) {
  return [
    menuField,
    Prec.high(
      keymap.of([
        {
          key: "Enter",
          run(view) {
            const h = getHooks();
            return h ? execute(view, h) : false;
          },
        },
        {
          // Tab дополняет начатое слово первой подходящей командой
          key: "Tab",
          run(view) {
            const line = view.state.doc.lineAt(view.state.selection.main.head);
            const m = /^(\s*)(?:\.{3}|…)(\S*)$/.exec(line.text);
            if (!m) return false;
            const typed = m[2].toLowerCase();
            const c = COMMANDS.find(
              (x) => x.word.startsWith(typed) || x.aliases.some((a) => a.startsWith(typed)),
            );
            if (!c) return false;
            const text = `${m[1]}...${c.word} `;
            view.dispatch({
              changes: { from: line.from, to: line.to, insert: text },
              selection: { anchor: line.from + text.length },
            });
            return true;
          },
        },
      ]),
    ),
  ];
}
