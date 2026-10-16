/**
 * Фоновые службы, привязанные к страницам (см. features.ts → defineService).
 *
 * Модули подгружаются через require ВНУТРИ start/stop: если страница отключена, её модуль
 * (а с ним и его зависимости) не читается вовсе. Служба стартует, пока включена хотя бы одна
 * из её страниц, и останавливается при отключении последней.
 */
import settings from "./settings";
import logger from "./logger";
import { defineService } from "./features";

/* eslint-disable @typescript-eslint/no-require-imports */

export function registerFeatureServices(): void {
  // Лекции: оборванные падением сессии и зеркало заметок в .md.
  defineService({
    id: "lecture",
    pages: ["lecture"],
    start() {
      const lecture = require("./lecture") as typeof import("./lecture");
      try {
        lecture.recoverInterrupted();
      } catch {
        /* журнал уже внутри */
      }
      try {
        lecture.backfillNotesFiles();
      } catch {
        /* зеркало не критично */
      }
    },
  });

  // Ленты RSS: автообновление работает, пока открыто приложение (нужны страницы RSS или почты).
  defineService({
    id: "rss",
    pages: ["rss", "mail"],
    start: () => (require("./rss") as typeof import("./rss")).startAutoRefresh(),
    stop: () => (require("./rss") as typeof import("./rss")).stopAutoRefresh(),
  });

  // Почта: синхронизация, IDLE, очередь отправки, MCP-сервер.
  defineService({
    id: "mail",
    pages: ["mail"],
    start() {
      (require("./mail/mailService") as typeof import("./mail/mailService")).init();
      (require("./mail/mailMcp") as typeof import("./mail/mailMcp")).syncMcp();
    },
    stop() {
      (require("./mail/mailService") as typeof import("./mail/mailService")).stopLoops();
      (require("./mail/mailMcp") as typeof import("./mail/mailMcp")).stopMcp();
    },
  });

  // Мониторинг: оповещения, LibreHardwareMonitor, прогрев телеметрии, учёт времени в окнах.
  defineService({
    id: "monitor",
    pages: ["monitor"],
    start() {
      const monitor = require("./monitor") as typeof import("./monitor");
      monitor.autoStartLhmIfConfigured();
      (require("./monitorAlerts") as typeof import("./monitorAlerts")).startMonitorAlerts();
      try {
        if (settings.get("monitor").autoStart === true) void monitor.getSnapshot();
      } catch {
        /* сбор телеметрии не должен ломать старт */
      }
    },
    stop() {
      (require("./monitorAlerts") as typeof import("./monitorAlerts")).stopMonitorAlerts();
      (require("./monitor") as typeof import("./monitor")).stopLhm();
      (require("./appTimeTracker") as typeof import("./appTimeTracker")).stop();
    },
  });

  // Автоматизации: слежение за папками по правилам.
  defineService({
    id: "automation",
    pages: ["automation"],
    start: () => (require("./automationRules") as typeof import("./automationRules")).startRules(),
    stop: () => (require("./automationRules") as typeof import("./automationRules")).stopRules(),
  });

  // Обход блокировок: локальный прокси для Telegram Desktop.
  defineService({
    id: "tgws",
    pages: ["bypass"],
    start: () => void (require("./tgwsproxy") as typeof import("./tgwsproxy")).autoStart(),
    stop: () => void (require("./tgwsproxy") as typeof import("./tgwsproxy")).stop(),
  });

  // Магазин приложений: один раз индексируем каталог winget, если кэш ещё пуст.
  defineService({
    id: "store-index",
    pages: ["store"],
    start() {
      try {
        const winget = require("./winget") as typeof import("./winget");
        if (settings.get("store").wingetAutoIndex !== false && !(winget.indexStatus().cached > 0))
          void winget.startIndexing();
      } catch (e) {
        logger.warn("features.store_index_failed", { error: (e as Error).message });
      }
    },
  });
}
