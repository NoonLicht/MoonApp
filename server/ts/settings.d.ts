// Декларация для server/settings.js (CommonJS, пока не переведён на TS).
interface SettingsTree { [key: string]: any }
declare const settings: {
  load(): SettingsTree;
  get(key?: string): any;
  set(patch: unknown): SettingsTree;
  DEFAULTS: SettingsTree;
};
export = settings;
