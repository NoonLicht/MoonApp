/**
 * Выделено из SettingsPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import React from "react";
import { Glass } from "@/components/ui";

/**
 * Точечное чтение вложенного значения по пути "a.b.c".
 * Используется, чтобы патчить настройки (PATCH /settings) узкой веткой.
 */
export function getAt(obj: any, path: string): any {
  return path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
}

/**
 * Иммутабельно пишет значение по пути "a.b.c" и возвращает копию объекта.
 * Так компонент остаётся чистым: старое состояние не мутируется.
 */
export function setAt(obj: any, path: string, value: unknown): any {
  const keys = path.split(".");
  const clone = JSON.parse(JSON.stringify(obj));
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

/* ---------- Мелкие UI-элементы ---------- */

/**
 * Применить импортированные настройки, которые приложение меняет НА ЛЕТУ.
 * Список путей — ровно тот, что слушает App.tsx (событие app:setting) плюс тема
 * отдельным событием app:theme; всё остальное (автозапуск, размер окна,
 * аппаратное ускорение) читается только при старте — UI честно об этом пишет.
 */
export function applyLiveSettings(settings: unknown) {
  const s = settings as any;
  if (!s || typeof s !== "object") return;
  window.dispatchEvent(
    new CustomEvent("app:theme", { detail: String(s.appearance?.theme || "dark") }),
  );
  const paths = [
    "general.language",
    "performance.backgroundBlur",
    "performance.keepPagesAlive",
    "performance.keepPagesLimit",
    "performance.unloadIdleMinutes",
    "appearance.accent",
    "appearance.reduceMotion",
    "appearance.density",
    "appearance.opaqueBackground",
  ];
  for (const path of paths) {
    const value = path.split(".").reduce<any>((a, k) => (a == null ? a : a[k]), s);
    if (value === undefined) continue;
    window.dispatchEvent(new CustomEvent("app:setting", { detail: { path, value } }));
  }
}

export function Row({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-info">
        <div className="set-label">{label}</div>
        {hint && <div className="muted-sm">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export function BoolRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        className={`switch ${value ? "is-on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={!!value}
      >
        <span className="switch-knob" />
      </button>
    </Row>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  value: number | string;
  onChange: (v: number | "") => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="num-ctrl">
      <input
        type="number"
        className="num-input"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      />
      {suffix && <span className="muted-sm">{suffix}</span>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="text-input"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* ---------- Блок секции ---------- */
export function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <Glass className="set-section">
      <div className="set-section-head">
        <span className="set-section-icon tone-violet">
          <Icon size={16} strokeWidth={2} />
        </span>
        <span className="set-section-title">{title}</span>
      </div>
      <div className="set-section-body">{children}</div>
    </Glass>
  );
}
