import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Copy,
  Eye,
  EyeOff,
  Group,
  Italic,
  Lock,
  Trash2,
  Unlock,
  Ungroup,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from "lucide-react";
import {
  INK,
  SHAPES,
  SWATCHES,
  type AlignKind,
  type Head,
  type Obj,
  type ShapeKind,
} from "@/pages/myspace/canvas/model";
import type { Order } from "@/pages/myspace/canvas/board";
import type { Key } from "@/pages/myspace/canvas/strings";

type Patch = Partial<Obj>;

export interface InspectorActions {
  patch: (p: Patch, key?: string) => void;
  patchGeom: (p: Patch) => void;
  align: (k: AlignKind) => void;
  distribute: (axis: "x" | "y") => void;
  group: () => void;
  ungroup: () => void;
  order: (o: Order) => void;
  lock: () => void;
  hide: () => void;
  duplicate: () => void;
  remove: () => void;
}

interface Props {
  sel: Obj[];
  a: InspectorActions;
  t: (k: Key) => string;
  ru: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hc-row">
      <div className="hc-row-label">{label}</div>
      <div className="hc-row-body">{children}</div>
    </div>
  );
}

function Colors({
  value,
  list,
  onPick,
  none,
  custom,
}: {
  value?: string;
  list: string[];
  onPick: (c: string) => void;
  none?: boolean;
  custom: string;
}) {
  return (
    <div className="hc-swatches">
      {none && (
        <button
          type="button"
          className={`hc-sw none${!value || value === "none" ? " on" : ""}`}
          title="—"
          onClick={() => onPick("none")}
        />
      )}
      {list.map((c) => (
        <button
          key={c}
          type="button"
          className={`hc-sw${value?.toLowerCase() === c ? " on" : ""}`}
          style={{ background: c }}
          title={c}
          onClick={() => onPick(c)}
        />
      ))}
      <label className="hc-sw custom" title={custom}>
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value ?? "") ? value : "#8b7bf0"}
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
    </div>
  );
}

function Num({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  title,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  title?: string;
}) {
  return (
    <label className="hc-num" title={title}>
      {suffix && <span>{suffix}</span>}
      <input
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min ?? -1e6, Math.min(max ?? 1e6, n)));
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </label>
  );
}

const HEADS: Head[] = ["none", "arrow", "triangle", "dot"];

