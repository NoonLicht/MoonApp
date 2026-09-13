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
// sing-box кладём в ДВЕ точки: legacy-путь страницы «Прокси» (singbox) и новый
// каталог встроенного ядра (proxy-core), который читает server/proxyCore.js
// (detectEngine → VENDOR_BIN).
const SINGBOX_OUT = path.join(root, "server", "vendor", "singbox", "sing-box.exe");
const PROXY_CORE_OUT = path.join(root, "server", "vendor", "proxy-core", "sing-box.exe");
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

  // sing-box нужен в двух путях (legacy singbox + proxy-core). Архив качается
  // один раз и раскладывается туда, где файла ещё нет.
  const singBoxTargets = [SINGBOX_OUT, PROXY_CORE_OUT];
  const missing = singBoxTargets.filter((p) => !fs.existsSync(p));
  if (missing.length === 0) {
    console.log(`[fetch-engines] sing-box.exe уже есть: ${singBoxTargets.join(", ")}`);
  } else {
    const zipBuf = await fetchBuffer(SINGBOX_URL);
    const zip = new AdmZip(zipBuf);
    const entry = zip.getEntries().find((e) => /(^|\/)sing-box\.exe$/i.test(e.entryName));
    if (!entry) throw new Error("sing-box.exe не найден внутри архива");
    const data = entry.getData();
    for (const out of missing) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      console.log(`[fetch-engines] sing-box.exe → ${out} (${entry.header.size} bytes)`);
    }
  }
}

main().catch((e) => {
  console.error("[fetch-engines] ошибка:", e.message);
  process.exit(1);
});
