import React, { useState, useRef, useEffect } from "react";
import { Info } from "lucide-react";

/**
 * Параметр с интерактивным тултипом (i) и аппаратно-адаптивным бейджем
 * «[Optimal for Your PC]». Используется в Pro-панели аудиокнижной студии.
 *
 *  - tooltip: строка «что влияет / слишком высоко / слишком низко».
 *  - optimal: непустое значение → зелёный бейдж рядом с лейблом.
 */

export interface ParamFieldProps {
  label: string;
  tooltip: string;
  optimal?: string;
  children: React.ReactNode;
}

export function ParamField({ label, tooltip, optimal, children }: ParamFieldProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Закрытие по клику вне поповера
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="ab-param" ref={wrapRef}>
      <div className="ab-param-head">
        <span className="field-label" style={{ marginBottom: 0 }}>
          {label}
        </span>
        <button
          type="button"
          className="ab-info-btn"
          title={label}
          onClick={() => setOpen((v) => !v)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <Info size={13} strokeWidth={2} />
        </button>
        {optimal && (
          <span className="ab-optimal-badge" title={`Optimal for Your PC — ${optimal}`}>
            ✓ {optimal}
          </span>
        )}
      </div>
      {children}
      {open && (
        <div className="ab-tooltip" role="tooltip">
          {tooltip}
        </div>
      )}
    </div>
  );
}
