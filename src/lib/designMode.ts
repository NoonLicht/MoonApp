/**
 * Оформление интерфейса: дизайн Fluent 2 (единственный) и настраиваемый
 * «жидкий» эффект стекла (Liquid Glass).
 *
 * Всё — классы и CSS-переменные на <html>, поэтому работает и в порталах с модалками.
 * Стили лежат в styles/fluent.css и styles/liquidglass.css.
 */
export interface LiquidGlassConfig {
  blur: number; // размытие фона, px
  saturate: number; // насыщенность фона за стеклом, %
  tint: number; // подкраска поверхности, %
  refraction: number; // искажение (преломление) фона, 0 — нет
  specular: number; // блик по краю, %
  radius: number; // скругление стеклянных панелей, px
  glow: number; // яркость цветной подсветки фона за стеклом, %
}

export const LIQUID_DEFAULTS: LiquidGlassConfig = {
  blur: 22,
  saturate: 170,
  tint: 12,
  refraction: 14,
  specular: 55,
  radius: 14,
  glow: 60,
};

export const LIQUID_PRESETS: Record<string, LiquidGlassConfig> = {
  clear: { blur: 10, saturate: 150, tint: 6, refraction: 22, specular: 70, radius: 18, glow: 70 },
  balanced: { ...LIQUID_DEFAULTS },
  frosted: { blur: 40, saturate: 130, tint: 26, refraction: 4, specular: 35, radius: 12, glow: 45 },
  crystal: { blur: 6, saturate: 200, tint: 4, refraction: 34, specular: 90, radius: 22, glow: 85 },
};

export const LIQUID_LIMITS: Record<keyof LiquidGlassConfig, [number, number]> = {
  blur: [0, 60],
  saturate: [100, 250],
  tint: [0, 60],
  refraction: [0, 40],
  specular: [0, 100],
  radius: [4, 32],
  glow: [0, 100],
};

const KEYS = Object.keys(LIQUID_LIMITS) as (keyof LiquidGlassConfig)[];

/** Имя ключа в settings.appearance: blur → lgBlur. */
export const liquidKey = (k: keyof LiquidGlassConfig): string => `lg${k[0].toUpperCase()}${k.slice(1)}`;

export function readLiquid(ap: Record<string, unknown> | undefined): LiquidGlassConfig {
  const out = { ...LIQUID_DEFAULTS };
  for (const k of KEYS) {
    const raw = ap?.[liquidKey(k)];
    const v = Number(raw);
    if (raw != null && Number.isFinite(v)) {
      out[k] = Math.min(LIQUID_LIMITS[k][1], Math.max(LIQUID_LIMITS[k][0], v));
    }
  }
  return out;
}

export function applyDesign(): void {
  const el = document.documentElement;
  el.classList.add("design-fluent");
  el.classList.remove("design-classic");
}

export function applyGlass(v: unknown): void {
  document.documentElement.classList.toggle("no-glass", v === false);
}

const FILTER_ID = "lg-refract";

function ensureFilter(): Element | null {
  let svg = document.getElementById("lg-svg");
  if (!svg) {
    const host = document.createElement("div");
    host.innerHTML =
      `<svg id="lg-svg" width="0" height="0" style="position:absolute" aria-hidden="true">` +
      `<filter id="${FILTER_ID}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="7" result="n"/>` +
      `<feGaussianBlur in="n" stdDeviation="2" result="nb"/>` +
      `<feDisplacementMap id="lg-disp" in="SourceGraphic" in2="nb" scale="14" xChannelSelector="R" yChannelSelector="G"/>` +
      `</filter></svg>`;
    svg = host.firstElementChild as HTMLElement;
    document.body.appendChild(svg);
  }
  return svg.querySelector("#lg-disp");
}

/** Применяет настройки жидкого стекла: CSS-переменные + сила преломления. */
export function applyLiquid(cfg: LiquidGlassConfig): void {
  const root = document.documentElement;
  const st = root.style;
  st.setProperty("--lg-blur", `${cfg.blur}px`);
  st.setProperty("--lg-sat", `${cfg.saturate}%`);
  st.setProperty("--lg-tint", `${cfg.tint}%`);
  st.setProperty("--lg-spec", String(cfg.specular / 100));
  st.setProperty("--lg-radius", `${cfg.radius}px`);
  st.setProperty("--lg-glow", String(cfg.glow / 100));
  root.classList.toggle("lg-refract", cfg.refraction > 0);
  ensureFilter()?.setAttribute("scale", String(cfg.refraction));
}

/**
 * Прозрачность окна, %: 100 — сплошное. Меньше — окно с акриловой подложкой
 * (Windows 11): сквозь него видно рабочий стол и окна позади.
 */
export function applyWindowOpacity(pct: number): void {
  const v = Math.min(100, Math.max(30, Math.round(Number.isFinite(pct) ? pct : 100)));
  const root = document.documentElement;
  const translucent = v < 100;
  root.classList.toggle("win-translucent", translucent);
  root.style.setProperty("--win-alpha", `${v}%`);
  try {
    (window as unknown as { appBridge?: { setTransparent?: (on: boolean) => void } }).appBridge?.setTransparent?.(
      translucent,
    );
  } catch {
    /* не Electron — достаточно CSS */
  }
}
