import { useRef, useState } from "react";
import { PRESETS, type CustomSpec } from "@/pages/myspace/m3e/lib/custom";
import { draftElement, hasKey, type AiSettings } from "@/pages/myspace/m3e/lib/ai";
import { isRuUi, useLang } from "@/pages/myspace/m3e/lib/i18n";
import { useDocPalette } from "@/pages/myspace/m3e/lib/theme";
import type { Category, Palette } from "@/pages/myspace/m3e/lib/tokens";
import { CustomBody } from "@/pages/myspace/m3e/components/CustomNode";
import { Icon } from "@/pages/myspace/m3e/components/M3Node";
import { Field, Section, Tile } from "@/pages/myspace/m3e/components/ui";

const T = {
  ru: {
    mine: "Мои элементы",
    ai: "Создать с ИИ",
    prompt: "Опишите элемент: например, «карточка рейса с ценой и кнопкой»",
    make: "Создать",
    making: "Создаю…",
    add: "На холст",
    save: "В мои",
    saved: "Сохранено",
    noKey: "Для ИИ нужен ключ: укажите его на вкладке «ИИ».",
    fail: "Не получилось. Попробуйте описать иначе или проверьте ключ.",
    remove: "Удалить",
    empty: "Сохранённые элементы появятся здесь",
  },
  en: {
    mine: "My elements",
    ai: "Create with AI",
    prompt: "Describe the element, e.g. “flight card with a price and a button”",
    make: "Create",
    making: "Creating…",
    add: "Add to canvas",
    save: "Save",
    saved: "Saved",
    noKey: "AI needs a key: set it on the AI tab.",
    fail: "Could not make it. Try describing it differently or check the key.",
    remove: "Delete",
    empty: "Saved elements will appear here",
  },
};

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))",
  gap: 6,
};

/** Готовые элементы одной категории палитры. */
export function PresetTiles({
  category,
  p,
  onAdd,
  onDown,
}: {
  category: Category;
  p: Palette;
  onAdd: (spec: CustomSpec) => void;
  onDown: (e: React.PointerEvent, spec: CustomSpec) => void;
}) {
  const ru = isRuUi();
  const list = PRESETS.filter((x) => x.category === category);
  if (list.length === 0) return null;
  return (
    <div style={{ ...grid, marginTop: 6 }}>
      {list.map((x) => {
        const spec: CustomSpec = { name: ru ? x.ru : x.en, w: x.w, h: x.h, node: x.node };
        return (
          <Tile
            key={x.key}
            icon={x.icon}
            label={spec.name}
            p={p}
            onPointerDown={(e) => onDown(e, spec)}
            onClick={() => onAdd(spec)}
          />
        );
      })}
    </div>
  );
}

/** Предпросмотр составного элемента темой документа. */
function Preview({ spec, p }: { spec: CustomSpec; p: Palette }) {
  const dp = useDocPalette(p);
  const k = Math.min(1, 250 / spec.w);
  return (
    <div
      style={{
        height: spec.h * k,
        width: spec.w * k,
        maxWidth: "100%",
        borderRadius: 14,
        overflow: "hidden",
        background: dp.surface,
        border: `1px solid ${p.outlineVariant}`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{ width: spec.w, height: spec.h, transform: `scale(${k})`, transformOrigin: "0 0" }}
      >
        <CustomBody node={spec.node} p={dp} />
      </div>
    </div>
  );
}

const btn = (p: Palette, primary?: boolean): React.CSSProperties => ({
  height: 34,
  padding: "0 14px",
  borderRadius: 17,
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  background: primary ? p.primary : p.secondaryContainer,
  color: primary ? p.onPrimary : p.onSecondaryContainer,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
});

/** Блок «Создать с ИИ» и «Мои элементы». */
export function ElementStudio({
  p,
  ai,
  mine,
  onSave,
  onRemove,
  onAdd,
  onDown,
}: {
  p: Palette;
  ai: AiSettings;
  mine: CustomSpec[];
  onSave: (spec: CustomSpec) => void;
  onRemove: (i: number) => void;
  onAdd: (spec: CustomSpec) => void;
  onDown: (e: React.PointerEvent, spec: CustomSpec) => void;
}) {
  const lang = useLang();
  const L = isRuUi() ? T.ru : T.en;
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [spec, setSpec] = useState<CustomSpec | null>(null);
  const [kept, setKept] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const make = async () => {
    if (!q.trim() || busy) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setErr("");
    setKept(false);
    try {
      setSpec(await draftElement(ai, q, lang, ctl.signal));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr(L.fail);
    } finally {
      setBusy(false);
    }
  };
  const ready = hasKey(ai);

  return (
    <>
      <Section id="el-ai" icon="auto_awesome" title={L.ai} p={p}>
        <Field
          value={q}
          onChange={setQ}
          placeholder={L.prompt}
          p={p}
          multiline
          rows={3}
          aiBusy={busy}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button
            type="button"
            className="m3-press"
            disabled={!ready || busy || !q.trim()}
            onClick={() => void make()}
            style={{ ...btn(p, true), opacity: !ready || !q.trim() ? 0.5 : 1 }}
          >
            <Icon name="auto_awesome" size={16} />
            {busy ? L.making : L.make}
          </button>
          {!ready && <span style={{ fontSize: 12, color: p.outline }}>{L.noKey}</span>}
        </div>
        {err && (
          <div role="alert" style={{ fontSize: 12, color: p.error, marginTop: 8 }}>
            {err}
          </div>
        )}
        {spec && (
          <div className="m3e-rise" style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: p.onSurface }}>{spec.name}</div>
            <div
              onPointerDown={(e) => onDown(e, spec)}
              style={{
                cursor: "grab",
                touchAction: "none",
                width: "fit-content",
                maxWidth: "100%",
              }}
            >
              <Preview spec={spec} p={p} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="m3-press"
                style={btn(p, true)}
                onClick={() => onAdd(spec)}
              >
                <Icon name="add" size={16} />
                {L.add}
              </button>
              <button
                type="button"
                className="m3-press"
                style={btn(p)}
                disabled={kept}
                onClick={() => {
                  onSave(spec);
                  setKept(true);
                }}
              >
                <Icon name={kept ? "check" : "bookmark_add"} size={16} />
                {kept ? L.saved : L.save}
              </button>
            </div>
          </div>
        )}
      </Section>
      <Section id="el-mine" icon="bookmarks" title={L.mine} p={p}>
        {mine.length === 0 ? (
          <div style={{ fontSize: 12, color: p.outline, padding: "4px 2px" }}>{L.empty}</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {mine.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  justifyContent: "space-between",
                }}
              >
                <div
                  onPointerDown={(e) => onDown(e, m)}
                  style={{ cursor: "grab", touchAction: "none", minWidth: 0 }}
                  title={m.name}
                >
                  <Preview spec={m} p={p} />
                </div>
                <button
                  type="button"
                  className="m3-press"
                  title={L.remove}
                  aria-label={L.remove}
                  onClick={() => onRemove(i)}
                  style={{ ...btn(p), padding: 0, width: 30, height: 30, justifyContent: "center" }}
                >
                  <Icon name="delete" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
