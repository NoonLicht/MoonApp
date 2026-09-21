import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

/**
 * Стоп-кран, пачка и пауза: «Стоп» не должен ломать пачку, процессы должны
 * закрываться с первого раза, а пауза — замирать на текущем кадре.
 *
 * Проверки идут против собранного движка (server/upscale.js): `pretest` делает
 * `compile:server`, поэтому тест видит тот же код, что и приложение.
 */
const req = createRequire(import.meta.url);
let engine: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-stop-"));
  engine = req("../server/upscale");
});

afterEach(() => {
  fs.rmSync(path.join(process.env.MOONAPP_STORAGE as string, "models", "models.manifest.json"), {
    force: true,
  });
  engine.clearSessions();
});

const engineSrc = (): string =>
  fs.readFileSync(path.join(process.cwd(), "server", "ts", "upscale.ts"), "utf8");

describe("апскейл: повторная попытка пачки вместо залипания", () => {
  it("batchTries: сначала запрошенный размер, потом вдвое меньше", () => {
    expect(engine.batchTries(8)).toEqual([8, 4]);
    expect(engine.batchTries(64)).toEqual([64, 32]);
    expect(engine.batchTries(4)).toEqual([4, 2]);
    // Меньше двух кадров пачкой не считаем: пробовать нечего.
    expect(engine.batchTries(2)).toEqual([2]);
    expect(engine.batchTries(1)).toEqual([2]);
  });

  it("isBatchMismatch ловит только отказ графа, а не любую ошибку", () => {
    expect(
      engine.isBatchMismatch(
        new Error("Got invalid dimensions for input: input ... index: 0 Got: 64 Expected: 1"),
      ),
    ).toBe(true);
    // Ошибка памяти или выгрузки сессии — это не «модель не умеет пачку».
    expect(engine.isBatchMismatch(new Error("CUDA out of memory"))).toBe(false);
    expect(engine.isBatchMismatch(new Error("Session has been released"))).toBe(false);
    expect(engine.isBatchMismatch(new Error("stopped"))).toBe(false);
  });

  it("исходник: откат на покадровую обработку только по отказу графа", () => {
    const src = engineSrc();
    expect(src).toMatch(/const mismatch = isBatchMismatch\(e\);/);
    expect(src).toContain('"upscale.batch_unsupported" : "upscale.batch_error"');
    // Задание честно сообщает UI, что пачки нет.
    expect(src).toContain('job.batchReason = "unsupported";');
    expect(src).toContain('? "mixed" : "unsupported"');
  });
});

