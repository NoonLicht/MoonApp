/**
 * Частичное чтение ZIP по HTTP Range — без скачивания архива целиком.
 *
 * Зачем: релизы whisper.cpp с CUDA (whisper-cublas-*.zip) на 90%+ состоят из
 * NVIDIA-библиотек рантайма (cublasLt64_12.dll там сам по себе ~310 МБ из
 * ~420 МБ архива) — а точно такие же по имени DLL (cudart64_12/cublas64_12/
 * cublasLt64_12/nvrtc64_120_0, см. scripts/fetch-cuda-libs.js) уже могли быть
 * скачаны для GPU-пака апскейла (storage/ort-gpu). Если так — эти файлы можно
 * не качать повторно, взяв уже имеющуюся копию, а из архива по HTTP Range
 * вытащить только маленькие файлы самого whisper.cpp (exe/ggml*.dll).
 *
 * Формат ZIP так и устроен: в конце файла — центральный каталог (список всех
 * записей + их точные смещения), поэтому достаточно прочитать «хвост» файла
 * Range-запросом, а затем — Range-запросом же — только нужные записи по их
 * смещению. GitHub Releases (через release-assets.githubusercontent.com)
 * Range поддерживает (Accept-Ranges: bytes) — проверено вручную на реальном
 * релизе whisper.cpp.
 *
 * ZIP64 (архивы > 4ГБ) не поддерживается: whisper.cpp-релизы меньше, а для
 * любого несовпадения формата функции просто бросают исключение — вызывающий
 * код (whisperEngine.ts) обязан ловить его и откатываться на обычную полную
 * закачку архива.
 */
import zlib from "zlib";

export interface RemoteZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  crc32: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

async function rangeGet(url: string, start: number, end: number, userAgent: string): Promise<Buffer> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": userAgent, Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status !== 206) throw new Error(`zip_range_http_${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Читает центральный каталог удалённого ZIP по HTTP Range, не скачивая архив
 * целиком. Бросает исключение, если хост не поддерживает Range, или формат
 * архива не тот, что ожидается (ZIP64, повреждённый EOCD и т.п.) — в этом
 * случае вызывающий код должен откатиться на обычное скачивание.
 */
export async function listRemoteZipEntries(url: string, userAgent: string): Promise<RemoteZipEntry[]> {
  const head = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(30_000),
  });
  if (!head.ok) throw new Error(`zip_head_http_${head.status}`);
  if ((head.headers.get("accept-ranges") || "").toLowerCase() !== "bytes") {
    throw new Error("zip_no_range_support");
  }
  const total = Number(head.headers.get("content-length") || 0);
  if (!total) throw new Error("zip_no_content_length");

  // EOCD (22 байта) + комментарий (до 65535 байт) — хвоста с запасом хватает
  // почти всегда одним запросом, без отдельного похода за самим EOCD.
  const tailLen = Math.min(66000, total);
  const tail = await rangeGet(url, total - tailLen, total - 1, userAgent);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip_eocd_not_found");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error("zip64_not_supported");

  const tailStart = total - tailLen;
  const cdBuf =
    cdOffset >= tailStart
      ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : await rangeGet(url, cdOffset, cdOffset + cdSize - 1, userAgent);

  const entries: RemoteZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cdBuf.length) {
    if (cdBuf.readUInt32LE(p) !== CD_SIG) break;
    const method = cdBuf.readUInt16LE(p + 10);
    const crc32 = cdBuf.readUInt32LE(p + 16);
    const compSize = cdBuf.readUInt32LE(p + 20);
    const size = cdBuf.readUInt32LE(p + 24);
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const commentLen = cdBuf.readUInt16LE(p + 32);
    const localOffset = cdBuf.readUInt32LE(p + 42);
    if (localOffset === 0xffffffff || compSize === 0xffffffff) throw new Error("zip64_not_supported");
    const name = cdBuf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, size, crc32, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new Error("zip_no_entries");
  return entries;
}

/**
 * Скачивает и распаковывает ОДНУ запись архива по HTTP Range (без остального
 * архива), проверяет длину и CRC32 результата. Бросает исключение при любом
 * несовпадении — частичный/повреждённый результат никогда не возвращается.
 */
export async function fetchRemoteZipEntry(
  url: string,
  entry: RemoteZipEntry,
  userAgent: string,
): Promise<Buffer> {
  // Локальный заголовок дублирует имя файла и может нести свой extra-field
  // (обычно короче/иначе, чем в центральном каталоге) — с запасом, чтобы не
  // делать второй Range-запрос ради самого заголовка.
  const margin = 512;
  const start = entry.localOffset;
  const end = entry.localOffset + 30 + entry.name.length * 2 + margin + entry.compSize;
  const raw = await rangeGet(url, start, end, userAgent);
  if (raw.readUInt32LE(0) !== LOCAL_SIG) throw new Error("zip_bad_local_header");
  const n2 = raw.readUInt16LE(26);
  const m2 = raw.readUInt16LE(28);
  const dataStart = 30 + n2 + m2;
  if (raw.length < dataStart + entry.compSize) throw new Error("zip_short_read");
  const compData = raw.subarray(dataStart, dataStart + entry.compSize);
  let out: Buffer;
  if (entry.method === 0) out = Buffer.from(compData);
  else if (entry.method === 8) out = zlib.inflateRawSync(compData);
  else throw new Error(`zip_unsupported_method_${entry.method}`);
  if (out.length !== entry.size) throw new Error("zip_size_mismatch");
  // zlib.crc32 — в Node с 20.12/21.0; если рантайм старее, ограничиваемся
  // проверкой длины (уже сделана выше) вместо падения на отсутствующем API.
  const crc32Fn = (zlib as unknown as { crc32?: (data: Uint8Array) => number }).crc32;
  if (typeof crc32Fn === "function" && (crc32Fn(out) >>> 0) !== (entry.crc32 >>> 0)) {
    throw new Error("zip_crc_mismatch");
  }
  return out;
}
