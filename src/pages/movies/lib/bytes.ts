/**
 * Человекочитаемые размеры и скорости — общие для плеера и вкладки «Скачанные».
 *
 * Почему отдельный модуль: раньше fmtBytes/fmtSpeed были локальными в
 * PlayerModal, а вкладке загрузок нужны те же цифры. Дублировать формат нельзя:
 * «1.5 GB» и «1500 MB» в одном интерфейсе выглядят как разные величины.
 * Чистые функции — покрыты tests/movieStreamUrl.test.ts.
 */

/** Байты → «1.5 GB» / «750 MB» / «0 B». */
export function fmtBytes(n?: number | null): string {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Байты в секунду → «1.5 MB/s». */
export function fmtSpeed(bps?: number | null): string {
  return `${fmtBytes(bps || 0)}/s`;
}

/** Секунды до конца загрузки → «1:23» / «45 с» / «—» (0/NaN — время неизвестно). */
export function fmtEta(sec?: number | null): string {
  const s = Math.floor(Number(sec) || 0);
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}