describe("апскейл: выгрузка сессии не рвёт текущий инференс", () => {
  it("clearSessions во время run откладывает release до конца захода", async () => {
    const released: string[] = [];
    let created = 0;
    /** Сессия, чей run завершается только когда тест разрешит. */
    let finishRun: () => void = () => {};
    const runGate = new Promise<void>((r) => {
      finishRun = r;
    });
    const fakeOrt = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: number[],
        ) {}
      },
      InferenceSession: {
        create: async () => {
          created++;
          const id = `s${created}`;
          return {
            inputNames: ["input"],
            outputNames: ["output"],
            async run() {
              await runGate;
              return {
                output: {
                  dims: [1, 3, 8, 8],
                  data: new Float32Array(3 * 8 * 8).fill(0.5),
                  dispose() {},
                },
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

    const file = path.join(
      process.env.MOONAPP_STORAGE as string,
      "models",
      "upscale",
      "mem-probe.onnx",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "заглушка");
    const http = req("http") as typeof import("http");
    const srv = http.createServer((_q: unknown, s: any) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end(
        JSON.stringify({
          models: [
            {
              id: "mem-probe",
              label: "Mem Probe",
              file: "mem-probe.onnx",
              scale: 2,
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
    try {
      engine.setOrtForTests(fakeOrt);
      await engine.syncManifest({ url: `http://127.0.0.1:${port}/m.json`, timeoutMs: 5000 });
      const running = engine.upscaleRgb({
        src: Buffer.alloc(4 * 4 * 3, 100),
        w: 4,
        h: 4,
        p: { model: "mem-probe", tile: 0, overlap: 0, threads: 0, provider: "cpu" },
      });
      // Ждём, пока run действительно начнётся.
      await new Promise((r) => setTimeout(r, 50));
      engine.clearSessions();
      // Стоп во время инференса: release отложен, модель ещё жива.
      expect(released).toEqual([]);
      finishRun();
      await running;
      expect(released).toEqual(["s1"]);
    } finally {
      engine.setOrtForTests(null);
      srv.close();
      fs.rmSync(file, { force: true });
    }
  });
});

describe("апскейл: процессы задания гасятся и не остаются жить", () => {
  /** Долгоживущий процесс-заглушка (как ffmpeg, который не отвечает на сигнал). */
  const longLiving = (): ChildProcess =>
    spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
      windowsHide: true,
      stdio: "ignore",
    });

  const waitClose = (p: ChildProcess, ms = 4000): Promise<boolean> =>
    new Promise((resolve) => {
      if (p.exitCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(p.exitCode !== null), ms);
      p.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  it("killJobProcs убивает зарегистрированные процессы и реестр очищается", async () => {
    const jobId = "proc-test-1";
    const p = longLiving();
    engine.trackJobProc(jobId, "decode", p);
    expect(engine.aliveJobProcs(jobId)).toBe(1);
    const killed = engine.killJobProcs(jobId);
    expect(killed).toBe(1);
    expect(await waitClose(p)).toBe(true);
    // После закрытия процесса реестр пуст: сторож не считает фантомы.
    expect(engine.aliveJobProcs(jobId)).toBe(0);
    expect(engine.killJobProcs(jobId)).toBe(0);
  });

  it("реестр не чистится авансом: второй заход добивает оставшееся", async () => {
    const jobId = "proc-test-2";
    const a = longLiving();
    const b = longLiving();
    engine.trackJobProc(jobId, "decode", a);
    engine.trackJobProc(jobId, "encode", b);
    expect(engine.aliveJobProcs(jobId)).toBe(2);
    engine.killJobProcs(jobId);
    // Ждём оба процесса ОДНОВРЕМЕННО: последовательное ожидание сужало окно второму
    // и на загруженной машине давало ложный отказ (taskkill идёт через очередь).
    const [closedA, closedB] = await Promise.all([waitClose(a, 10000), waitClose(b, 10000)]);
    expect(closedA).toBe(true);
    expect(closedB).toBe(true);
    expect(engine.aliveJobProcs(jobId)).toBe(0);
  });

  it("sweepJobProcs добивает процесс, переживший первый сигнал", async () => {
    const jobId = "proc-test-3";
    const p = longLiving();
    engine.trackJobProc(jobId, "encode", p);
    // Сторож без задержки: ищем живое и гасим сразу (в бою — через 1.5 с).
    const left = engine.sweepJobProcs(jobId, 0);
    expect(left).toBe(1);
    expect(await waitClose(p)).toBe(true);
    expect(engine.aliveJobProcs(jobId)).toBe(0);
  });

  it("контракт: движок убивает всё дерево процессов и ставит сторож", () => {
    const src = engineSrc();
    expect(src).toContain('spawn("taskkill", ["/PID", String(entry.pid), "/T", "/F"]');
    expect(src).toContain("export function sweepJobProcs");
    expect(src).toContain("sweepJobProcs(job.id);");
    expect(src).toContain("      sweepJobProcs(job.id);");
  });

  describe("апскейл: пауза очереди", () => {
    it("пауза и продолжение есть у движка и в API, задание помнит состояние", () => {
      const routes = fs.readFileSync(
        path.join(process.cwd(), "server", "routes", "upscale.js"),
        "utf8",
      );
      expect(routes).toContain('router.post("/pause"');
      expect(routes).toContain('router.post("/resume"');
      expect(routes).toContain('router.post("/:id/pause"');
      expect(routes).toContain('router.post("/:id/resume"');
      const src = engineSrc();
      expect(src).toContain("export function pauseJobs()");
      expect(src).toContain("isPaused: () => job.paused");
      // Пауза ничего не убивает: «Стоп» — это cancelJob, и он отдельный.
      expect(src).toContain("j.paused = true;");
    });

    it("пайплайн проверяет паузу между кадрами и перед пачкой, стоп важнее паузы", () => {
      const src = fs.readFileSync(
        path.join(process.cwd(), "server", "ts", "upscalePipeline.ts"),
        "utf8",
      );
      expect(src).toContain("isPaused?: () => boolean;");
      expect(src).toContain("const waitResume = async (): Promise<void> => {");
      // Стоп во время паузы срабатывает сразу (исходники в CRLF — \r?\n).
      expect(src).toMatch(
        /if \(!opts\.isPaused\?\.\(\)\) return;\r?\n\s+if \(opts\.shouldStop\?\.\(\)\) throw new Error\("stopped"\);/,
      );
      // Стоп проверяется и в самой петле паузы: иначе «Стоп» на паузе висел бы.
      expect(src).toMatch(
        /while \(!failed && opts\.isPaused\?\.\(\)\) \{\r?\n\s+if \(opts\.shouldStop\?\.\(\)\) throw new Error\("stopped"\);/,
      );
      // Гейт стоит и на пачке, и на кадре.
      expect(src).toMatch(
        /await waitResume\(\);\r?\n\s+const take = Math\.min\(batch, queue\.length\);/,
      );
      expect(src).toMatch(
        /const onFrame = async \(rgb: Buffer\): Promise<void> => \{\r?\n\s+await waitResume\(\);/,
      );
    });

    it("UI: маленькая кнопка паузы рядом со «Стоп» и подписи во всех локалях", () => {
      const dash = fs.readFileSync(
        path.join(process.cwd(), "src", "pages", "upscale", "parts", "UpscaleDashboard.tsx"),
        "utf8",
      );
      expect(dash).toContain("onPause");
      expect(dash).toContain('t("up.resume")');
      expect(dash).toContain('t("up.pause")');
      const page = fs.readFileSync(
        path.join(process.cwd(), "src", "pages", "upscale", "UpscalePage.tsx"),
        "utf8",
      );
      expect(page).toContain("api.upscalePause()");
      expect(page).toContain("api.upscaleResume()");
      const client = fs.readFileSync(path.join(process.cwd(), "src", "api", "client.ts"), "utf8");
      // Prettier может перенести `req<...>` на следующую строку — проверяем вызовы.
      expect(client).toMatch(/upscalePause: \(\) =>\s*\n?\s*req</);
      expect(client).toMatch(/upscaleResume: \(\) =>\s*\n?\s*req</);
      for (const loc of ["ru", "en", "fr", "es", "zh", "ar"]) {
        const up = JSON.parse(
          fs.readFileSync(path.join(process.cwd(), "src", "i18n", `${loc}.json`), "utf8"),
        ).up;
        for (const key of ["pause", "resume", "paused"]) {
          expect(typeof up[key], `${loc}.up.${key}`).toBe("string");
          expect(up[key].length).toBeGreaterThan(0);
        }
      }
    });
  });
});
