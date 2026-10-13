/**
 * Минимальный разбор заголовка GGUF: нужен один факт — есть ли у модели эксперты (MoE).
 * В метаданных это ключ `<arch>.expert_count`; у обычных моделей его нет или он равен 0.
 * Читаем только начало файла: ключи архитектуры идут раньше токенизатора, поэтому на
 * `tokenizer.*` можно остановиться — длинные массивы словаря не разбираем.
 */
import fs from "fs";

const T = {
  U8: 0,
  I8: 1,
  U16: 2,
  I16: 3,
  U32: 4,
  I32: 5,
  F32: 6,
  BOOL: 7,
  STR: 8,
  ARR: 9,
  U64: 10,
  I64: 11,
  F64: 12,
} as const;

const SIZE: Record<number, number> = {
  [T.U8]: 1,
  [T.I8]: 1,
  [T.U16]: 2,
  [T.I16]: 2,
  [T.U32]: 4,
  [T.I32]: 4,
  [T.F32]: 4,
  [T.BOOL]: 1,
  [T.U64]: 8,
  [T.I64]: 8,
  [T.F64]: 8,
};

/** Чтение файла кусками с позицией: GGUF разбирается последовательно. */
class Reader {
  private buf = Buffer.alloc(0);
  private bufPos = 0; // позиция buf[0] в файле
  private pos = 0;
  constructor(
    private fd: number,
    private limit: number,
  ) {}
  private ensure(n: number): void {
    if (this.pos + n > this.limit) throw new Error("gguf_limit");
    const end = this.pos + n;
    if (this.pos >= this.bufPos && end <= this.bufPos + this.buf.length) return;
    const size = Math.max(n, 1 << 20);
    const b = Buffer.alloc(size);
    const got = fs.readSync(this.fd, b, 0, size, this.pos);
    if (got < n) throw new Error("gguf_eof");
    this.buf = b.subarray(0, got);
    this.bufPos = this.pos;
  }
  skip(n: number): void {
    if (this.pos + n > this.limit) throw new Error("gguf_limit");
    this.pos += n;
  }
  u32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.pos - this.bufPos);
    this.pos += 4;
    return v;
  }
  u64(): number {
    this.ensure(8);
    const v = Number(this.buf.readBigUInt64LE(this.pos - this.bufPos));
    this.pos += 8;
    return v;
  }
  str(maxLen = 4096): string {
    const len = this.u64();
    if (len > maxLen) {
      this.skip(len);
      return "";
    }
    this.ensure(len);
    const s = this.buf.toString("utf8", this.pos - this.bufPos, this.pos - this.bufPos + len);
    this.pos += len;
    return s;
  }
  /** Значение скалярного типа числом (для expert_count и т. п.). */
  scalar(type: number): number {
    this.ensure(SIZE[type]);
    const o = this.pos - this.bufPos;
    let v = 0;
    switch (type) {
      case T.U8:
      case T.BOOL:
        v = this.buf.readUInt8(o);
        break;
      case T.I8:
        v = this.buf.readInt8(o);
        break;
      case T.U16:
        v = this.buf.readUInt16LE(o);
        break;
      case T.I16:
        v = this.buf.readInt16LE(o);
        break;
      case T.U32:
        v = this.buf.readUInt32LE(o);
        break;
      case T.I32:
        v = this.buf.readInt32LE(o);
        break;
      case T.F32:
        v = this.buf.readFloatLE(o);
        break;
      case T.U64:
        v = Number(this.buf.readBigUInt64LE(o));
        break;
      case T.I64:
        v = Number(this.buf.readBigInt64LE(o));
        break;
      case T.F64:
        v = this.buf.readDoubleLE(o);
        break;
    }
    this.pos += SIZE[type];
    return v;
  }
  skipValue(type: number): void {
    if (SIZE[type]) return this.skip(SIZE[type]);
    if (type === T.STR) {
      this.skip(this.u64());
      return;
    }
    if (type === T.ARR) {
      const inner = this.u32();
      const n = this.u64();
      if (SIZE[inner]) return this.skip(SIZE[inner] * n);
      for (let i = 0; i < n; i++) this.skipValue(inner);
      return;
    }
    throw new Error("gguf_type");
  }
}

export interface GgufInfo {
  arch: string;
  /** Число экспертов; 0 — обычная (dense) модель. */
  experts: number;
}

/** Читает архитектуру и число экспертов из заголовка. null — файл не GGUF или не читается. */
export function readGgufInfo(file: string): GgufInfo | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const r = new Reader(fd, 64 * 1024 * 1024);
    if (r.u32() !== 0x46554747) return null; // "GGUF"
    r.u32(); // версия
    r.u64(); // число тензоров
    const kv = r.u64();
    let arch = "";
    let experts = 0;
    for (let i = 0; i < kv; i++) {
      const key = r.str();
      const type = r.u32();
      if (key.startsWith("tokenizer.")) break; // дальше только словарь
      if (key === "general.architecture" && type === T.STR) {
        arch = r.str();
        continue;
      }
      if (key.endsWith(".expert_count") && SIZE[type]) {
        experts = r.scalar(type);
        continue;
      }
      r.skipValue(type);
    }
    return { arch, experts };
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* уже закрыт */
      }
    }
  }
}

const cache = new Map<string, { sig: string; info: GgufInfo | null }>();

/** То же с кэшем по размеру и времени изменения файла. */
export function ggufInfo(file: string): GgufInfo | null {
  try {
    const st = fs.statSync(file);
    const sig = `${st.size}:${st.mtimeMs}`;
    const hit = cache.get(file);
    if (hit && hit.sig === sig) return hit.info;
    const info = readGgufInfo(file);
    cache.set(file, { sig, info });
    return info;
  } catch {
    return null;
  }
}
