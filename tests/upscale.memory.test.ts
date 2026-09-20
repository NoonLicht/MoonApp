import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Регресс: после апскейла модели должны уходить из памяти (в т.ч. из видеопамяти).
 *
 * Раньше кэш сессий только очищался, а сами ONNX-сессии оставались жить: модель
 * продолжала занимать GPU до выхода из приложения. Теперь движок вызывает
 * `release()` и делает это сразу после последнего задания.
 *
 * Настоящая библиотека ONNX Runtime здесь не нужна: рантайм подменяется заглушкой
 * (`setOrtForTests`), а важное — что сессию отпускают — видно по вызовам release.
 */
const req = createRequire(import.meta.url);
let engine: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-mem-"));
  engine = req("../server/upscale");
});

afterEach(() => {
  // Скачанный каталог — состояние одного теста, а не всего файла.
  fs.rmSync(path.join(process.env.MOONAPP_STORAGE as string, "models", "models.manifest.json"), {
    force: true,
  });
});

/** Заглушка рантайма: «сессия» считает масштаб по входу и рапортует о выгрузке. */
function fakeOrt(released: string[], counter: { created: number }, scale: number): any {
  class FakeTensor {
    data: Float32Array;
    dims: number[];
    constructor(_type: string, data: Float32Array, dims: number[]) {
      this.data = data;
      this.dims = dims;
    }
  }
  return {
    Tensor: FakeTensor,
    InferenceSession: {
      create: async () => {
        const id = `s${++counter.created}`;
        return {
          inputNames: ["input"],
          outputNames: ["output"],
          run: async (feeds: Record<string, FakeTensor>) => {
            const inp = Object.values(feeds)[0];
            const h = inp.dims[2] * scale;
            const w = inp.dims[3] * scale;
            return {
              output: new FakeTensor("float32", new Float32Array(3 * h * w), [1, 3, h, w]),
            };
          },
          release: async () => {
            released.push(id);
          },
        };
      },
    },
    env: { versions: { common: "test" } },
  };
}

/** Каталог из одной модели: движок ищет модель в манифесте, файл подкладываем сами. */
async function catalogWithProbe(scale = 2): Promise<{ url: string; close: () => void }> {
  const http = req("http") as typeof import("http");
  const srv = http.createServer((_q, s) => {
    s.writeHead(200, { "content-type": "application/json" });
    s.end(
      JSON.stringify({
        models: [
          {
            id: "mem-probe",
            label: "Mem Probe",
            file: "mem-probe.onnx",
            scale,
            arch: "rrdb",
            sizeMb: 1,
            license: "BSD-3-Clause",
            url: "http://127.0.0.1:1/mem-probe.onnx",
            tags: ["photo"],
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/models.manifest.json`,
    close: () => srv.close(),
  };
}

const probe = { model: "mem-probe", tile: 0, overlap: 0, threads: 0, provider: "cpu" } as never;
const frame = (): Buffer => Buffer.alloc(4 * 4 * 3, 100);

describe("апскейл: сессии и видеопамять", () => {
  it("clearSessions освобождает модель (release), а не только чистит кэш", async () => {
    const released: string[] = [];
    const counter = { created: 0 };
    const file = path.join(
      process.env.MOONAPP_STORAGE as string,
      "models",
      "upscale",
      "mem-probe.onnx",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "заглушка");
    const srv = await catalogWithProbe(2);
    try {
      engine.setOrtForTests(fakeOrt(released, counter, 2));
      await engine.syncManifest({ url: srv.url, timeoutMs: 5000 });
      await engine.upscaleRgb({ src: frame(), w: 4, h: 4, p: probe });
      expect(counter.created).toBe(1);
      // Сессия создана, но выгрузки ещё не было: модель занимает память устройства.
      expect(released).toEqual([]);
      engine.clearSessions();
      expect(released).toEqual(["s1"]);
      // Кэш действительно очищен: следующая работа создаёт сессию заново.
      await engine.upscaleRgb({ src: frame(), w: 4, h: 4, p: probe });
      expect(counter.created).toBe(2);
      engine.clearSessions();
      expect(released).toEqual(["s1", "s2"]);
    } finally {
      engine.setOrtForTests(null);
      srv.close();
      fs.rmSync(file, { force: true });
    }
  });

  it("после последнего задания модель выгружается сама", async () => {
    const released: string[] = [];
    const counter = { created: 0 };
    const file = path.join(
      process.env.MOONAPP_STORAGE as string,
      "models",
      "upscale",
      "mem-probe.onnx",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "заглушка");
    const srv = await catalogWithProbe(2);
    try {
      engine.setOrtForTests(fakeOrt(released, counter, 2));
      await engine.syncManifest({ url: srv.url, timeoutMs: 5000 });
      // «Посчитали кадр» — сессия лежит в кэше и держит память.
      await engine.upscaleRgb({ src: frame(), w: 4, h: 4, p: probe });
      expect(counter.created).toBe(1);
      expect(released).toEqual([]);
      // Задание заведомо падает (файла нет), но выгрузка обязана произойти.
      const job = engine.startJob({
        inputPath: path.join(path.dirname(file), "нет-такого-файла.mp4"),
        name: "нет-такого-файла.mp4",
      });
      for (let i = 0; i < 160 && job.stage !== "error" && !job.done; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(["error", "done"]).toContain(job.stage);
      expect(released).toEqual(["s1"]);
    } finally {
      engine.setOrtForTests(null);
      srv.close();
      fs.rmSync(file, { force: true });
    }
  });
});
