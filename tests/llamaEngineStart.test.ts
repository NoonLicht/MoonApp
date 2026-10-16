import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Запуск серверов llama.cpp (server/ts/llamacpp/engine.ts) на подставном llama-server.exe.
 *
 * Подставной сервер — крошечная C#-программа (собирается PowerShell Add-Type): отдаёт /health,
 * пишет метки времени запуска/готовности/выхода в журнал и умеет падать так же, как настоящий:
 *   • модель с «oom» в имени на GPU-сборке — «cudaMalloc failed: out of memory»;
 *   • FAKE_CUDA_BROKEN=1 — «ggml_cuda_init: failed» (неисправна сама сборка).
 * Проверяем то, что раньше ломалось на видеокарте: один сбой навсегда отключал CUDA и Vulkan,
 * две загрузки шли одновременно, а перезагрузка не ждала выхода старого процесса.
 */

const WIN = process.platform === "win32";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-llama-"));
const LOG = path.join(tmp, "fake.log");
const EXE_SRC = path.join(os.tmpdir(), "moonapp-fake-llama-server.exe");

const CS = `
using System; using System.IO; using System.Net; using System.Threading;
class P {
  static void Main(string[] a) {
    string model = ""; int port = 0;
    for (int i = 0; i < a.Length; i++) { if (a[i] == "-m") model = a[i + 1]; if (a[i] == "--port") port = int.Parse(a[i + 1]); }
    string log = Environment.GetEnvironmentVariable("FAKE_LLAMA_LOG");
    Action<string> w = s => { if (log != null) File.AppendAllText(log, DateTime.UtcNow.Ticks + " " + s + "\\n"); };
    string exe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName.ToLowerInvariant();
    bool gpu = exe.Contains("\\\\cuda\\\\") || exe.Contains("\\\\vulkan\\\\");
    string name = Path.GetFileName(model).ToLowerInvariant();
    w("start " + name + (gpu ? " gpu" : " cpu"));
    if (gpu && name.Contains("oom")) {
      Console.Error.WriteLine("ggml_backend_cuda_buffer_type_alloc_buffer: allocating 20000 MiB on device 0: cudaMalloc failed: out of memory");
      Console.Error.WriteLine("srv load_model: failed to load model");
      w("fail-oom"); Environment.Exit(1);
    }
    if (exe.Contains("\\\\cuda\\\\") && Environment.GetEnvironmentVariable("FAKE_CUDA_BROKEN") == "1") {
      Console.Error.WriteLine("ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected");
      w("fail-build"); Environment.Exit(1);
    }
    int ms = int.Parse(Environment.GetEnvironmentVariable("FAKE_LLAMA_LOAD_MS") ?? "300");
    Thread.Sleep(ms);
    var l = new HttpListener(); l.Prefixes.Add("http://127.0.0.1:" + port + "/"); l.Start();
    AppDomain.CurrentDomain.ProcessExit += (s, e) => w("exit " + name);
    w("ready " + name);
    while (true) {
      var c = l.GetContext(); var b = System.Text.Encoding.UTF8.GetBytes("{\\"status\\":\\"ok\\"}");
      c.Response.OutputStream.Write(b, 0, b.Length); c.Response.Close();
    }
  }
}`;

interface Engine {
  ensureServer(o: Record<string, unknown>): Promise<{ build: string; gpu: boolean; model: string }>;
  stopServer(file?: string): void;
  settled(): Promise<void>;
  badBuilds(): string[];
  clearBadBuilds(): void;
  loadFailures(): { file: string; code: string }[];
  clearFailure(file?: string): void;
  loadedServers(): { file: string; build: string }[];
  configureEngine(o: { limit?: () => number }): void;
  classifyFault(t: string): string;
}

let eng: Engine;

function install(build: "cpu" | "cuda"): void {
  const dir = path.join(tmp, "llama", "builds", build);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(EXE_SRC, path.join(dir, "llama-server.exe"));
  fs.writeFileSync(path.join(dir, "installed.json"), "{}");
}

const model = (n: string): string => {
  const f = path.join(tmp, "models", n);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "x");
  return f;
};

/** Строки журнала подставного сервера: [тики, событие]. */
function events(): [bigint, string][] {
  if (!fs.existsSync(LOG)) return [];
  return fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(" ");
      return [BigInt(l.slice(0, i)), l.slice(i + 1)] as [bigint, string];
    });
}

