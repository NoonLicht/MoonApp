/**
 * Апскейл фото и видео на встроенном рантайме ONNX (onnxruntime-node).
 *
 * Архитектура v1:
 *  - Инференс — НАШ код: onnxruntime-node (N-API) + ONNX-модели из
 *    storage/models/upscale (качаются по требованию, см. scripts/fetch-models.js
 *    и POST /api/upscale/models/download). Внешних CLI-апскейлеров нет.
 *  - Пиксельный I/O — через уже имеющийся в проекте ffmpeg
 *    (server/ts/convertEngine.ts → detectFfmpeg): decode в rgb24 raw, encode из
 *    rgb24 raw. Так мы не тащим вторую библиотеку декодирования картинок.
 *  - Тайлинг: картинка режется на тайлы с перекрытием (не упереться в VRAM),
 *    результат склеивается с плавным переходом в зоне перекрытия.
 *  - Пост-обработка (резкость/шум/целевой размер) — нативный ffmpeg-фильтр
 *    (-vf scale/unsharp/hqdn3d), а не JS-циклы по пикселям.
 *  - Очередь: одно активное задание, остальные ждут (server/ts/jobStore.ts),
 *    TTL-чистка временных папок 24 ч.
 *
 * Видео идёт через server/ts/upscalePipeline.ts: decode(rawvideo) → кадры по
 * одному в этот движок → encode с копией звука/субтитров.
 *
 * TS-исходник, как server/ts/compressor.ts: компилируется в server/upscale.js
 * командой `npm run compile:server`, поэтому require("./upscale") из
 * server/routes/upscale.js работает без сборки.
 *
 * Реализация разложена на подмодули в server/ts/upscale/ (extract module,
 * без изменения поведения) — этот файл остаётся тонким фасадом, чтобы
 * require("./upscale") и все прежние импорты продолжали работать как раньше.
 */

// Потолок множителя плавности нужен и UI (валидация поля), и тестам — держим
// его экспортируемым из движка, а не только внутри пайплайна.
export { MAX_INTERP_MULT } from "./upscalePipeline";

export * from "./upscale/types";
export * from "./upscale/util";
export * from "./upscale/tiling";
export * from "./upscale/manifest";
export * from "./upscale/runtime";
export * from "./upscale/trt";
export * from "./upscale/session";
export * from "./upscale/params";
export * from "./upscale/inference";
export * from "./upscale/bench";
export * from "./upscale/procTracking";
export * from "./upscale/jobs";
