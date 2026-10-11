/**
 * Вид заметок: шрифт и масштаб текста редактора. Общие для всех заметок и запоминаются
 * (localStorage), как «тема документа»; редактор подписывается и подхватывает изменения сразу.
 */

export interface NoteFont {
  id: string;
  label: string;
  css: string;
}

export const NOTE_FONTS: NoteFont[] = [
  { id: "mono", label: "Monospace", css: "var(--font-mono)" },
  { id: "sans", label: "Sans-serif", css: "var(--font-sans, 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif)" },
  { id: "serif", label: "Serif", css: "Georgia, 'Times New Roman', 'Noto Serif', serif" },
  { id: "rounded", label: "Rounded", css: "'Nunito', 'Segoe UI Variable', 'Trebuchet MS', 'Segoe UI', sans-serif" },
  { id: "book", label: "Book", css: "'Palatino Linotype', Palatino, 'Book Antiqua', Cambria, serif" },
  { id: "hand", label: "Handwriting", css: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive" },
];

export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2.5;
const STEP = 0.1;
const KEY = "moonapp.notes.view";

export interface NoteView {
  font: string;
  scale: number;
}

const clampScale = (n: number): number => Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) * 100) / 100;

function load(): NoteView {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<NoteView>;
    return {
      font: NOTE_FONTS.some((f) => f.id === j.font) ? (j.font as string) : "mono",
      scale: typeof j.scale === "number" ? clampScale(j.scale) : 1,
    };
  } catch {
    return { font: "mono", scale: 1 };
  }
}

let cur: NoteView | null = null;
const subs = new Set<(v: NoteView) => void>();

export function getNoteView(): NoteView {
  if (!cur) cur = load();
  return cur;
}

function set(next: NoteView): void {
  cur = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* без запоминания */
  }
  subs.forEach((f) => f(next));
}

export const setNoteFont = (font: string): void => {
  if (NOTE_FONTS.some((f) => f.id === font)) set({ ...getNoteView(), font });
};
export const setNoteScale = (scale: number): void => set({ ...getNoteView(), scale: clampScale(scale) });
export const zoomNote = (dir: 1 | -1 | 0): void =>
  setNoteScale(dir === 0 ? 1 : getNoteView().scale + dir * STEP);

export function subscribeNoteView(fn: (v: NoteView) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export const fontCss = (id: string): string => (NOTE_FONTS.find((f) => f.id === id) ?? NOTE_FONTS[0]).css;
