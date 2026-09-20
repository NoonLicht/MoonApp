/**
 * Тип медиа по имени файла — список расширений совпадает с серверным
 * (server/ts/upscale.ts, IMAGE_EXT).
 *
 * Нужен странице, чтобы предпросмотр не ждал ответа /probe: иначе видео
 * успевало отрисоваться в теге <img> (и не показывалось вовсе).
 */
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "avif", "gif"];

export function fileKind(name: string): "photo" | "video" {
  const ext = String(name || "")
    .toLowerCase()
    .replace(/^.*\./, "");
  return IMAGE_EXT.includes(ext) ? "photo" : "video";
}
