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

/** PNG из буфера обмена (Electron 44: clipboard стал асинхронным, readImage() убран). */
async function readClipboardPng(): Promise<Buffer | null> {
  const { clipboard } = require("electron") as typeof import("electron");
  const items = await clipboard.read();
  for (const item of items) {
    if (!item.types.includes("image/png")) continue;
    const blob = await item.getType("image/png");
    const buf = Buffer.from(await blob.arrayBuffer());
    return buf.length ? buf : null;
  }
  return null;
}

function pngHash(buf: Buffer | null) {
  return buf ? crypto.createHash("sha1").update(buf).digest("hex") : "";
}

export function startClipboardWatch() {
  if (clipboardWatchTimer) return;
  // Стартовое значение — то, что уже лежало в буфере ДО запуска приложения,
  // не должно тут же уйти в библиотеку как "новый" скриншот.
  let busy = false;
  readClipboardPng()
    .then((buf) => {
      lastClipboardHash = pngHash(buf);
    })
    .catch(() => {
      lastClipboardHash = "";
    });
  clipboardWatchTimer = setInterval(async () => {
    if (busy) return;
    if (readSettings()?.screenshots?.autoCaptureClipboard === false) return;
    busy = true;
    try {
      let buf: Buffer | null;
      try {
        buf = await readClipboardPng();
      } catch {
        return;
      }
      const hash = pngHash(buf);
      if (!buf || !hash || hash === lastClipboardHash) return;
      lastClipboardHash = hash;
      try {
        const { nativeImage } = require("electron") as typeof import("electron");
        const size = nativeImage.createFromBuffer(buf).getSize();
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
    } finally {
      busy = false;
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
ipcMain.handle("clipboard:mark-seen", async () => {
  try {
    lastClipboardHash = pngHash(await readClipboardPng());
  } catch {
    /* ignore */
  }
  return { ok: true };
});
