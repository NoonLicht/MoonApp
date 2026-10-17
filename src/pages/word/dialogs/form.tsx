import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { getOverlayRoot } from "@/components/overlayHost";
import { Btn } from "@/components/ui";
import type { Cx, Params } from "@/pages/word/ribbon/types";

export type Vals = Record<string, string | number | boolean>;

export type Field =
  | {
      k: "text";
      key: string;
      label?: string;
      placeholder?: string;
      tab?: number;
      show?: (v: Vals) => boolean;
      full?: boolean;
      autoFocus?: boolean;
    }
  | {
      k: "area";
      key: string;
      label?: string;
      placeholder?: string;
      tab?: number;
      show?: (v: Vals) => boolean;
      rows?: number;
    }
  | {
      k: "num";
      key: string;
      label?: string;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      tab?: number;
      show?: (v: Vals) => boolean;
    }
  | {
      k: "select";
      key: string;
      label?: string;
      options: [string, string][];
      raw?: boolean;
      tab?: number;
      show?: (v: Vals) => boolean;
    }
  | { k: "check"; key: string; label: string; tab?: number; show?: (v: Vals) => boolean }
  | {
      k: "color";
      key: string;
      label?: string;
      tab?: number;
      show?: (v: Vals) => boolean;
      allowNone?: boolean;
      noneLabel?: string;
    }
  | {
      k: "radio";
      key: string;
      label?: string;
      options: [string, string][];
      raw?: boolean;
      tab?: number;
      show?: (v: Vals) => boolean;
    }
  | { k: "note"; text: string; tab?: number; show?: (v: Vals) => boolean; raw?: boolean }
  | { k: "pre"; render: (v: Vals, cx: Cx) => ReactNode; tab?: number; show?: (v: Vals) => boolean }
  | { k: "sep"; tab?: number };

export interface FormSpec {
  /** Английское название (ключ перевода). */
  title: string;
  tabs?: string[];
  fields: Field[];
  init?: (cx: Cx, props: Params) => Vals;
  submit: (v: Vals, cx: Cx, props: Params) => void | Promise<void>;
  ok?: string;
  size?: "normal" | "wide" | "xwide";
  /** Без кнопки OK (диалог-справка). */
  noOk?: boolean;
}

/** Оболочка диалога: затемнение, заголовок, закрытие по Escape и клику на фон. */
export function Shell({
  title,
  onClose,
  size = "normal",
  children,
  foot,
  tabs,
  tab,
  setTab,
  wide,
}: {
  title: string;
  onClose: () => void;
  size?: "normal" | "wide" | "xwide";
  children: ReactNode;
  foot?: ReactNode;
  tabs?: string[];
  tab?: number;
  setTab?: (i: number) => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(
      "[data-autofocus], input:not([type=checkbox]):not([type=radio]), select, textarea",
    );
    el?.focus();
  }, []);
  const cls = size === "xwide" ? "xwide" : size === "wide" || wide ? "wide" : "";
  return createPortal(
    <div
      className="wd-dlg-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`wd-dlg ${cls}`} role="dialog" aria-label={title} ref={ref}>
        <div className="wd-dlg-head">
          <span style={{ flex: 1 }}>{title}</span>
          <button type="button" className="wd-x-btn" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {tabs && tabs.length > 1 ? (
          <div className="wd-dlg-tabs">
            {tabs.map((t, i) => (
              <button
                key={t}
                type="button"
                className={i === tab ? "on" : ""}
                onClick={() => setTab?.(i)}
              >
                {t}
              </button>
            ))}
          </div>
        ) : null}
        <div className="wd-dlg-body">{children}</div>
        {foot ? <div className="wd-dlg-foot">{foot}</div> : null}
      </div>
    </div>,
    getOverlayRoot() ?? document.body,
  );
}

