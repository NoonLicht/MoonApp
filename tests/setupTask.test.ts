import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Машина состояния задачи установки (server/ts/setupTask.ts -> server/setupTask.js).
 *
 * До фазы 1 ровно эта логика лежала двумя копиями: whisperEngine.js (модель или
 * сборка Whisper) и diarize.js (пакеты sherpa-onnx). Копии расходились топиком
 * лога и сбросом флага отмены, а прогресс скачивания считался одной и той же
 * формулой в четырёх местах. Тесты фиксируют:
 *  1) поведение: busy/done/error/отмена, формулу процента и сброс флага отмены
 *     при старте новой задачи (иначе отмена прошлой обрывает новое скачивание);
 *  2) контракт по исходникам: копии не вернулись и оба движка берут состояние из
 *     общего модуля.
 */
const req = createRequire(import.meta.url);
const readServer = (name: string): string =>
  fs.readFileSync(new URL(`../server/${name}`, import.meta.url), "utf8");

beforeAll(() => {
  // logger берёт путь логов из config при require — уводим их во временный каталог.
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-setuptask-"));
});

function setupTask(): any {
  return req("../server/setupTask");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSetupTask — состояние и переходы", () => {
  it("стартует в idle", () => {
    const t = setupTask().createSetupTask("unit-test");
    expect(t.snapshot()).toMatchObject({
      kind: null,
      state: "idle",
      id: null,
      progress: 0,
      phase: "",
      error: "",
      received: 0,
      total: 0,
    });
    expect(t.isWorking()).toBe(false);
    expect(t.shouldCancel()).toBe(false);
  });

  it("reset переводит задачу в working с фазой download", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "small");
    expect(t.isWorking()).toBe(true);
    expect(t.snapshot()).toMatchObject({
      kind: "model",
      id: "small",
      state: "working",
      phase: "download",
      progress: 0,
      error: "",
    });
    expect(t.snapshot().at).toBeGreaterThan(0);
  });

  it("state — живая ссылка на состояние (в неё пишут фазу на месте)", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("build", null);
    t.state.phase = "extract";
    expect(t.snapshot().phase).toBe("extract");
  });

  it("done ставит 100% и очищает фазу, isWorking становится false", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "m");
    t.setDownloadProgress(5, 10);
    t.done();
    expect(t.snapshot()).toMatchObject({ state: "done", phase: "", progress: 100 });
    expect(t.isWorking()).toBe(false);
  });
});

describe("createSetupTask — ошибки", () => {
  it("fail берёт message из ошибки и логирует топик <topic>.task.error", () => {
    const logger = req("../server/logger");
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const t = setupTask().createSetupTask("diarize");
    t.reset("package", "seg");
    t.fail(new Error("нет сети"));

    expect(t.snapshot()).toMatchObject({ state: "error", phase: "", error: "нет сети" });
    expect(t.isWorking()).toBe(false);
    expect(spy).toHaveBeenCalledWith("diarize.task.error", {
      kind: "package",
      id: "seg",
      error: "нет сети",
    });
  });

  it("fail с пустым message откатывается к String(e), а не к «»", () => {
    const logger = req("../server/logger");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const t = setupTask().createSetupTask("whisperEngine");
    t.reset("model", "m");
    t.fail({ message: "" });
    expect(t.snapshot().error).toBe("[object Object]");
  });
});

describe("createSetupTask — отмена", () => {
  it("cancel поднимает флаг только для работающей задачи", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.cancel();
    expect(t.shouldCancel()).toBe(false);

    t.reset("model", "m");
    const snap = t.cancel();
    expect(t.shouldCancel()).toBe(true);
    expect(snap).toMatchObject({ state: "working", kind: "model" });
  });

  it("новая задача сбрасывает флаг отмены прошлой", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "first");
    t.cancel();
    expect(t.shouldCancel()).toBe(true);

    t.reset("package", "second");
    expect(t.shouldCancel()).toBe(false);
    expect(t.snapshot()).toMatchObject({ kind: "package", id: "second" });
  });

  it("cancel не завершает задачу — её гасит сам поток скачивания", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "m");
    t.cancel();
    expect(t.isWorking()).toBe(true);
  });
});

describe("createSetupTask — прогресс скачивания", () => {
  it("считает процент от объёма и пишет received/total в состояние", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "m");
    t.setDownloadProgress(25, 200);
    expect(t.snapshot()).toMatchObject({ received: 25, total: 200, progress: 13 });
  });

  it("округляет до целого процента", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "m");
    t.setDownloadProgress(1, 3);
    expect(t.snapshot().progress).toBe(33);
  });

  it("не выходит за 100% при переполнении счётчика", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "m");
    t.setDownloadProgress(300, 200);
    expect(t.snapshot().progress).toBe(100);
  });

  it("без известного объёма (total = 0, сервер не отдал Content-Length) процент = 0", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "m");
    t.setDownloadProgress(123, 0);
    expect(t.snapshot()).toMatchObject({ received: 123, total: 0, progress: 0 });
  });

  it("после done прогресс не сбивается доигравшим колбэком", () => {
    const t = setupTask().createSetupTask("unit-test");
    t.reset("model", "m");
    t.setDownloadProgress(90, 100);
    t.done();
    t.setDownloadProgress(100, 100);
    expect(t.snapshot()).toMatchObject({ state: "done", progress: 100 });
  });
});

describe("контракт: общая машина состояния вместо двух копий", () => {
  const consumers = ["whisperEngine.js", "diarize.js"];

  it.each(consumers)("%s берёт состояние из server/setupTask", (name) => {
    const src = readServer(name);
    expect(src).toContain('require("./setupTask")');
    expect(src, "вернулась локальная копия машины состояния").not.toMatch(
      /function (resetTask|failTask|doneTask|cancelTask|taskSnapshot)\s*\(/,
    );
    expect(src, "вернулся локальный литерал состояния").not.toMatch(/let task = \{\s*\n\s*kind:/);
    expect(src, "вернулся локальный флаг отмены").not.toMatch(/cancelFlag/);
  });

  it("каждый движок создаёт свою задачу (состояния не общие)", () => {
    expect(readServer("whisperEngine.js")).toContain('createSetupTask("whisperEngine")');
    expect(readServer("diarize.js")).toContain('createSetupTask("diarize")');
  });

  it("прямые записи в task.* остались (иначе фазы установки пропали бы)", () => {
    // Потребители пишут фазу и обнуляют прогресс на месте — контракт «живой ссылки».
    expect(readServer("whisperEngine.js")).toMatch(/task\.phase = "/);
    expect(readServer("diarize.js")).toMatch(/task\.phase = "/);
  });

  it("формула процента не дублируется в движках", () => {
    for (const name of consumers) {
      expect(readServer(name), `${name}: формула прогресса вернулась локально`).not.toMatch(
        /Math\.round\(\(100 \* received\) \/ total\)/,
      );
    }
  });
});
