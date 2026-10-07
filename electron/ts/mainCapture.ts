/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import { session, ipcMain } from "electron";
import { serverModule } from "./serverApi";
import { installMediaPermissions } from "./main";
import { mlog } from "./mainCore";

/* ------------------- Системный звук (WASAPI loopback) и права -------------------
 * ПРОБЛЕМА, которую это решает: раньше «системный звук» на странице лекций
 * захватывался через navigator.mediaDevices.getDisplayMedia({video,audio}).
 * В Electron без setDisplayMediaRequestHandler это отдаёт ВИДЕО (скрин/окно),
 * а аудиодорожка либо отсутствует, либо приходит от выбранного источника —
 * пользователь получал в запись шум и «звук с камер», а не звук системы.
 *
 * РЕШЕНИЕ: Electron ≥ 31 умеет отдавать системный звук как WASAPI-loopback:
 * в обработчике display-media выбираем экран и просим audio: "loopback".
 * Тогда в поток приходит ТОЛЬКО звук устройства вывода (без видео).
 *
 * Обработчик ставится ЛЕНИВО, по IPC-запросу страницы лекций, и снимается
 * сразу после захвата — иначе он подменил бы обычный выбор экрана всем
 * остальным страницам приложения.
 */
let captureModeActive = false;

/**
 * "loopback" — специальная строка Electron, реализующая захват системного
 * звука через WASAPI на Windows. На Linux этой строки не существует: Chromium
 * там умеет системный звук ТОЛЬКО через xdg-desktop-portal + PipeWire, и
 * получает его через обычный `audio: true` (портал сам покажет пользователю
 * системный чекбокс "поделиться звуком", если композитор его поддерживает —
 * GNOME/KDE на свежих версиях умеют, часть лёгких WM — нет). Если звук
 * недоступен на конкретной машине, трек аудио будет просто отсутствовать —
 * страница уже это обрабатывает (см. acquireSystemAudio) без падения записи.
 */
function systemAudioRequestValue() {
  return (process.platform === "win32" ? "loopback" : true) as unknown as "loopback";
}

function installLoopbackHandler() {
  if (captureModeActive) return;
  captureModeActive = true;
  installMediaPermissions();
  try {
    (session.defaultSession as any).setDisplayMediaRequestHandler(
      async (request: any, callback: any) => {
        try {
          const { desktopCapturer } = require("electron") as typeof import("electron");
          const sources = await desktopCapturer.getSources({ types: ["screen"] });
          if (!sources.length) {
            callback({});
            return;
          }
          // audio: "loopback" — системный звук; видео нужно только как «носитель»
          // (страница сразу останавливает video-треки, см. acquireSystemAudio).
          callback({ video: sources[0], audio: systemAudioRequestValue() });
        } catch (e: any) {
          mlog("error", "capture.loopback_failed", { error: e?.message || String(e) });
          callback({});
        }
      },
      { useSystemPicker: false },
    );
  } catch (e: any) {
    // Electron < 31 или иная сборка: не роняем приложение, страница покажет
    // честную ошибку «системный звук недоступен» и предложит микрофон.
    captureModeActive = false;
    mlog("error", "capture.handler_unavailable", { error: e?.message || String(e) });
  }
}

function removeLoopbackHandler() {
  if (!captureModeActive) return;
  try {
    session.defaultSession.setDisplayMediaRequestHandler(null);
  } catch {
    /* ignore */
  }
  captureModeActive = false;
}

/**
 * Видео-захват экрана без loopback-звука — для страницы Скриншотов/записи
 * экрана. Тот же приём, что и installLoopbackHandler (обработчик ставится
 * лениво по запросу страницы и снимается сразу после), только без
 * audio:"loopback" — страница пишет либо тишину, либо (опционально)
 * микрофон отдельным getUserMedia-треком на своей стороне.
 * ОГРАНИЧЕНИЕ v1: всегда отдаётся первый найденный экран (sources[0]) —
 * полноценный выбор экрана/окна через UI не реализован ночью, честно
 * задокументировано в UI страницы.
 */
// Конкретный источник (монитор/окно), выбранный пользователем на странице
// «Скриншоты» перед вызовом getDisplayMedia — иначе всегда брался бы sources[0].
let pendingSourceId: any = null;

function installScreenHandler() {
  if (captureModeActive) return;
  captureModeActive = true;
  installMediaPermissions();
  try {
    (session.defaultSession as any).setDisplayMediaRequestHandler(
      async (request: any, callback: any) => {
        try {
          const { desktopCapturer } = require("electron") as typeof import("electron");
          const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
          if (!sources.length) {
            callback({});
            return;
          }
          const picked: any =
            (pendingSourceId && sources.find((s) => s.id === pendingSourceId)) || sources[0];
          callback({ video: picked });
        } catch (e: any) {
          mlog("error", "capture.screen_failed", { error: e?.message || String(e) });
          callback({});
        }
      },
      { useSystemPicker: false },
    );
  } catch (e: any) {
    captureModeActive = false;
    mlog("error", "capture.handler_unavailable", { error: e?.message || String(e) });
  }
}

