import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import {
  LIQUID_LIMITS,
  LIQUID_PRESETS,
  applyLiquid,
  liquidKey,
  readLiquid,
  type LiquidGlassConfig,
} from "@/lib/designMode";
import { Row } from "@/pages/settings/parts/SettingsControls";

const FIELDS: { key: keyof LiquidGlassConfig; unit: string }[] = [
  { key: "blur", unit: "px" },
  { key: "saturate", unit: "%" },
  { key: "tint", unit: "%" },
  { key: "refraction", unit: "" },
  { key: "specular", unit: "%" },
  { key: "radius", unit: "px" },
  { key: "glow", unit: "%" },
];

/** Настройка «жидкого стекла»: пресеты и ползунки, применяются мгновенно. */
export function SettingsLiquidGlass({ appearance }: { appearance: Record<string, unknown> }) {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<LiquidGlassConfig>(() => readLiquid(appearance));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCfg(readLiquid(appearance));
  }, [appearance]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const commit = (next: LiquidGlassConfig) => {
    setCfg(next);
    applyLiquid(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const patch: Record<string, number> = {};
      for (const f of FIELDS) patch[liquidKey(f.key)] = next[f.key];
      void api.updateSettings({ appearance: patch }).catch(() => undefined);
    }, 350);
  };

  return (
    <>
      <Row label={t("settings.lgPreset")} hint={t("settings.lgPresetHint")}>
        <div className="lg-presets">
          {Object.keys(LIQUID_PRESETS).map((id) => (
            <button key={id} type="button" className="btn btn-secondary" onClick={() => commit(LIQUID_PRESETS[id])}>
              {t(`settings.lgPreset_${id}`)}
            </button>
          ))}
        </div>
      </Row>
      {FIELDS.map((f) => {
        // «Прозрачность элементов»: ползунок показывает 100 − плотность.
        const inv = f.key === "tint";
        const [lo, hi] = LIQUID_LIMITS[f.key];
        const shown = inv ? 100 - cfg[f.key] : cfg[f.key];
        return (
          <Row key={f.key} label={t(`settings.lg_${f.key}`)} hint={t(`settings.lg_${f.key}Hint`)}>
            <div className="lg-slider">
              <input
                type="range"
                min={inv ? 100 - hi : lo}
                max={inv ? 100 - lo : hi}
                value={shown}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  commit({ ...cfg, [f.key]: inv ? 100 - v : v });
                }}
              />
              <span className="lg-val">
                {shown}
                {f.unit}
              </span>
            </div>
          </Row>
        );
      })}
    </>
  );
}
