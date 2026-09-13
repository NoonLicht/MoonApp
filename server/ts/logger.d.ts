// Декларация для server/logger.js (CommonJS, пока не переведён на TS).
declare const logger: {
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
  action(event: string, data?: unknown): void;
};
export = logger;
