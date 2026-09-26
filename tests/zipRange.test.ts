import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import zlib from "zlib";
import { createRequire } from "module";

/**
 * server/ts/zipRange.ts: частичное чтение ZIP по HTTP Range (для
 * whisperEngine.ts — переиспользование CUDA-DLL с апскейла вместо повторной
 * закачки всего whisper.cpp-архива). Тест собирает настоящий ZIP-файл в
 * памяти и раздаёт его локальным HTTP-сервером с честной поддержкой Range —
 * так же, как это реально устроено у GitHub Releases (проверено вручную).
 */
const req = createRequire(import.meta.url);
const { listRemoteZipEntries, fetchRemoteZipEntry } = req("../server/zipRange.js") as typeof import("../server/ts/zipRange");

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Собирает валидный ZIP (метод deflate) из { name -> содержимое } — без внешних зависимостей. */
function buildZip(files: Record<string, Buffer>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const compressed = zlib.deflateRawSync(content);
    const crc = crc32(content);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method = deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBuf, compressed]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += localEntry.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const FILES = {
  "Release/small.exe": Buffer.from("i-am-a-tiny-executable-payload".repeat(20)),
  "Release/cudart64_12.dll": Buffer.alloc(5000, 0x42), // «крупная» NVIDIA-библиотека
  "Release/другой-файл.dll": Buffer.from("юникод-имя-и-контент-просто-для-проверки"),
};
const ZIP = buildZip(FILES);

let server: http.Server;
let baseUrl = "";
let rangeRequestsSeen: string[] = [];

beforeAll(async () => {
  server = http.createServer((httpReq, res) => {
    const range = httpReq.headers.range;
    if (httpReq.method === "HEAD") {
      res.writeHead(200, { "content-length": String(ZIP.length), "accept-ranges": "bytes" });
      return res.end();
    }
    if (!range) {
      res.writeHead(200, { "content-length": String(ZIP.length) });
      return res.end(ZIP);
    }
    rangeRequestsSeen.push(range);
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) {
      res.writeHead(416);
      return res.end();
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), ZIP.length - 1);
    const chunk = ZIP.subarray(start, end + 1);
    res.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${ZIP.length}`,
      "content-length": String(chunk.length),
    });
    res.end(chunk);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/archive.zip`;
});

afterAll(() => {
  server.close();
});

describe("zipRange — частичное чтение ZIP по HTTP Range", () => {
  it("listRemoteZipEntries находит все записи с верными размерами", async () => {
    const entries = await listRemoteZipEntries(baseUrl, "test-agent");
    expect(entries.map((e) => e.name).sort()).toEqual(Object.keys(FILES).sort());
    for (const e of entries) {
      expect(e.size).toBe(FILES[e.name as keyof typeof FILES].length);
      expect(e.method).toBe(8); // deflate
    }
    // Central directory читается отдельным диапазоном — не всем архивом.
    expect(rangeRequestsSeen.length).toBeGreaterThan(0);
  });

  it("fetchRemoteZipEntry возвращает точное исходное содержимое (включая юникод-имя)", async () => {
    const entries = await listRemoteZipEntries(baseUrl, "test-agent");
    for (const e of entries) {
      const before = rangeRequestsSeen.length;
      const out = await fetchRemoteZipEntry(baseUrl, e, "test-agent");
      expect(out.equals(FILES[e.name as keyof typeof FILES])).toBe(true);
      // Запись достаётся ОДНИМ Range-запросом (не полным телом архива) —
      // на синтетическом мини-архиве абсолютный размер диапазона не
      // показателен (см. реальный замер на живом релизе whisper.cpp в
      // комментариях zipRange.ts: экономия там ~94%), поэтому здесь
      // проверяем именно факт Range-доступа, а не его размер.
      expect(rangeRequestsSeen.length).toBe(before + 1);
    }
  });

  it("не поддерживающий Range хост даёт понятную ошибку (нет accept-ranges)", async () => {
    const noRangeServer = http.createServer((_r, res) => {
      res.writeHead(200, { "content-length": String(ZIP.length) });
      res.end(ZIP);
    });
    await new Promise<void>((resolve) => noRangeServer.listen(0, "127.0.0.1", resolve));
    const addr = noRangeServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await expect(listRemoteZipEntries(`http://127.0.0.1:${port}/x.zip`, "test-agent")).rejects.toThrow(
      /no_range_support/,
    );
    noRangeServer.close();
  });

  it("повреждённая запись (неверный CRC) — исключение, а не тихий мусор", async () => {
    const entries = await listRemoteZipEntries(baseUrl, "test-agent");
    const bad = { ...entries[0], crc32: entries[0].crc32 ^ 0xffffffff };
    await expect(fetchRemoteZipEntry(baseUrl, bad, "test-agent")).rejects.toThrow(/zip_crc_mismatch/);
  });
});