/** Правая панель: свойства выбранного. Показывает только то, что относится к выбору. */
export function Inspector({ sel, a, t, ru }: Props) {
  if (sel.length === 0) return null;
  const o = sel[0];
  const one = sel.length === 1;
  const types = new Set(sel.map((s) => s.type));
  const has = (...k: Obj["type"][]) => sel.some((s) => k.includes(s.type));
  const L = (r: string, e: string): string => (ru ? r : e);
  const canFill = has("shape", "sticky", "frame", "task", "text", "note");
  const canStroke = has("shape", "frame", "line", "stroke", "task", "note", "image");
  const canText = has("shape", "sticky", "text", "task");
  const canRadius = has("shape", "sticky", "frame", "image", "task", "note");
  const canShadow = has("shape", "sticky", "frame", "task", "note", "image");
  const richText = has("shape", "sticky", "text", "task");
  const swDefault = o.type === "image" ? 0 : o.type === "task" || o.type === "note" ? 1 : 2;
  const softShadow = has("task", "note") && !has("shape", "sticky", "frame", "image");
  const onlyLines = types.size === 1 && types.has("line");
  const multi = sel.length > 1;
  const locked = sel.every((s) => s.locked);
  const hidden = sel.every((s) => s.hidden);

  return (
    <div className="hc-insp hc-float" data-ui onKeyDown={(e) => e.stopPropagation()}>
      <div className="hc-acts">
        <button
          type="button"
          className="hc-ib"
          title={`${t("duplicate")} (Ctrl+D)`}
          onClick={a.duplicate}
        >
          <Copy size={15} />
        </button>
        <button
          type="button"
          className={`hc-ib${locked ? " on" : ""}`}
          title={locked ? t("unlock") : t("lock")}
          onClick={a.lock}
        >
          {locked ? <Lock size={15} /> : <Unlock size={15} />}
        </button>
        <button
          type="button"
          className={`hc-ib${hidden ? " on" : ""}`}
          title={hidden ? t("show") : t("hide")}
          onClick={a.hide}
        >
          {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        {multi && (
          <button
            type="button"
            className="hc-ib"
            title={`${t("group")} (Ctrl+G)`}
            onClick={a.group}
          >
            <Group size={15} />
          </button>
        )}
        {types.has("group") && (
          <button
            type="button"
            className="hc-ib"
            title={`${t("ungroup")} (Ctrl+Shift+G)`}
            onClick={a.ungroup}
          >
            <Ungroup size={15} />
          </button>
        )}
        <button type="button" className="hc-ib" title={t("front")} onClick={() => a.order("front")}>
          <ArrowUpToLine size={15} />
        </button>
        <button type="button" className="hc-ib" title={t("back")} onClick={() => a.order("back")}>
          <ArrowDownToLine size={15} />
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="hc-ib danger"
          title={`${t("del")} (Del)`}
          onClick={a.remove}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {multi && (
        <Row label={t("align")}>
          <div className="hc-icons">
            {(
              [
                ["left", AlignStartVertical, "align_left"],
                ["hcenter", AlignCenterVertical, "align_hcenter"],
                ["right", AlignEndVertical, "align_right"],
                ["top", AlignStartHorizontal, "align_top"],
                ["vcenter", AlignCenterHorizontal, "align_vcenter"],
                ["bottom", AlignEndHorizontal, "align_bottom"],
              ] as const
            ).map(([k, Icon, label]) => (
              <button
                key={k}
                type="button"
                className="hc-ib"
                title={t(label)}
                onClick={() => a.align(k)}
              >
                <Icon size={15} />
              </button>
            ))}
            <button
              type="button"
              className="hc-ib"
              title={`${t("distribute")}: ${t("distH")}`}
              onClick={() => a.distribute("x")}
            >
              <AlignHorizontalSpaceBetween size={15} />
            </button>
            <button
              type="button"
              className="hc-ib"
              title={`${t("distribute")}: ${t("distV")}`}
              onClick={() => a.distribute("y")}
            >
              <AlignVerticalSpaceBetween size={15} />
            </button>
          </div>
        </Row>
      )}

      {one && o.type !== "line" && o.type !== "group" && (
        <Row label={t("position")}>
          <div className="hc-grid4">
            <Num suffix="X" value={o.x} onChange={(x) => a.patchGeom({ x })} />
            <Num suffix="Y" value={o.y} onChange={(y) => a.patchGeom({ y })} />
            <Num suffix="W" value={o.w} min={8} onChange={(w) => a.patchGeom({ w })} />
            <Num suffix="H" value={o.h} min={8} onChange={(h) => a.patchGeom({ h, auto: false })} />
            <Num
              suffix="°"
              title={t("rotation")}
              value={o.rot}
              min={0}
              max={360}
              onChange={(rot) => a.patchGeom({ rot })}
            />
          </div>
        </Row>
      )}

      {one && o.type !== "group" && (
        <Row label={L("Название", "Name")}>
          <input
            className="hc-text"
            value={o.name ?? ""}
            placeholder={L("Название слоя", "Layer name")}
            onChange={(e) => a.patch({ name: e.target.value || undefined }, "name")}
            onKeyDown={(e) => e.stopPropagation()}
            style={{ width: "100%" }}
          />
        </Row>
      )}

      {one && o.type === "frame" && (
        <label className="hc-check">
          <input
            type="checkbox"
            checked={!o.noName}
            onChange={(e) => a.patch({ noName: !e.target.checked })}
          />
          {L("Показывать заголовок рамки", "Show frame title")}
        </label>
      )}

      {one && o.type === "text" && (
        <label className="hc-check">
          <input
            type="checkbox"
            checked={!!o.auto}
            onChange={(e) => a.patch({ auto: e.target.checked })}
          />
          {L("Высота по тексту", "Auto height")}
        </label>
      )}

      {one && o.type === "sticker" && (
        <Row label={L("Эмодзи", "Emoji")}>
          <div className="hc-icons" style={{ flexWrap: "wrap" }}>
            {[
              "👍",
              "👎",
              "❤️",
              "⭐",
              "🔥",
              "✅",
              "❌",
              "❓",
              "❗",
              "💡",
              "🎯",
              "🚀",
              "😀",
              "😮",
              "🎉",
              "📌",
            ].map((em) => (
              <button
                key={em}
                type="button"
                className={`hc-ib${o.emoji === em ? " on" : ""}`}
                onClick={() => a.patch({ emoji: em })}
              >
                {em}
              </button>
            ))}
          </div>
        </Row>
      )}

      {one && o.type === "task" && (
        <>
          <Row label={L("Статус", "Status")}>
            <div className="hc-icons">
              {(
                [
                  ["todo", L("К выполнению", "To do")],
                  ["inprogress", L("В работе", "In progress")],
                  ["done", L("Готово", "Done")],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={`hc-ib wide${(o.status ?? "todo") === k ? " on" : ""}`}
                  onClick={() => a.patch({ status: k })}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row label={L("Приоритет", "Priority")}>
            <div className="hc-icons">
              {(
                [
                  [undefined, L("Нет", "None")],
                  ["low", L("Низкий", "Low")],
                  ["medium", L("Средний", "Medium")],
                  ["high", L("Высокий", "High")],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={label}
                  type="button"
                  className={`hc-ib wide${o.prio === k ? " on" : ""}`}
                  onClick={() => a.patch({ prio: k })}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row label={L("Срок", "Due date")}>
            <input
              type="date"
              className="hc-text"
              value={o.due ?? ""}
              onChange={(e) => a.patch({ due: e.target.value || undefined })}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </Row>
          <Row label={L("Цвет полоски", "Accent colour")}>
            <Colors
              value={o.acc}
              list={["#94a3b8", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6", "#ef4444", "#ec4899"]}
              custom={t("custom")}
              onPick={(c) => a.patch({ acc: c }, "acc")}
            />
          </Row>
          <label className="hc-check">
            <input
              type="checkbox"
              checked={!!o.prog}
              onChange={(e) => a.patch({ prog: e.target.checked })}
            />
            {L("Показывать выполнено/всего", "Show done/total")}
          </label>
          <Row label={L("Подзадачи", "Subtasks")}>
            <div style={{ display: "grid", gap: 6, width: "100%" }}>
              {(o.subtasks ?? []).map((sub, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={sub.done}
                    onChange={() =>
                      a.patch({
                        subtasks: (o.subtasks ?? []).map((x, j) =>
                          j === i ? { ...x, done: !x.done } : x,
                        ),
                      })
                    }
                  />
                  <input
                    className="hc-text"
                    style={{ flex: 1, minWidth: 0 }}
                    value={sub.text}
                    onChange={(e) =>
                      a.patch(
                        {
                          subtasks: (o.subtasks ?? []).map((x, j) =>
                            j === i ? { ...x, text: e.target.value } : x,
                          ),
                        },
                        "sub",
                      )
                    }
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <button
                    type="button"
                    className="hc-ib danger"
                    title={t("del")}
                    onClick={() =>
                      a.patch({ subtasks: (o.subtasks ?? []).filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="hc-ib wide"
                onClick={() =>
                  a.patch({
                    subtasks: [...(o.subtasks ?? []), { text: L("Шаг", "Step"), done: false }],
                  })
                }
              >
                + {L("Добавить подзадачу", "Add subtask")}
              </button>
            </div>
          </Row>
        </>
      )}

      {one && o.type === "image" && (
        <>
          <Row label={L("Вписывание", "Fit")}>
            <div className="hc-icons">
              {(
                [
                  ["fill", L("Растянуть", "Stretch")],
                  ["contain", L("Целиком", "Contain")],
                  ["cover", L("Заполнить", "Cover")],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={`hc-ib wide${(o.fit ?? "fill") === k ? " on" : ""}`}
                  onClick={() => a.patch({ fit: k })}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row label={L("Отражение", "Flip")}>
            <div className="hc-icons">
              <button
                type="button"
                className={`hc-ib wide${o.flipX ? " on" : ""}`}
                onClick={() => a.patch({ flipX: !o.flipX })}
              >
                {L("По горизонтали", "Horizontal")}
              </button>
              <button
                type="button"
                className={`hc-ib wide${o.flipY ? " on" : ""}`}
                onClick={() => a.patch({ flipY: !o.flipY })}
              >
                {L("По вертикали", "Vertical")}
              </button>
            </div>
          </Row>
          {(
            [
              ["bri", L("Яркость", "Brightness"), 0.2, 2, 0.05, 1],
              ["con", L("Контраст", "Contrast"), 0.2, 2, 0.05, 1],
              ["sat", L("Насыщенность", "Saturation"), 0, 2, 0.05, 1],
              ["blr", L("Размытие", "Blur"), 0, 20, 1, 0],
            ] as const
          ).map(([k, label, min, max, step, def]) => (
            <Row key={k} label={label}>
              <div className="hc-line">
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={o[k] ?? def}
                  onChange={(e) => a.patch({ [k]: Number(e.target.value) }, k)}
                />
                <span>{o[k] ?? def}</span>
              </div>
            </Row>
          ))}
          <label className="hc-check">
            <input
              type="checkbox"
              checked={!!o.gray}
              onChange={(e) => a.patch({ gray: e.target.checked })}
            />
            {L("Чёрно-белое", "Grayscale")}
          </label>
          <button
            type="button"
            className="hc-ib wide"
            onClick={() =>
              a.patch({
                bri: undefined,
                con: undefined,
                sat: undefined,
                blr: undefined,
                gray: undefined,
                flipX: undefined,
                flipY: undefined,
                fit: undefined,
              })
            }
          >
            {L("Сбросить обработку", "Reset adjustments")}
          </button>
        </>
      )}

      {one && o.type === "shape" && (
        <Row label={t("shape")}>
          <div className="hc-icons">
            {SHAPES.map((s) => (
              <button
                key={s.kind}
                type="button"
                className={`hc-ib${o.shape === s.kind ? " on" : ""}`}
                title={ru ? s.ru : s.en}
                onClick={() => a.patch({ shape: s.kind as ShapeKind })}
              >
                <ShapeGlyph kind={s.kind} />
              </button>
            ))}
          </div>
        </Row>
      )}

      {canFill && (
        <Row label={t("fill")}>
          <Colors
            value={o.fill}
            list={SWATCHES}
            none={has("shape", "frame", "text")}
            custom={t("custom")}
            onPick={(c) => a.patch({ fill: c }, "fill")}
          />
        </Row>
      )}

      {canStroke && (
        <>
          <Row label={t("stroke")}>
            <Colors
              value={o.stroke}
              list={[...INK, "#94a3b8", "#1f2937"]}
              none={has("shape", "frame")}
              custom={t("custom")}
              onPick={(c) => a.patch({ stroke: c }, "stroke")}
            />
          </Row>
          <Row label={t("width")}>
            <div className="hc-line">
              <input
                type="range"
                min={0}
                max={16}
                step={1}
                value={o.sw ?? swDefault}
                onChange={(e) => a.patch({ sw: Number(e.target.value) }, "sw")}
              />
              <span>{o.sw ?? swDefault}</span>
            </div>
          </Row>
          {has("shape", "frame", "line") && (
            <Row label={t("dash")}>
              <div className="hc-icons">
                {(["solid", "dashed", "dotted"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`hc-ib wide${(o.dash ?? "solid") === d ? " on" : ""}`}
                    onClick={() => a.patch({ dash: d })}
                  >
                    <svg width={30} height={6} viewBox="0 0 30 6">
                      <line
                        x1={1}
                        y1={3}
                        x2={29}
                        y2={3}
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeDasharray={d === "solid" ? undefined : d === "dashed" ? "6 4" : "1 5"}
                      />
                    </svg>
                  </button>
                ))}
              </div>
            </Row>
          )}
        </>
      )}

      {onlyLines && (
        <>
          <Row label={t("lineStyle")}>
            <div className="hc-icons">
              {(["straight", "curve", "step"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`hc-ib wide${(o.ls ?? "curve") === s ? " on" : ""}`}
                  title={t(s)}
                  onClick={() => a.patch({ ls: s })}
                >
                  {t(s)}
                </button>
              ))}
            </div>
          </Row>
          <Row label={t("startHead")}>
            <div className="hc-icons">
              {HEADS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`hc-ib wide${(o.h1 ?? "none") === h ? " on" : ""}`}
                  onClick={() => a.patch({ h1: h })}
                >
                  {t(h)}
                </button>
              ))}
            </div>
          </Row>
          <Row label={t("endHead")}>
            <div className="hc-icons">
              {HEADS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`hc-ib wide${(o.h2 ?? "arrow") === h ? " on" : ""}`}
                  onClick={() => a.patch({ h2: h })}
                >
                  {t(h)}
                </button>
              ))}
            </div>
          </Row>
          <label className="hc-check">
            <input
              type="checkbox"
              checked={!!o.animated}
              onChange={(e) => a.patch({ animated: e.target.checked })}
            />
            {t("animated")}
          </label>
        </>
      )}

      {canText && (
        <>
          <Row label={t("fontSize")}>
            <div className="hc-icons">
              <Num value={o.fs ?? 16} min={8} max={200} onChange={(fs) => a.patch({ fs }, "fs")} />
              <button
                type="button"
                className={`hc-ib${(o.fw ?? 500) >= 700 ? " on" : ""}`}
                title={t("bold")}
                onClick={() => a.patch({ fw: (o.fw ?? 500) >= 700 ? 500 : 700 })}
              >
                <Bold size={15} />
              </button>
              <button
                type="button"
                className={`hc-ib${o.italic ? " on" : ""}`}
                title={t("italic")}
                onClick={() => a.patch({ italic: !o.italic })}
              >
                <Italic size={15} />
              </button>
              {(
                [
                  ["left", AlignLeft, "alignL"],
                  ["center", AlignCenter, "alignC"],
                  ["right", AlignRight, "alignR"],
                ] as const
              ).map(([k, Icon, label]) => (
                <button
                  key={k}
                  type="button"
                  className={`hc-ib${(o.ta ?? "left") === k ? " on" : ""}`}
                  title={t(label)}
                  onClick={() => a.patch({ ta: k })}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </Row>
          <Row label={t("font")}>
            <div className="hc-icons">
              {(["sans", "serif", "mono", "hand"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`hc-ib wide${(o.ff ?? "sans") === f ? " on" : ""}`}
                  onClick={() => a.patch({ ff: f })}
                >
                  {t(f === "hand" ? "hand_" : f)}
                </button>
              ))}
            </div>
          </Row>
          {has("shape", "sticky") && (
            <Row label={t("middle")}>
              <div className="hc-icons">
                {(["top", "middle", "bottom"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`hc-ib wide${(o.va ?? "middle") === v ? " on" : ""}`}
                    onClick={() => a.patch({ va: v })}
                  >
                    {t(v)}
                  </button>
                ))}
              </div>
            </Row>
          )}
          {richText && (
            <>
              <Row label={L("Начертание", "Style")}>
                <div className="hc-icons">
                  {(
                    [
                      ["ul", L("Подчёрк.", "Underline")],
                      ["st", L("Зачёрк.", "Strike")],
                      ["caps", "AA"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      className={`hc-ib wide${o[k] ? " on" : ""}`}
                      onClick={() => a.patch({ [k]: !o[k] })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label={L("Интервалы", "Spacing")}>
                <div className="hc-icons">
                  <Num
                    suffix="↕"
                    title={L("Межстрочный интервал", "Line height")}
                    value={o.lh ?? 1.3}
                    min={0.8}
                    max={3}
                    step={0.1}
                    onChange={(lh) => a.patch({ lh }, "lh")}
                  />
                  <Num
                    suffix="↔"
                    title={L("Межбуквенный интервал, px", "Letter spacing, px")}
                    value={o.sp ?? 0}
                    min={-2}
                    max={20}
                    step={0.5}
                    onChange={(sp) => a.patch({ sp }, "sp")}
                  />
                </div>
              </Row>
            </>
          )}
          <Row label={t("textColor")}>
            <Colors
              value={o.tc}
              list={INK}
              custom={t("custom")}
              onPick={(c) => a.patch({ tc: c }, "tc")}
            />
          </Row>
        </>
      )}

      {has("note") && !canText && (
        <Row label={t("textColor")}>
          <Colors
            value={o.tc}
            list={INK}
            custom={t("custom")}
            onPick={(c) => a.patch({ tc: c }, "tc")}
          />
        </Row>
      )}

      {canRadius && (
        <Row label={t("radius")}>
          <div className="hc-line">
            <input
              type="range"
              min={0}
              max={80}
              value={o.radius ?? 0}
              onChange={(e) => a.patch({ radius: Number(e.target.value) }, "radius")}
            />
            <span>{o.radius ?? 0}</span>
          </div>
        </Row>
      )}

      <Row label={t("opacity")}>
        <div className="hc-line">
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={o.opacity ?? 1}
            onChange={(e) => a.patch({ opacity: Number(e.target.value) }, "opacity")}
          />
          <span>{Math.round((o.opacity ?? 1) * 100)}%</span>
        </div>
      </Row>
      {canShadow && (
        <label className="hc-check">
          <input
            type="checkbox"
            checked={softShadow ? o.shadow !== false : !!o.shadow}
            onChange={(e) => a.patch({ shadow: e.target.checked })}
          />
          {t("shadow")}
        </label>
      )}
    </div>
  );
}

function ShapeGlyph({ kind }: { kind: ShapeKind }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "rect":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <rect x={2} y={3} width={12} height={10} {...common} />
        </svg>
      );
    case "rounded":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <rect x={2} y={3} width={12} height={10} rx={3} {...common} />
        </svg>
      );
    case "ellipse":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <ellipse cx={8} cy={8} rx={6} ry={5} {...common} />
        </svg>
      );
    case "diamond":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path d="M8 2L14 8L8 14L2 8Z" {...common} />
        </svg>
      );
    case "triangle":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path d="M8 2L14 13H2Z" {...common} />
        </svg>
      );
    case "hexagon":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path d="M5 3H11L14 8L11 13H5L2 8Z" {...common} />
        </svg>
      );
    case "parallelogram":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path d="M5 3H14L11 13H2Z" {...common} />
        </svg>
      );
    case "cylinder":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path d="M3 4C3 2 13 2 13 4V12C13 14 3 14 3 12ZM3 4C3 6 13 6 13 4" {...common} />
        </svg>
      );
    case "star":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path
            d="M8 2L9.8 6.2L14 6.5L10.8 9.3L11.8 13.5L8 11.2L4.2 13.5L5.2 9.3L2 6.5L6.2 6.2Z"
            {...common}
          />
        </svg>
      );
    case "cloud":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path
            d="M4.5 12.5C2 12.5 2 8.8 4.4 8.6C4.2 5.5 8 4.3 9.2 7C11.5 6 13.6 8.2 12.4 10.2C13.6 11.5 12.6 12.5 11.5 12.5Z"
            {...common}
          />
        </svg>
      );
    case "arrow":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path d="M2 6H9V3L14 8L9 13V10H2Z" {...common} />
        </svg>
      );
    case "chat":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16">
          <path d="M3 3H13Q14 3 14 4V10Q14 11 13 11H7L4 14V11H3Q2 11 2 10V4Q2 3 3 3Z" {...common} />
        </svg>
      );
  }
}
