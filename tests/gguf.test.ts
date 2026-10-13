import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const req = createRequire(import.meta.url);

function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** Синтетический GGUF: только заголовок и метаданные, без тензоров. */
function makeGguf(experts: number | null): string {
  const kvs: Buffer[] = [
    Buffer.concat([str("general.architecture"), u32(8), str("qwen3moe")]),
    Buffer.concat([str("qwen3moe.block_count"), u32(4), u32(48)]),
    // массив строк до tokenizer.* — парсер обязан его пропустить корректно
    Buffer.concat([str("general.tags"), u32(9), u32(8), u64(2), str("a"), str("bb")]),
  ];
  if (experts !== null) kvs.push(Buffer.concat([str("qwen3moe.expert_count"), u32(4), u32(experts)]));
  kvs.push(Buffer.concat([str("tokenizer.ggml.model"), u32(8), str("gpt2")]));
  const head = Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(kvs.length)]);
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-gguf-")), "m.gguf");
  fs.writeFileSync(p, Buffer.concat([head, ...kvs]));
  return p;
}

describe("определение MoE по метаданным GGUF", () => {
  it("expert_count > 0 — MoE, независимо от имени файла", () => {
    const { readGgufInfo } = req("../server/llamacpp/gguf");
    expect(readGgufInfo(makeGguf(128))).toEqual({ arch: "qwen3moe", experts: 128 });
  });

  it("без expert_count — обычная модель", () => {
    const { readGgufInfo } = req("../server/llamacpp/gguf");
    expect(readGgufInfo(makeGguf(null))).toEqual({ arch: "qwen3moe", experts: 0 });
  });

  it("не GGUF — null", () => {
    const { readGgufInfo } = req("../server/llamacpp/gguf");
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-gguf-")), "x.gguf");
    fs.writeFileSync(p, "not a gguf file at all");
    expect(readGgufInfo(p)).toBeNull();
  });
});
