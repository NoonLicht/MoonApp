/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import crypto from "crypto";
import { serverModule } from "./serverApi";
import path from "path";
import fs from "fs";
import { ipcMain } from "electron";
import { mlog, readSettings } from "./mainCore";

/* ------------------- Автосохранение скриншотов из буфера обмена -------------------
 * PrintScreen и Win+Shift+S (Snipping Tool) не пишут файл на диск — оба кладут
 * картинку ТОЛЬКО в буфер обмена. Перехватить сами клавиши системно и надёжно
 * нельзя (Win+Shift+S — это встроенный UI Windows, а не наше приложение), зато
 * можно следить за буфером: опрашиваем раз в ~1.2с, сравниваем с последним
 * увиденным содержимым по хешу PNG, и при появлении новой картинки сохраняем
 * её в ту же библиотеку, что и обычные скриншоты страницы (server/screenshots.js
 * — общий стор storage/screenshots, тот же список/плеер/редактор на странице).
 *
 * ОГРАНИЧЕНИЕ (честно, не скрываем): отличить «это скриншот» от «это картинка,
 * скопированная в браузере или в другом приложении» по буферу обмена нечем —
 * он не хранит источник. Настройка screenshots.autoCaptureClipboard (страница
 * «Скриншоты», по умолчанию включена) — единственный способ выключить это,
 * если ловить в библиотеку любое Ctrl+C с картинкой нежелательно.
 */
let clipboardWatchTimer: any = null;
let lastClipboardHash = "";

function clipboardImageHash(img: any) {
  if (!img || img.isEmpty()) return "";
  const buf = img.toPNG();
  if (!buf.length) return "";
  return crypto.createHash("sha1").update(buf).digest("hex");
}

export function startClipboardWatch() {
  if (clipboardWatchTimer) return;
  const { clipboard } = require("electron") as typeof import("electron");
  // Стартовое значение — то, что уже лежало в буфере ДО запуска приложения,
  // не должно тут же уйти в библиотеку как "новый" скриншот.
  try {
    lastClipboardHash = clipboardImageHash(clipboard.readImage());
  } catch {
    lastClipboardHash = "";
  }
  clipboardWatchTimer = setInterval(() => {
    if (readSettings()?.screenshots?.autoCaptureClipboard === false) return;
    let img;
    try {
      img = clipboard.readImage();
    } catch {
      return;
    }
    const hash = clipboardImageHash(img);
    if (!hash || hash === lastClipboardHash) return;
    lastClipboardHash = hash;
    try {
      const buf = img.toPNG();
      const size = img.getSize();
      const { DIRS } = serverModule("../server/config");
      const tmpPath = path.join(
        DIRS.tmp,
        `clip-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`,
      );
      fs.writeFileSync(tmpPath, buf);
      serverModule("../server/screenshots").saveFromTemp(tmpPath, {
        type: "image",
        ext: "png",
        mime: "image/png",
        width: size.width,
        height: size.height,
      });
      mlog("info", "clipboard.autosave", {
        width: size.width,
        height: size.height,
        bytes: buf.length,
      });
    } catch (e: any) {
      mlog("error", "clipboard.autosave_failed", { error: e?.message || String(e) });
    }
  }, 1200);
}

export function stopClipboardWatch() {
  if (clipboardWatchTimer) clearInterval(clipboardWatchTimer);
  clipboardWatchTimer = null;
}

// Страница «Скриншоты» вызывает это сразу после того, как сама записала
// картинку в буфер обмена (кнопка «Скопировать») — иначе вотчер решил бы,
// что это новый внешний скриншот, и задвоил бы библиотеку тем же кадром.
ipcMain.handle("clipboard:mark-seen", () => {
  try {
    const { clipboard } = require("electron") as typeof import("electron");
    lastClipboardHash = clipboardImageHash(clipboard.readImage());
  } catch {
    /* ignore */
  }
  return { ok: true };
});
