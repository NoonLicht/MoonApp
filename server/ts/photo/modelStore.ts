/**
 * Каталог моделей страницы «Фото и видео»: что скачивается по требованию и где лежит.
 *
 * Модели не входят в установщик — их качают кнопкой на нужной вкладке (как GigaAM и апскейл).
 * Одновременно идёт одна загрузка (общая задача setupTask), статус читается опросом.
 */
import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import { downloadToFile } from "../download";
import { createSetupTask } from "../setupTask";
import type { SetupTaskState } from "../setupTask";

const { DIRS } = config;

export const PHOTO_DIR = path.join(DIRS.storage, "photo");
const UA = "MoonApp/1.0 (+photo)";

export interface PhotoModel {
  id: string;
  /** Для каких возможностей нужна (вкладка). */
  feature: "bgremove" | "faceswap";
  title: string;
  license: string;
  sizeMb: number;
  files: { url: string; name: string }[];
}

const HF = "https://huggingface.co";

export const MODELS: PhotoModel[] = [
  {
    id: "birefnet-lite",
    feature: "bgremove",
    title: "BiRefNet lite",
    license: "MIT",
    sizeMb: 214,
    files: [
      {
        url: `${HF}/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx`,
        name: "model.onnx",
      },
    ],
  },
  {
    id: "birefnet",
    feature: "bgremove",
    title: "BiRefNet (точнее, тяжелее)",
    license: "MIT",
    sizeMb: 928,
    files: [
      {
        url: `${HF}/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx`,
        name: "model.onnx",
      },
    ],
  },
];

const setup = createSetupTask("photo");

export const modelDir = (id: string): string => path.join(PHOTO_DIR, id);
export const modelFile = (id: string, name = "model.onnx"): string => path.join(modelDir(id), name);

export function findModel(id: string): PhotoModel | undefined {
  return MODELS.find((m) => m.id === id);
}

export function isInstalled(id: string): boolean {
  const m = findModel(id);
  return !!m && m.files.every((f) => fs.existsSync(path.join(modelDir(id), f.name)));
}

export function taskSnapshot(): SetupTaskState {
  return setup.snapshot();
}

export function list(): (PhotoModel & { installed: boolean })[] {
  return MODELS.map((m) => ({ ...m, installed: isInstalled(m.id) }));
}

export function download(id: string): SetupTaskState {
  const m = findModel(id);
  if (!m) throw new Error("unknown_model");
  if (setup.isWorking()) throw new Error("busy");
  setup.reset("model", id);
  (async () => {
    try {
      fs.mkdirSync(modelDir(id), { recursive: true });
      for (const f of m.files) {
        const part = path.join(modelDir(id), `${f.name}.part`);
        // Хост моделей иногда не отвечает с первого раза (таймаут соединения) — пробуем ещё.
        for (let attempt = 1; ; attempt++) {
          try {
            await downloadToFile(f.url, part, {
              userAgent: UA,
              shouldCancel: () => setup.shouldCancel(),
              onProgress: ({ total, received }) => setup.setDownloadProgress(received, total),
            });
            break;
          } catch (e) {
            if (
              attempt >= 3 ||
              setup.shouldCancel() ||
              /cancel/i.test(String((e as Error).message))
            )
              throw e;
            logger.warn("photo.model.retry", { id, attempt, error: String((e as Error).message) });
          }
        }
        fs.rmSync(path.join(modelDir(id), f.name), { force: true });
        fs.renameSync(part, path.join(modelDir(id), f.name));
      }
      setup.done();
      logger.action("photo.model.installed", { id });
    } catch (e) {
      setup.fail(e);
    }
  })();
  return setup.snapshot();
}

export function cancel(): SetupTaskState {
  return setup.cancel();
}

export function remove(id: string): void {
  if (!findModel(id)) throw new Error("unknown_model");
  fs.rmSync(modelDir(id), { recursive: true, force: true });
}
