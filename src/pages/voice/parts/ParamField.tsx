import React from "react";
import { HelpTip } from "@/components/HelpTip";
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
  return (
    <div className="ab-param">
      <div className="ab-param-head">
        <span className="field-label" style={{ marginBottom: 0 }}>
          {label}
        </span>
        <HelpTip text={tooltip} className="ab-info-btn">
          <Info size={13} strokeWidth={2} />
        </HelpTip>
        {optimal && (
          <span className="ab-optimal-badge" title={`Optimal for Your PC — ${optimal}`}>
            ✓ {optimal}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
