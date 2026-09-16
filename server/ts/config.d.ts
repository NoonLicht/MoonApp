// Декларация для server/config.js (CommonJS, пока не переведён на TS).
// Пути вычисляются при require: storagePath из electron (если доступен) либо
// process.env.MOONAPP_STORAGE / dev-фолбэк storage/ рядом с исходниками.
interface AppConfig {
  /** Каталоги хранилища приложения (создаются при загрузке модуля). */
  DIRS: Record<string, string>;
  /** Файлы в корне storage: data/settings/secrets + рабочий лог. */
  FILES: { data: string; settings: string; secrets: string; log: string };
  /** Порт локального API-сервера. */
  PORT: number;
}
declare const config: AppConfig;
export = config;