/**
 * Видео экрана + системный звук ОДНОВРЕМЕННО (страница «Скриншоты» → запись с
 * захватом аудио "система"/"оба источника") — в отличие от installLoopbackHandler
 * (тот отдаёт audio:"loopback" вообще БЕЗ видео, страница сама останавливает
 * video-трек — это годится только для лектория, где видео не нужно). Здесь
 * возвращается выбранный источник видео (см. installScreenHandler) ВМЕСТЕ с
 * audio:"loopback" в одном потоке.
 */
function installScreenWithAudioHandler() {
  if (captureModeActive) return;
  captureModeActive = true;
  installMediaPermissions();
  try {
    (session.defaultSession as any).setDisplayMediaRequestHandler(
      async (request: any, callback: any) => {
        try {
          const { desktopCapturer } = require("electron") as typeof import("electron");
          const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
          if (!sources.length) {
            callback({});
            return;
          }
          const picked: any =
            (pendingSourceId && sources.find((s) => s.id === pendingSourceId)) || sources[0];
          callback({ video: picked, audio: systemAudioRequestValue() });
        } catch (e: any) {
          mlog("error", "capture.screen_audio_failed", { error: e?.message || String(e) });
          callback({});
        }
      },
      { useSystemPicker: false },
    );
  } catch (e: any) {
    captureModeActive = false;
    mlog("error", "capture.handler_unavailable", { error: e?.message || String(e) });
  }
}

// Список экранов/окон для выбора источника захвата (страница «Скриншоты»).
// thumbnailSize даёт превью прямо в desktopCapturer, без отдельного захвата кадра.
ipcMain.handle("capture:list-sources", async () => {
  try {
    const { desktopCapturer, screen } = require("electron") as typeof import("electron");
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
    });
    // Реальное разрешение монитора — по display_id сопоставляем с
    // screen.getAllDisplays() (у desktopCapturer только превью 320x180, а
    // страница «Скриншоты» строит список разрешений записи ПОД разрешение
    // конкретного выбранного монитора — у ультраширокого 21:9 и вертикального
    // 9:16 оно совсем не 16:9, поэтому фиксированный список плашек не подходит).
    // size — в DIP, умножаем на scaleFactor, чтобы получить физические пиксели
    // (то, что реально придёт из getDisplayMedia).
    const displays = screen.getAllDisplays();
    return sources.map((s) => {
      const kind = s.id.startsWith("screen:") ? "screen" : "window";
      let width;
      let height;
      if (kind === "screen" && s.display_id) {
        const d = displays.find((x) => String(x.id) === String(s.display_id));
        if (d) {
          width = Math.round(d.size.width * d.scaleFactor);
          height = Math.round(d.size.height * d.scaleFactor);
        }
      }
      return {
        id: s.id,
        name: s.name,
        kind,
        thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
        width,
        height,
      };
    });
  } catch (e: any) {
    mlog("error", "capture.list_sources_failed", { error: e?.message || String(e) });
    return [];
  }
});

// Режим захвата: "loopback" — системный звук (лекции), "screen" — видео экрана
// без звука (скриншоты/запись), "default" — снять обработчик.
// sourceId — id из capture:list-sources (desktopCapturer), выбранный на странице.
ipcMain.handle("rec:capture-mode", (_e, mode, sourceId) => {
  const m = String(mode);
  pendingSourceId = sourceId || null;
  if (m === "loopback") {
    installLoopbackHandler();
    return { ok: true, mode: "loopback" };
  }
  if (m === "screen") {
    installScreenHandler();
    return { ok: true, mode: "screen" };
  }
  if (m === "screenAudio") {
    installScreenWithAudioHandler();
    return { ok: true, mode: "screenAudio" };
  }
  removeLoopbackHandler();
  return { ok: true, mode: "default" };
});

/**
 * Резервный захват системного звука на Linux через PulseAudio/PipeWire
 * (server/audioCaptureLinux.js), на случай если portal-путь Chromium
 * (audio:true в systemAudioRequestValue) не дал звука на конкретной машине.
 * Страница записи вызывает start ПЕРЕД началом видеозахвата и stop сразу
 * после его остановки, затем муксирует полученный WAV с видео через ffmpeg
 * (тот же конвейер, что и в screenshots.js). На Windows эти хэндлеры не
 * нужны (там звук уже идёт через WASAPI loopback) — но регистрируются
 * безусловно и просто возвращают "not_applicable_on_windows", чтобы страница
 * могла звать их одинаково на любой ОС без platform-веток на своей стороне.
 */
ipcMain.handle("audio:linux-fallback-start", async () => {
  if (process.platform === "win32") return { ok: false, error: "not_applicable_on_windows" };
  try {
    return await serverModule("../server/audioCaptureLinux").startSystemAudioCapture();
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("audio:linux-fallback-stop", async () => {
  if (process.platform === "win32") return { ok: true, path: null };
  try {
    const p = await serverModule("../server/audioCaptureLinux").stopSystemAudioCapture();
    return { ok: true, path: p };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});
