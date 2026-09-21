import type { ManifestModel, TileRect } from "./types";
import { clamp01 } from "./util";

export function tileRects(w: number, h: number, tile: number, overlap: number): TileRect[] {
  if (!(w > 0) || !(h > 0)) return [];
  if (!(tile > 0) || (tile >= w && tile >= h)) return [{ x: 0, y: 0, w, h }];
  const step = Math.max(1, Math.round(tile) - Math.max(0, Math.round(overlap)));
  const ys: number[] = [];
  for (let y = 0; y < h; y += step) ys.push(Math.min(y, Math.max(0, h - tile)));
  const xs: number[] = [];
  for (let x = 0; x < w; x += step) xs.push(Math.min(x, Math.max(0, w - tile)));

  const rects: TileRect[] = [];
  const seen = new Set<string>();
  for (const y of ys) {
    for (const x of xs) {
      const key = `${y}:${x}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rects.push({ x, y, w: Math.min(tile, w - x), h: Math.min(tile, h - y) });
    }
  }
  return rects;
}

// ================== НОРМАЛИЗАЦИЯ ПАРАМЕТРОВ ==================

export function normTile(
  src: Uint8Array,
  srcW: number,
  x: number,
  y: number,
  tw: number,
  th: number,
  bgr: boolean,
): Float32Array {
  const out = new Float32Array(tw * th * 3);
  const plane = tw * th;
  const rOff = bgr ? 2 : 0;
  const bOff = bgr ? 0 : 2;
  for (let j = 0; j < th; j++) {
    const sRow = ((y + j) * srcW + x) * 3;
    const dRow = j * tw;
    for (let i = 0; i < tw; i++) {
      const s = sRow + i * 3;
      const d = dRow + i;
      out[d] = src[s + rOff] / 255;
      out[plane + d] = src[s + 1] / 255;
      out[plane * 2 + d] = src[s + bOff] / 255;
    }
  }
  return out;
}

export function modelAlign(m: ManifestModel | null | undefined): number {
  const v = Math.round(Number(m?.align ?? 0));
  return Number.isFinite(v) && v >= 2 && v <= 64 ? v : 1;
}

/**
 * Тайл во Float32-плоскость с выравниванием размера.
 *
 * Часть графов (Real-CUGAN: внутри UNet1 есть down/up-семплинг) принимает только
 * размеры, кратные двум. Пользовательский тайл и последний тайл кадра могут быть
 * любого размера, поэтому недостающие пиксели добираются повтором крайнего
 * столбца/строки, а при вклейке обрезаются (blendTile читает реальный размер).
 */
export function normTilePad(
  src: Uint8Array,
  srcW: number,
  x: number,
  y: number,
  tw: number,
  th: number,
  aw: number,
  ah: number,
  bgr: boolean,
): Float32Array {
  if (aw === tw && ah === th) return normTile(src, srcW, x, y, tw, th, bgr);
  const out = new Float32Array(aw * ah * 3);
  const plane = aw * ah;
  const rOff = bgr ? 2 : 0;
  const bOff = bgr ? 0 : 2;
  for (let j = 0; j < ah; j++) {
    const sRow = ((y + (j < th ? j : th - 1)) * srcW + x) * 3;
    const dRow = j * aw;
    for (let i = 0; i < aw; i++) {
      const si = i < tw ? i : tw - 1;
      const s = sRow + si * 3;
      const d = dRow + i;
      out[d] = src[s + rOff] / 255;
      out[plane + d] = src[s + 1] / 255;
      out[plane * 2 + d] = src[s + bOff] / 255;
    }
  }
  return out;
}

/**
 * Вклейка обработанного тайла в общий буфер.
 *
 * Прозрачность (fade-in) включается только на левой/верхней кромке тайла, если
 * у него есть сосед слева/сверху: тайлы идут слева-направо, сверху-вниз, и
 * каждый следующий плавно «въезжает» на место предыдущего в зоне перекрытия.
 * Кромки всего изображения пишутся сразу на 100% — иначе были бы чёрные полосы.
 *
 * `srcStride` — ширина плоскости в буфере модели: если тайл выравнивался под
 * требование графа (`align`), данные лежат с другой шириной строки, а вклеиваем
 * мы только реальные `tw × th` пикселей.
 */
export function blendTile(
  dst: Uint8Array,
  dstW: number,
  dstH: number,
  data: Float32Array,
  tw: number,
  th: number,
  scale: number,
  dstX: number,
  dstY: number,
  fadePx: number,
  bgr: boolean,
  srcStride?: number,
): void {
  const ow = tw * scale;
  const oh = th * scale;
  const stride = srcStride && srcStride > 0 ? srcStride : ow;
  const plane = stride * oh;
  const f = Math.max(0, Math.round(fadePx * scale));
  const rP = bgr ? 2 : 0;
  const bP = bgr ? 0 : 2;

  for (let j = 0; j < oh; j++) {
    const gy = dstY + j;
    if (gy < 0 || gy >= dstH) continue;
    const wy = dstY > 0 && f > 0 ? Math.min(1, j / f) : 1;
    for (let i = 0; i < ow; i++) {
      const gx = dstX + i;
      if (gx < 0 || gx >= dstW) continue;
      const wx = dstX > 0 && f > 0 ? Math.min(1, i / f) : 1;
      const a = wx * wy;
      if (a <= 0) continue; // пиксель уже записан предыдущим тайлом — не трогаем
      const s = j * stride + i;
      const d = (gy * dstW + gx) * 3;
      dst[d] = Math.round(dst[d] * (1 - a) + clamp01(data[rP * plane + s]) * 255 * a);
      dst[d + 1] = Math.round(dst[d + 1] * (1 - a) + clamp01(data[plane + s]) * 255 * a);
      dst[d + 2] = Math.round(dst[d + 2] * (1 - a) + clamp01(data[bP * plane + s]) * 255 * a);
    }
  }
}

/** Один прогон сессии: собрать feeds, вызвать run, отдать плоскость выхода. */
export function mixPlanes(a: Float32Array, b: Float32Array, w: number, len: number): Float32Array {
  const out = new Float32Array(len);
  const k = clamp01(w);
  for (let i = 0; i < len; i++) out[i] = a[i] * (1 - k) + (b[i] || 0) * k;
  return out;
}

// ============ ИНТЕРПОЛЯЦИЯ КАДРОВ МОДЕЛЬЮ (RIFE / CAIN / IFRNet) ============
// Модели интерполяции отличаются схемой входов, а не смыслом: на вход две
// соседние рамки (у RIFE — ещё и момент времени между ними), на выходе — кадр
// между ними. Схему задаёт манифест (`inputSig`), иначе определяем по именам
// входов уже созданной ONNX-сессии.

