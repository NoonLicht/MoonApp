"use strict";

/**
 * Скачивает движки, которые кладутся ПРЯМО В ИНСТАЛЛЯТОР (server/vendor):
 *   • yt-dlp.exe   — официальный portable-релиз (страница «Видео»/«Музыка»);
 *   • sing-box.exe — распаковывается из windows-amd64.zip (страница «Прокси»).
 *
 * Зачем: на чистой машине бинарники больше не нужно качать из UI после установки —
 * они уже лежат в resources/app.asar.unpacked/server/vendor и подхватываются
 * detectYtDlp()/detectSB() как кандидаты (см. server/ytdlp.js, server/proxy.js).
 *
 * Запускается локально (`npm run dist` → этот скрипт) и в CI (release.yml).
 * Идемпотентен: уже скачанный файл повторно не тянется.
 */
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

// Держать в синхроне с SB_VER в server/proxy.js и YTDLP (latest).
const SB_VER = "1.11.0";
const root = path.join(__dirname, "..");
const YTDLP_OUT = path.join(root, "server", "vendor", "ytdlp", "yt-dlp.exe");
const SINGBOX_OUT = path.join(root, "server", "vendor", "singbox", "sing-box.exe");
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const SINGBOX_URL = `https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/sing-box-${SB_VER}-windows-amd64.zip`;

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "MoonApp-build" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (fs.existsSync(YTDLP_OUT)) {
    console.log(`[fetch-engines] yt-dlp.exe уже есть: ${YTDLP_OUT}`);
  } else {
    const buf = await fetchBuffer(YTDLP_URL);
    fs.mkdirSync(path.dirname(YTDLP_OUT), { recursive: true });
    fs.writeFileSync(YTDLP_OUT, buf);
    console.log(`[fetch-engines] yt-dlp.exe → ${YTDLP_OUT} (${buf.length} bytes)`);
  }

  if (fs.existsSync(SINGBOX_OUT)) {
    console.log(`[fetch-engines] sing-box.exe уже есть: ${SINGBOX_OUT}`);
  } else {
    const zipBuf = await fetchBuffer(SINGBOX_URL);
    const zip = new AdmZip(zipBuf);
    const entry = zip.getEntries().find((e) => /(^|\/)sing-box\.exe$/i.test(e.entryName));
    if (!entry) throw new Error("sing-box.exe не найден внутри архива");
    fs.mkdirSync(path.dirname(SINGBOX_OUT), { recursive: true });
    fs.writeFileSync(SINGBOX_OUT, entry.getData());
    console.log(`[fetch-engines] sing-box.exe → ${SINGBOX_OUT} (${entry.header.size} bytes)`);
  }
}

main().catch((e) => {
  console.error("[fetch-engines] ошибка:", e.message);
  process.exit(1);
});
