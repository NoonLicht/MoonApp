"use strict";

/**
 * Скачивает движок распознавания для страницы «Лекторий»:
 *   • whisper.cpp (Windows x64, сборка с OpenBLAS) → storage/whisper/*.exe|*.dll
 *   • ggml-small.bin (мультиязычная модель, лучший баланс качества и скорости
 *     для русской речи на CPU/ноутбуке) → storage/whisper/models/
 *
 * Почему не в инсталлятор (в отличие от fetch-engines.js): модель весит ~466 МБ.
 * Скрипт идемпотентный, запускается отдельно: `npm run fetch:whisper`.
 *
 * Пути и имена совпадают с тем, что ищет server/lecture.js:
 *   findWhisperBin() → storage/whisper/whisper-cli.exe (или main.exe)
 *   findModel()      → storage/whisper/models/ggml-*.bin (приоритет small)
 */
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const AdmZip = require("adm-zip");

// Держать в синхроне с server/lecture.js (автопоиск бинарника и модели).
const WHISPER_TAG = "b5130";
const WHISPER_ZIP = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-blas-bin-x64.zip`;
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const MODEL_NAME = "ggml-small.bin";

const root = path.join(__dirname, "..");
const storage = process.env.MOONAPP_STORAGE || path.join(root, "storage");
const WHISPER_DIR = path.join(storage, "whisper");
const MODEL_OUT = path.join(WHISPER_DIR, "models", MODEL_NAME);
const BIN_OUT = path.join(WHISPER_DIR, "whisper-cli.exe");

/** Потоковая загрузка в файл (модель большая — не держим её в памяти). */
async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "MoonApp-build" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(res.body, fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}

async function main() {
  if (fs.existsSync(BIN_OUT)) {
    console.log(`[fetch-whisper] whisper-cli.exe уже есть: ${BIN_OUT}`);
  } else {
    const zipPath = path.join(WHISPER_DIR, "_whisper.zip");
    const size = await download(WHISPER_ZIP, zipPath);
    const zip = new AdmZip(zipPath);
    let unpacked = 0;
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      // В архиве файлы лежат в подпапке Release/ — раскладываем их плоско, как
      // ожидает findWhisperBin()/guessBackend() (exe и DLL в одном каталоге).
      const name = path.basename(e.entryName);
      if (!/\.(exe|dll)$/i.test(name)) continue;
      fs.writeFileSync(path.join(WHISPER_DIR, name), e.getData());
      unpacked++;
    }
    fs.rmSync(zipPath, { force: true });
    console.log(
      `[fetch-whisper] whisper.cpp ${WHISPER_TAG} → ${WHISPER_DIR}` +
        ` (${unpacked} файлов, ${(size / 1048576).toFixed(1)} МБ)`,
    );
  }

  if (fs.existsSync(MODEL_OUT)) {
    console.log(`[fetch-whisper] модель уже есть: ${MODEL_OUT}`);
  } else {
    const size = await download(MODEL_URL, MODEL_OUT);
    console.log(`[fetch-whisper] ${MODEL_NAME} → ${MODEL_OUT} (${(size / 1048576).toFixed(1)} МБ)`);
  }
  console.log("[fetch-whisper] готово: страница «Лекторий» покажет «whisper.cpp ready».");
}

main().catch((e) => {
  console.error("[fetch-whisper] ошибка:", e.message);
  process.exit(1);
});