function FieldView({
  f,
  v,
  set,
  cx,
}: {
  f: Field;
  v: Vals;
  set: (k: string, x: string | number | boolean) => void;
  cx: Cx;
}) {
  const lbl = (text?: string) => (text ? <span className="lbl">{cx.tw(text)}</span> : <span />);
  switch (f.k) {
    case "text":
      return (
        <>
          {f.full ? null : lbl(f.label)}
          <input
            type="text"
            className={f.full ? "full" : undefined}
            value={String(v[f.key] ?? "")}
            placeholder={f.placeholder ? cx.tw(f.placeholder) : undefined}
            data-autofocus={f.autoFocus ? "" : undefined}
            onChange={(e) => set(f.key, e.target.value)}
          />
        </>
      );
    case "area":
      return (
        <>
          {lbl(f.label)}
          <textarea
            rows={f.rows ?? 4}
            value={String(v[f.key] ?? "")}
            placeholder={f.placeholder ? cx.tw(f.placeholder) : undefined}
            onChange={(e) => set(f.key, e.target.value)}
          />
        </>
      );
    case "num":
      return (
        <>
          {lbl(f.label)}
          <span className="wd-inline">
            <input
              type="number"
              value={String(v[f.key] ?? "")}
              min={f.min}
              max={f.max}
              step={f.step ?? 1}
              onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))}
            />
            {f.unit ? <span className="wd-muted">{cx.tw(f.unit)}</span> : null}
          </span>
        </>
      );
    case "select":
      return (
        <>
          {lbl(f.label)}
          <select value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
            {f.options.map(([val, label]) => (
              <option key={val} value={val}>
                {f.raw ? label : cx.tw(label)}
              </option>
            ))}
          </select>
        </>
      );
    case "check":
      return (
        <label className="wd-chk full">
          <input
            type="checkbox"
            checked={!!v[f.key]}
            onChange={(e) => set(f.key, e.target.checked)}
          />
          <span>{cx.tw(f.label)}</span>
        </label>
      );
    case "color":
      return (
        <>
          {lbl(f.label)}
          <span className="wd-inline">
            <input
              type="color"
              value={`#${String(v[f.key] || "000000").padStart(6, "0")}`}
              onChange={(e) => set(f.key, e.target.value.slice(1).toUpperCase())}
            />
            {f.allowNone ? (
              <label className="wd-chk">
                <input
                  type="checkbox"
                  checked={!v[f.key]}
                  onChange={(e) => set(f.key, e.target.checked ? "" : "000000")}
                />
                <span>{cx.tw(f.noneLabel ?? "No Color")}</span>
              </label>
            ) : null}
          </span>
        </>
      );
    case "radio":
      return (
        <>
          {lbl(f.label)}
          <span className="wd-radios">
            {f.options.map(([val, label]) => (
              <label key={val}>
                <input
                  type="radio"
                  name={f.key}
                  checked={String(v[f.key]) === val}
                  onChange={() => set(f.key, val)}
                />
                <span>{f.raw ? label : cx.tw(label)}</span>
              </label>
            ))}
          </span>
        </>
      );
    case "note":
      return <div className="full wd-muted">{f.raw ? f.text : cx.tw(f.text)}</div>;
    case "pre":
      return <div className="full">{f.render(v, cx)}</div>;
    case "sep":
      return (
        <hr
          className="full"
          style={{ width: "100%", border: 0, borderTop: "1px solid var(--glass-border)" }}
        />
      );
  }
}

/** Диалог, описанный данными: поля, вкладки, предпросмотр; OK выполняет `submit`. */
export default function FormDialog({
  spec,
  cx,
  props,
  onClose,
}: {
  spec: FormSpec;
  cx: Cx;
  props: Params;
  onClose: () => void;
}) {
  const [v, setV] = useState<Vals>(() => spec.init?.(cx, props) ?? {});
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: string | number | boolean): void => setV((o) => ({ ...o, [k]: x }));
  const ok = async (): Promise<void> => {
    setBusy(true);
    try {
      await spec.submit(v, cx, props);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const fields = spec.fields.filter(
    (f) => (f.tab ?? 0) === tab && (!("show" in f) || !f.show || f.show(v)),
  );
  return (
    <Shell
      title={cx.tw(spec.title)}
      onClose={onClose}
      size={spec.size}
      tabs={spec.tabs?.map((t) => cx.tw(t))}
      tab={tab}
      setTab={setTab}
      foot={
        <>
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          {spec.noOk ? null : (
            <Btn variant="primary" disabled={busy} onClick={() => void ok()}>
              {cx.tw(spec.ok ?? "OK")}
            </Btn>
          )}
        </>
      }
    >
      <div
        className="wd-form"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !spec.noOk) {
            e.preventDefault();
            void ok();
          }
        }}
      >
        {fields.map((f, i) => (
          <FieldView key={i} f={f} v={v} set={set} cx={cx} />
        ))}
      </div>
    </Shell>
  );
}
