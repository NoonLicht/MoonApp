// Поля, которые middleware приложения добавляют к express.Request.
declare global {
  namespace Express {
    interface Request {
      /** Страница интерфейса, с которой пришёл запрос (см. middleware/perPageProxy). */
      appPage?: string;
      /** Прокси, выбранный для запроса (видео/музыка). */
      proxyUrl?: string;
    }
  }
}
export {};

declare global {
  namespace NodeJS {
    interface Process {
      /** Путь к resources/ упакованного Electron-приложения (в обычном Node отсутствует). */
      resourcesPath?: string;
    }
  }
}
