import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execFileSync } from "child_process";
import { createRequire } from "module";

/**
 * GPU-пак: индекс, установка ступени и удаление.
 *
 * Проверки идут против собранного модуля (server/ortPack.js): `pretest` делает
 * `compile:server`, поэтому тест видит тот же код, что и приложение. Архивы для
 * установки собираются крошечные (zip из нескольких файлов) — важно, что путь
 * «скачал → проверил sha256 → распаковал → проверил состав» работает целиком.
 */
const req = createRequire(import.meta.url);
let pack: any;
let engine: any;
let storage: string;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-pack-"));
  process.env.MOONAPP_STORAGE = storage;
  pack = req("../server/ortPack");
  engine = req("../server/upscale");
});

afterAll(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

/** Каталог пака, куда ставится ступень (совпадает с тем, что читает движок). */
const packDir = () => path.join(storage, "ort-gpu", `${process.platform}-${process.arch}`);

/** Крошечный zip с заданным содержимым: имитация архива пака. */
function makeZip(files: Record<string, string>): string {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "pa-pack-src-"));
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(src, name), content);
  const zip = path.join(
    os.tmpdir(),
    `pa-pack-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  execFileSync("tar", ["-a", "-c", "-f", zip, "-C", src, "."]);
  fs.rmSync(src, { recursive: true, force: true });
  return zip;
}

/** Локальный HTTP-сервер отдаёт то, что положим (индекс и/или архив). */
function serve(routes: Record<string, { body: string | Buffer; type?: string }>) {
  const srv = http.createServer((q: any, s: any) => {
    const hit = routes[q.url || ""];
    if (!hit) {
      s.writeHead(404).end();
      return;
    }
    s.writeHead(200, { "content-type": hit.type || "application/json" });
    s.end(hit.body);
  });
  return srv;
}

describe("индекс паков", () => {
  it("читает ступени и разворачивает относительные ссылки", async () => {
    const srv = serve({
      "/gpu-packs.json": {
        body: JSON.stringify({
          version: "0.3.0",
          ort: "1.30.0",
          cuda: "12.9",
          tensorrt: "10.14.1",
          requires: "NVIDIA, драйвер ≥ 528",
          steps: [
            { id: "cuda", title: "CUDA", file: "pack-cuda.zip", mb: 1470, url: "pack-cuda.zip" },
            { id: "tensorrt", title: "TensorRT", url: "sub/pack-trt.zip", sha256: "AB" },
          ],
        }),
      },
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const idx = await pack.fetchIndex(`http://127.0.0.1:${port}/gpu-packs.json`);
      expect(idx.ort).toBe("1.30.0");
      expect(idx.steps.length).toBe(2);
      // Ссылка на архив рядом с индексом превращается в абсолютную.
      expect(idx.steps[0].url).toBe(`http://127.0.0.1:${port}/pack-cuda.zip`);
      // Имя файла выводится из url, если явно не задано; sha256 — в нижнем регистре.
      expect(idx.steps[1].file).toBe("pack-trt.zip");
      expect(idx.steps[1].sha256).toBe("ab");
    } finally {
      srv.close();
    }
  });

  it("битый индекс — понятная ошибка, а не падение", async () => {
    const srv = serve({ "/bad.json": { body: JSON.stringify({ steps: [] }) } });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      await expect(pack.fetchIndex(`http://127.0.0.1:${port}/bad.json`)).rejects.toThrow(
        /pack_index_failed/,
      );
      await expect(pack.fetchIndex(`http://127.0.0.1:${port}/нет.json`)).rejects.toThrow(
        /pack_index_failed/,
      );
    } finally {
      srv.close();
    }
  });
});

describe("установка ступени", () => {
  /** Что обязано быть внутри архива CUDA-ступени (тест кладёт то же самое). */
  const CUDA_FILES = {
    "onnxruntime_binding.node": "bin",
    "onnxruntime.dll": "dll",
    "onnxruntime_providers_cuda.dll": "provider",
  };
  /** Шаг с локальным архивом: так проверяется весь путь без сети. */
  const step = (zip: string, sha256 = "", id = "cuda") => ({
    id,
    title: id,
    file: path.basename(zip),
    mb: 1,
    url: zip,
    sha256,
  });

  it("локальный архив распаковывается, состав проверяется, архив не остаётся в кэше", async () => {
    const zip = makeZip(CUDA_FILES);
    const r = await pack.installStep(step(zip));
    expect(r.ok).toBe(true);
    for (const f of pack.requiredFiles("cuda")) {
      expect(fs.existsSync(path.join(packDir(), f)), f).toBe(true);
    }
    expect(pack.packStates().cuda.state).toBe("done");
    expect(fs.existsSync(path.join(storage, "ort-gpu", ".cache", path.basename(zip)))).toBe(false);
    // Движок видит пак тем же путём (это тот же каталог, что читает upscale.ts).
    expect(engine.packStatus().installed).toBe(true);
    expect(pack.packBusy()).toBe("");
  });

  it("несовпадение sha256 — установка останавливается до распаковки", async () => {
    const zip = makeZip(CUDA_FILES);
    await expect(pack.installStep(step(zip, "0".repeat(64)))).rejects.toThrow(/pack_sha_mismatch/);
    expect(pack.packStates().cuda.state).toBe("error");
    // Архив не задерживается в кэше: повторная попытка начнётся с чистого листа.
    expect(fs.existsSync(path.join(storage, "ort-gpu", ".cache", path.basename(zip)))).toBe(false);
  });

  it("архив без нужных файлов отвергается с понятной причиной", async () => {
    const zip = makeZip({ "README.txt": "это не пак" });
    await expect(pack.installStep(step(zip))).rejects.toThrow(/pack_files_missing/);
    expect(pack.packStates().cuda.error).toContain("pack_files_missing");
  });

  it("вторая ступень требует библиотеки TensorRT", async () => {
    expect(pack.requiredFiles("tensorrt")).toEqual([
      "onnxruntime_providers_tensorrt.dll",
      "nvinfer_10.dll",
    ]);
    const zip = makeZip({
      "onnxruntime_providers_tensorrt.dll": "trt",
      "nvinfer_10.dll": "nvinfer",
    });
    const r = await pack.installStep(step(zip, "", "tensorrt"));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(packDir(), "nvinfer_10.dll"))).toBe(true);
  });

  it("отменять нечего, когда установка не идёт", () => {
    expect(pack.cancelPackInstall()).toEqual({ ok: false });
  });
});

describe("удаление пака", () => {
  it("исчезает только пак и кэш, соседние файлы остаются", () => {
    // Сосед в storage/ort-gpu: раньше удаление пака сносило весь каталог ort-gpu
    // вместе с ним (это и заметили на раздаточных архивах рядом).
    const neighbor = path.join(storage, "ort-gpu", "dist", "gpu-packs.json");
    fs.mkdirSync(path.dirname(neighbor), { recursive: true });
    fs.writeFileSync(neighbor, "{}");
    const r = pack.removePack();
    expect(r.ok).toBe(true);
    // Размер считаем в МБ: в тестовом архиве файлы крошечные, поэтому «не меньше нуля».
    expect(r.mb).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(packDir())).toBe(false);
    expect(fs.existsSync(neighbor), "соседний файл удалён вместе с паком").toBe(true);
    expect(engine.packStatus().installed).toBe(false);
    expect(pack.packStates()).toEqual({});
  });
});
