/**
 * Дизайн-система и «стекло» интерфейса.
 *
 * Оба переключателя — классы на <html>, поэтому работают в любом месте
 * приложения, включая порталы и модалки, а откат к прежнему виду — смена
 * значения в настройках (стили Fluent 2 целиком лежат в styles/fluent.css
 * под селектором html.design-fluent).
 */
export type DesignId = "classic" | "fluent";

export function applyDesign(v: unknown): void {
  const id: DesignId = v === "classic" ? "classic" : "fluent";
  const el = document.documentElement;
  el.classList.toggle("design-fluent", id === "fluent");
  el.classList.toggle("design-classic", id === "classic");
}

export function applyGlass(v: unknown): void {
  document.documentElement.classList.toggle("no-glass", v === false);
}
