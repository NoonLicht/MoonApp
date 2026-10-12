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
      {FIELDS.map((f) => (
        <Row key={f.key} label={t(`settings.lg_${f.key}`)} hint={t(`settings.lg_${f.key}Hint`)}>
          <div className="lg-slider">
            <input
              type="range"
              min={LIQUID_LIMITS[f.key][0]}
              max={LIQUID_LIMITS[f.key][1]}
              value={cfg[f.key]}
              onChange={(e) => commit({ ...cfg, [f.key]: Number(e.target.value) })}
            />
            <span className="lg-val">
              {cfg[f.key]}
              {f.unit}
            </span>
          </div>
        </Row>
      ))}
    </>
  );
}
