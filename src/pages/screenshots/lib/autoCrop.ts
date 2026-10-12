/**
 * Умная обрезка: убирает однотонные поля вокруг содержимого скриншота.
 * Цвет фона берётся по углам; строка/столбец считаются пустыми, если все
 * их пиксели отличаются от фона не больше чем на `tolerance` по каждому каналу.
 */
export interface PixelData {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function px(img: PixelData, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Наиболее частый цвет среди четырёх углов (при ничьей — левый верхний). */
function backgroundColor(img: PixelData): [number, number, number] {
  const corners = [
    px(img, 0, 0),
    px(img, img.width - 1, 0),
    px(img, 0, img.height - 1),
    px(img, img.width - 1, img.height - 1),
  ];
  let best = corners[0];
  let bestN = 0;
  for (const c of corners) {
    const n = corners.filter((o) => o.every((v, i) => Math.abs(v - c[i]) <= 6)).length;
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

/**
 * Возвращает прямоугольник содержимого с отступом `margin`, либо null, если
 * обрезать нечего (поля меньше 4 px по всем сторонам) или изображение однотонное.
 */
export function autoCropBounds(img: PixelData, tolerance = 12, margin = 8): CropRect | null {
  const { width: W, height: H } = img;
  if (W < 8 || H < 8) return null;
  const bg = backgroundColor(img);
  const isBg = (x: number, y: number): boolean => {
    const [r, g, b] = px(img, x, y);
    return (
      Math.abs(r - bg[0]) <= tolerance &&
      Math.abs(g - bg[1]) <= tolerance &&
      Math.abs(b - bg[2]) <= tolerance
    );
  };
  const rowEmpty = (y: number): boolean => {
    for (let x = 0; x < W; x++) if (!isBg(x, y)) return false;
    return true;
  };
  const colEmpty = (x: number, y0: number, y1: number): boolean => {
    for (let y = y0; y <= y1; y++) if (!isBg(x, y)) return false;
    return true;
  };

  let top = 0;
  while (top < H && rowEmpty(top)) top++;
  if (top === H) return null; // всё одного цвета
  let bottom = H - 1;
  while (bottom > top && rowEmpty(bottom)) bottom--;
  let left = 0;
  while (left < W && colEmpty(left, top, bottom)) left++;
  let right = W - 1;
  while (right > left && colEmpty(right, top, bottom)) right--;

  const x = Math.max(0, left - margin);
  const y = Math.max(0, top - margin);
  const w = Math.min(W, right + 1 + margin) - x;
  const h = Math.min(H, bottom + 1 + margin) - y;
  const trimmed = W - w + (H - h);
  return trimmed < 4 ? null : { x, y, w, h };
}
