import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";

/**
 * «Автор мысли» прямо в редакторе: полоска слева у строк абзацев, которые вы
 * вставили или которые написал ИИ. Данные приходят событием окна от панели
 * «Мышление» (ProvenanceSection) — редактор ничего не знает о сервере.
 */
export type ProvenanceOrigin = "own" | "copied" | "ai";
export interface ProvenanceMark {
  start: number;
  end: number;
  origin: ProvenanceOrigin;
}

export const PROVENANCE_EVENT = "moonapp:provenance";

/** null — снять разметку. */
export function publishProvenance(marks: ProvenanceMark[] | null): void {
  window.dispatchEvent(new CustomEvent(PROVENANCE_EVENT, { detail: marks }));
}

const setMarks = StateEffect.define<ProvenanceMark[] | null>();

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const marks = e.value;
      if (!marks) {
        next = Decoration.none;
        continue;
      }
      const b = new RangeSetBuilder<Decoration>();
      const doc = tr.state.doc;
      const seen = new Set<number>();
      for (const m of [...marks].sort((a, c) => a.start - c.start)) {
        if (m.origin === "own" || m.start >= doc.length) continue;
        const first = doc.lineAt(Math.max(0, m.start)).number;
        const last = doc.lineAt(Math.min(doc.length, Math.max(m.start, m.end - 1))).number;
        for (let n = first; n <= last; n++) {
          if (seen.has(n)) continue;
          seen.add(n);
          b.add(doc.line(n).from, doc.line(n).from, Decoration.line({ class: `cm-prov cm-prov-${m.origin}` }));
        }
      }
      next = b.finish();
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const bridge = ViewPlugin.fromClass(
  class {
    private readonly onEvent: (e: Event) => void;
    constructor(view: EditorView) {
      this.onEvent = (e: Event) => {
        const marks = (e as CustomEvent<ProvenanceMark[] | null>).detail;
        view.dispatch({ effects: setMarks.of(marks) });
      };
      window.addEventListener(PROVENANCE_EVENT, this.onEvent);
    }
    destroy() {
      window.removeEventListener(PROVENANCE_EVENT, this.onEvent);
    }
  },
);

const theme = EditorView.baseTheme({
  ".cm-prov-copied": { boxShadow: "inset 3px 0 0 #e0a030", backgroundColor: "rgba(224,160,48,0.07)" },
  ".cm-prov-ai": { boxShadow: "inset 3px 0 0 #5b8def", backgroundColor: "rgba(91,141,239,0.07)" },
});

export const provenanceExtension: Extension = [field, bridge, theme];
