import type en from "@/i18n/en.json";
import type { TranslateFn } from "@/app/i18n";

/**
 * Подписи канваса. Раньше здесь жил собственный словарь RU/EN (остальные 4
 * языка видели английский) — теперь строки лежат в общих src/i18n/*.json в
 * секции "canvas" и переводятся вместе со всем приложением.
 */
export type Key = keyof (typeof en)["canvas"];

export const strings =
  (t: TranslateFn): ((k: Key) => string) =>
  (k) =>
    t(`canvas.${k}`);
