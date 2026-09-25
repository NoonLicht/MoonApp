import {
  Store,
  Repeat,
  Gauge,
  Video,
  Clapperboard,
  Music2,
  BookOpen,
  Activity,
  User,
  MessageSquare,
  Mic2,
  GraduationCap,
  Shield,
  Archive,
  Settings2,
  Sparkles,
  Wrench,
  Gamepad2,
  Camera,
  Zap,
} from "lucide-react";
import type { ElementType } from "react";
import type { TranslateFn } from "@/app/i18n";

/** Идентификатор страницы приложения (док, keep-alive, стартовая страница). */
export type PageId =
  | "store"
  | "convert"
  | "compress"
  | "upscale"
  | "video"
  | "movies"
  | "music"
  | "books"
  | "monitor"
  | "aichat"
  | "voice"
  | "archive"
  | "settings"
  | "myspace"
  | "lecture"
  | "bypass"
  | "tools"
  | "games"
  | "screenshots"
  | "automation";

export interface PageMeta {
  id: PageId;
  /** i18n-ключ названия страницы (секция nav). */
  i18n: string;
  icon: ElementType;
}

/**
 * Единственный источник правды по страницам: порядок в доке, названия и
 * список для выбора «Стартовая страница» в настройках (SettingsPage).
 *
 * Раньше перечень стартовых страниц был продублирован в настройках обычным
 * строковым массивом и отставал от реального набора страниц: в нём не было
 * movies, lecture и bypass. Теперь он строится из PAGES, поэтому новая
 * страница автоматически появляется и в настройках
 * (см. tests/navigation.test.ts).
 */
export const PAGES: readonly PageMeta[] = [
  { id: "store", i18n: "nav.store", icon: Store },
  { id: "convert", i18n: "nav.convert", icon: Repeat },
  { id: "compress", i18n: "nav.compress", icon: Gauge },
  { id: "upscale", i18n: "nav.upscale", icon: Sparkles },
  { id: "video", i18n: "nav.video", icon: Video },
  { id: "movies", i18n: "nav.movies", icon: Clapperboard },
  { id: "music", i18n: "nav.music", icon: Music2 },
  { id: "books", i18n: "nav.books", icon: BookOpen },
  { id: "monitor", i18n: "nav.monitor", icon: Activity },
  { id: "myspace", i18n: "nav.myspace", icon: User },
  { id: "aichat", i18n: "nav.aichat", icon: MessageSquare },
  { id: "voice", i18n: "nav.voice", icon: Mic2 },
  { id: "lecture", i18n: "nav.lecture", icon: GraduationCap },
  { id: "bypass", i18n: "nav.bypass", icon: Shield },
  { id: "tools", i18n: "nav.tools", icon: Wrench },
  { id: "games", i18n: "nav.games", icon: Gamepad2 },
  { id: "screenshots", i18n: "nav.screenshots", icon: Camera },
  { id: "automation", i18n: "nav.automation", icon: Zap },
  { id: "archive", i18n: "nav.archive", icon: Archive },
  { id: "settings", i18n: "nav.settings", icon: Settings2 },
];

/**
 * Варианты для селекта «Стартовая страница» в настройках: id страницы +
 * её локализованное название. Отдельная функция (а не массив строк в разметке)
 * нужна, чтобы список нельзя было «потерять» и чтобы его покрывал тест.
 */
export function startPageOptions(t: TranslateFn): { value: string; label: string }[] {
  return PAGES.map((p) => ({ value: p.id, label: t(p.i18n) }));
}