beforeAll(async () => {
  if (!WIN) return;
  process.env.MOONAPP_STORAGE = tmp;
  process.env.FAKE_LLAMA_LOG = LOG;
  if (!fs.existsSync(EXE_SRC)) {
    const cs = path.join(tmp, "fake.cs");
    fs.writeFileSync(cs, CS);
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -TypeDefinition (Get-Content -Raw '${cs}') -OutputAssembly '${EXE_SRC}' -OutputType ConsoleApplication -ReferencedAssemblies System.dll`,
      ],
      { timeout: 60_000 },
    );
  }
  install("cpu");
  install("cuda");
  eng = (await import("../server/llamacpp/engine")) as unknown as Engine;
  eng.configureEngine({ limit: () => 8 });
}, 90_000);

beforeEach(() => {
  if (!WIN) return;
  delete process.env.FAKE_CUDA_BROKEN;
  process.env.FAKE_LLAMA_LOAD_MS = "300";
  eng.stopServer();
  eng.clearBadBuilds();
  eng.clearFailure();
  fs.rmSync(LOG, { force: true });
});

describe.skipIf(!WIN)("engine — запуск серверов", () => {
  it("классификация сбоев: память, сборка, остальное", () => {
    expect(eng.classifyFault("cudaMalloc failed: out of memory")).toBe("memory");
    expect(eng.classifyFault("ggml_cuda_init: failed to initialize CUDA")).toBe("build");
    expect(eng.classifyFault("spawn_failed: spawn EPERM")).toBe("build");
    expect(eng.classifyFault("error loading model: tensor 'x' has wrong shape")).toBe("model");
    expect(eng.classifyFault("llama_start_timeout")).toBe("model");
  });

  it("не хватило видеопамяти: модель уходит на процессор, а CUDA НЕ отключается", async () => {
    const r = await eng.ensureServer({ model: model("big-oom.gguf"), device: "auto" });
    expect(r.build).toBe("cpu");
    expect(r.gpu).toBe(false);
    expect(eng.badBuilds()).toEqual([]);
    // следующая (обычная) модель по-прежнему идёт на видеокарту — раньше после сбоя шла на CPU
    const ok = await eng.ensureServer({ model: model("small.gguf"), device: "auto" });
    expect(ok.build).toBe("cuda");
    expect(ok.gpu).toBe(true);
  }, 60_000);

  it("явное «видеокарта» без памяти: понятная ошибка, а не тихий процессор", async () => {
    await expect(
      eng.ensureServer({ model: model("huge-oom.gguf"), device: "gpu" }),
    ).rejects.toThrow(/llama_start_failed/);
    const f = eng.loadFailures().find((x) => x.file === "huge-oom.gguf");
    expect(f?.code).toBe("memory");
    expect(eng.badBuilds()).toEqual([]);
  }, 60_000);

  it("неисправная сборка CUDA отключается ненадолго и возвращается по кнопке", async () => {
    process.env.FAKE_CUDA_BROKEN = "1";
    const r = await eng.ensureServer({ model: model("a.gguf"), device: "auto" });
    expect(r.build).toBe("cpu");
    expect(eng.badBuilds()).toContain("cuda");
    eng.stopServer();
    await eng.settled();
    delete process.env.FAKE_CUDA_BROKEN;
    eng.clearBadBuilds();
    const again = await eng.ensureServer({ model: model("a.gguf"), device: "auto" });
    expect(again.build).toBe("cuda");
  }, 60_000);

  it("явное «видеокарта» при отключённой сборке: код gpu_build_failed", async () => {
    process.env.FAKE_CUDA_BROKEN = "1";
    await expect(eng.ensureServer({ model: model("b.gguf"), device: "gpu" })).rejects.toThrow();
    const f = eng.loadFailures().find((x) => x.file === "b.gguf");
    expect(["build", "gpu_build_failed"]).toContain(f?.code);
  }, 60_000);

  it("две модели одновременно грузятся по очереди, а не вместе", async () => {
    process.env.FAKE_LLAMA_LOAD_MS = "600";
    await Promise.all([
      eng.ensureServer({ model: model("m1.gguf"), device: "auto" }),
      eng.ensureServer({ model: model("m2.gguf"), device: "auto" }),
    ]);
    const ev = events();
    const readyFirst = ev.find(([, e]) => e.startsWith("ready"))!;
    const starts = ev.filter(([, e]) => e.startsWith("start"));
    expect(starts.length).toBeGreaterThanOrEqual(2);
    // второй запуск начался только после готовности первого
    expect(starts[1][0] > readyFirst[0]).toBe(true);
  }, 60_000);

  it("перезагрузка ждёт выхода старого процесса, прежде чем стартовать новый", async () => {
    const file = model("reload.gguf");
    await eng.ensureServer({ model: file, device: "auto" });
    eng.stopServer("reload.gguf");
    await eng.ensureServer({ model: file, device: "auto" });
    const ev = events().map(([t, e]) => [t, e] as const);
    const exitAt = ev.find(([, e]) => e.startsWith("exit"))?.[0];
    const starts = ev.filter(([, e]) => e.startsWith("start reload"));
    expect(starts.length).toBe(2);
    if (exitAt) expect(starts[1][0] > exitAt).toBe(true);
  }, 60_000);

  it("испорченный исполняемый файл: ошибка запуска без падения процесса, сборка отключается", async () => {
    const exe = path.join(tmp, "llama", "builds", "cuda", "llama-server.exe");
    const keep = fs.readFileSync(exe);
    eng.stopServer();
    await eng.settled();
    fs.writeFileSync(exe, "not an executable");
    try {
      // раньше у spawn не было обработчика 'error' — такой запуск валил весь серверный процесс
      const r = await eng.ensureServer({ model: model("c.gguf"), device: "auto" });
      expect(r.build).toBe("cpu");
      expect(eng.badBuilds()).toContain("cuda");
    } finally {
      eng.stopServer();
      await eng.settled();
      fs.writeFileSync(exe, keep);
    }
  }, 60_000);
});
