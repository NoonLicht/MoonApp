/** Единицы длины интерфейса Word: метрическая система везде, кроме английского (дюймы). */
export interface LenUnit {
  name: "cm" | "in";
  ptPer: number;
  step: number;
}

export const lenUnit = (lang: string): LenUnit =>
  lang === "en"
    ? { name: "in", ptPer: 72, step: 0.05 }
    : { name: "cm", ptPer: 28.3464567, step: 0.1 };

/** Пункты → число в единицах интерфейса (2 знака). */
export const ptToUnit = (pt: number, u: LenUnit): number => Math.round((pt / u.ptPer) * 100) / 100;
export const unitToPt = (v: number, u: LenUnit): number => v * u.ptPer;

/** Цвет #RRGGBB (или RRGGBB) из ответа ядра: «auto» → undefined. */
export function hexOf(c: unknown, fallback?: string): string | undefined {
  if (typeof c === "string" && /^#?[0-9a-fA-F]{6}$/.test(c)) return c.startsWith("#") ? c : `#${c}`;
  return fallback;
}

/** Цвет пера из ядра [r,g,b] → RRGGBB. */
export const rgbHex = (c: number[] | undefined, fallback = "000000"): string =>
  c && c.length >= 3
    ? c
        .slice(0, 3)
        .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()
    : fallback;

/** Файл → base64 без префикса data:. */
export function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
