import React from "react";
import { Check } from "lucide-react";

type DivProps = React.HTMLAttributes<HTMLElement>;

export function Glass({
  as: Tag = "div",
  className = "",
  style,
  children,
  ...rest
}: {
  as?: React.ElementType;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
} & DivProps) {
  return (
    <Tag className={`glass ${className}`} style={style} {...rest}>
      {children}
    </Tag>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | string;
  icon?: React.ElementType;
};

export function Btn({ variant = "ghost", icon: Icon, children, style, ...rest }: BtnProps) {
  return (
    <button className={`btn btn-${variant}`} style={style} {...rest}>
      {Icon && <Icon size={15} strokeWidth={2.1} />}
      {children && <span>{children}</span>}
    </button>
  );
}

type IconBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: React.ElementType;
  active?: boolean;
  size?: number;
};

export function IconBtn({ icon: Icon, active, size = 17, ...rest }: IconBtnProps) {
  return (
    <button className={`icon-btn ${active ? "is-active" : ""}`} {...rest}>
      <Icon size={size} strokeWidth={2} />
    </button>
  );
}

export function Field({
  label,
  children,
  w,
}: {
  label?: string;
  w?: number;
  children: React.ReactNode;
}) {
  return (
    <label className="field" style={w ? { width: w } : undefined}>
      {label && <span className="field-label">{label}</span>}
      {children}
    </label>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  onChange,
  options,
  style,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: (string | SelectOption)[];
  style?: React.CSSProperties;
}) {
  const list: SelectOption[] = (options || []).map((o) =>
    typeof o === "object" && o != null ? o : { value: o, label: o },
  );
  return (
    <div className="select-wrap" style={style}>
      <select value={value} onChange={onChange}>
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  active,
  onClick,
  mono,
}: {
  children: React.ReactNode;
  tone?: string;
  active?: boolean;
  onClick?: () => void;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`badge tone-${tone} ${active ? "is-active" : ""} ${onClick ? "is-clickable" : ""}`}
      style={mono ? { fontFamily: "var(--font-mono)" } : undefined}
    >
      {children}
    </button>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${value}%` }} />
    </div>
  );
}

/**
 * Заголовок страницы: `eyebrow` — надзаголовок, `title` — название,
 * `action` — необязательный блок справа (статусы, кнопки).
 */
export function SectionHead({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
      </div>
      {action}
    </div>
  );
}

export function EmptyHint({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="empty-hint">
      <Icon size={20} strokeWidth={1.6} />
      <span>{text}</span>
    </div>
  );
}

export function Checkbox({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button className={`checkbox ${checked ? "is-checked" : ""}`} onClick={onClick}>
      {checked && <Check size={12} strokeWidth={3} />}
    </button>
  );
}
