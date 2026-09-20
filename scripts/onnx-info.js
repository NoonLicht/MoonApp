"use strict";

/**
 * Что внутри .onnx: имена и формы входов/выходов + opset.
 *
 * Нужен при добавлении модели в server/models.manifest.json: по форме входа
 * видно раскладку тензора (NCHW [1,3,h,w] или NHWC [1,h,w,3]), а по именам —
 * поддерживает ли наш движок эту модель («detectInterpSig» ждёт img0/img1/
 * timestep, frame0/frame1 или один input).
 *
 * Protobuf разбираем сами: тянуть onnx-пакеты ради заголовка не хочется.
 *
 * Использование:
 *   node scripts/onnx-info.js storage/models/upscale/realesr-general-x4v3.onnx
 *   node scripts/onnx-info.js https://example.com/model.onnx
 */

const fs = require("fs");
const path = require("path");

/** Поля protobuf верхнего уровня: {no, wire, value|bytes}. */
function fields(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p < end) {
    let tag = 0;
    let shift = 0;
    while (p < end) {
      const b = buf[p++];
      tag += (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const no = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v = 0;
      let s = 0;
      while (p < end) {
        const b = buf[p++];
        v += (b & 0x7f) << s;
        s += 7;
        if (!(b & 0x80)) break;
      }
      out.push({ no, wire, value: v });
    } else if (wire === 2) {
      let len = 0;
      let s = 0;
      while (p < end) {
        const b = buf[p++];
        len += (b & 0x7f) << s;
        s += 7;
        if (!(b & 0x80)) break;
      }
      out.push({ no, wire, value: buf.subarray(p, p + len) });
      p += len;
    } else if (wire === 5) {
      p += 4;
      out.push({ no, wire });
    } else if (wire === 1) {
      p += 8;
      out.push({ no, wire });
    } else {
      throw new Error(`неизвестный wire ${wire} (позиция ${p})`);
    }
  }
  return out;
}

const pick = (list, no) => list.filter((f) => f.no === no);
const str = (f) => (f && f.wire === 2 ? f.value.toString("utf8") : "");

/** Имя, elem_type и форма одного ValueInfoProto. */
function valueInfo(vi) {
  const v = fields(vi.value);
  const type = pick(v, 2)[0];
  const out = { name: str(pick(v, 1)[0]), elem: -1, dims: [], param: [] };
  if (!type) return out;
  const tensor = pick(fields(type.value), 1)[0];
  if (!tensor) return out;
  const tf = fields(tensor.value);
  const et = pick(tf, 1)[0];
  if (et) out.elem = et.value;
  const shape = pick(tf, 2)[0];
  for (const d of shape ? pick(fields(shape.value), 1) : []) {
    const df = fields(d.value);
    const value = pick(df, 1)[0];
    const param = pick(df, 2)[0];
    out.dims.push(value ? value.value : -1);
    out.param.push(str(param));
  }
  return out;
}

const ELEM = { 1: "float32", 2: "uint8", 3: "int8", 6: "int32", 7: "int64", 10: "float16" };

/** Печать входов/выходов графа (без весов-инициализаторов). */
function describe(buf, label) {
  const graph = pick(fields(buf), 7)[0];
  if (!graph) {
    console.log(`${label}: это не ONNX-модель (нет GraphProto)`);
    return;
  }
  const g = fields(graph.value);
  const opset = pick(fields(buf), 8)
    .map((o) => pick(fields(o.value), 2)[0])
    .filter(Boolean)
    .map((v) => v.value)
    .join(",");
  // У TensorProto (инициализатора) имя лежит в поле 8, у ValueInfoProto — в 1.
  const weights = new Set(pick(g, 5).map((i) => str(pick(fields(i.value), 8)[0])));
  console.log(`${label}  opset=${opset || "?"}`);
  for (const [tag, field] of [
    ["вход", 11],
    ["выход", 12],
  ]) {
    for (const vi of pick(g, field)) {
      const t = valueInfo(vi);
      if (weights.has(t.name)) continue;
      const param = t.param.filter(Boolean).join(",");
      const shape = t.dims.map((d) => (d < 0 ? "?" : d)).join("x");
      console.log(
        `  ${tag}: ${t.name} [${shape}] ${ELEM[t.elem] || t.elem}${param ? ` (${param})` : ""}`,
      );
    }
  }
  // Подсказка по раскладке: у NCHW третьим идёт 3 или «каналы», у NHWC — четвёртым.
  for (const vi of pick(g, 11)) {
    const t = valueInfo(vi);
    if (weights.has(t.name) || t.dims.length !== 4) continue;
    const layout =
      t.dims[1] === 3 ? "NCHW (плоская)" : t.dims[3] === 3 ? "NHWC (перемешанная)" : "?";
    console.log(`  раскладка входа «${t.name}»: ${layout}`);
    break;
  }
}

async function read(src) {
  if (/^https?:/i.test(src)) {
    const res = await fetch(src, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(src);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!args.length) {
    console.log("использование: node scripts/onnx-info.js <файл.onnx|URL> [...]");
    process.exit(1);
  }
  for (const src of args) {
    try {
      const buf = await read(src);
      describe(buf, /^https?:/i.test(src) ? src.split("/").pop() : path.basename(src));
    } catch (e) {
      console.log(`${src}: ошибка — ${String(e.message || e).slice(0, 120)}`);
    }
  }
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
