import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Общее хранилище заданий (server/ts/jobStore.ts -> server/jobStore.js).
 *
 * До фазы 1 один и тот же код (ограничение Map + очередь «одно задание за раз»)
 * лежал тремя копиями в compressor.js, tts.js и sitebak.js. Копии уже разошлись
 * константами, поэтому тесты фиксируют:
 *  1) поведение trimJobs: вытесняются только завершённые/упавшие, самые старые
 *     первыми, и ровно до лимита (незавершённое не трогаем никогда — иначе
 *     пользователь потерял бы прогресс и готовый файл);
 *  2) поведение createQueue: строгая сериализация, ошибка не рвёт очередь;
 *  3) контракт по исходникам: копипаста не вернулась (иначе лимиты и лог-топики
 *     снова разъедутся между движками).
 */
const req = createRequire(import.meta.url);
/**
 * Исходник движка, а не собранный артефакт: перенесённые на TS модули живут в
 * server/ts и компилируются в server/*.js. В артефакте tsc переписывает вызовы
 * (`(0, jobStore_1.createQueue)("compressor")`), поэтому контракт по тексту
 * проверяем по исходнику — иначе проверка ловит форму вывода компилятора.
 */
const readServer = (name: string): string => {
  const ts = new URL(`../server/ts/${name.replace(/\.js$/, ".ts")}`, import.meta.url);
  return fs.readFileSync(
    fs.existsSync(ts) ? ts : new URL(`../server/${name}`, import.meta.url),
    "utf8",
  );
};

/** Именно артефакт сборки, без подмены на исходник. */
const readArtifact = (name: string): string =>
  fs.readFileSync(new URL(`../server/${name}`, import.meta.url), "utf8");

beforeAll(() => {
  // logger берёт путь логов из config при require — уводим их во временный каталог.
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-jobstore-"));
});

function jobStore(): any {
  return req("../server/jobStore");
}

interface Job {
  id: string;
  done?: boolean;
  stage?: string;
  createdAt: number;
}

function makeJobs(list: Job[]): Map<string, Job> {
  return new Map(list.map((j) => [j.id, j]));
}

const done = (id: string, createdAt: number): Job => ({ id, done: true, createdAt });
const failed = (id: string, createdAt: number): Job => ({ id, stage: "error", createdAt });
const running = (id: string, createdAt: number): Job => ({ id, stage: "encode", createdAt });

describe("trimJobs — ограничение хранилища заданий", () => {
  it("ничего не делает, пока заданий не больше лимита", () => {
    const jobs = makeJobs([done("a", 1), done("b", 2), running("c", 3)]);
    jobStore().trimJobs(jobs, 5);
    expect(jobs.size).toBe(3);
    expect([...jobs.keys()]).toEqual(["a", "b", "c"]);
  });

  it("вытесняет завершённые и упавшие, начиная с самых старых", () => {
    const jobs = makeJobs([
      done("old", 1),
      done("old2", 2),
      running("work", 3),
      failed("err", 4),
      running("work2", 5),
    ]);
    jobStore().trimJobs(jobs, 3);
    // Вытеснены старейшие вытесняемые (old, old2); незавершённые и упавшее — нет.
    expect([...jobs.keys()].sort()).toEqual(["err", "work", "work2"]);
  });

  it("не вытесняет незавершённые задания, даже если они старше готовых", () => {
    const jobs = makeJobs([
      running("run1", 1),
      running("run2", 2),
      running("run3", 3),
      done("fin1", 4),
      done("fin2", 5),
    ]);
    jobStore().trimJobs(jobs, 3);
    expect([...jobs.keys()].sort()).toEqual(["run1", "run2", "run3"]);
  });

  it("оставляет Map больше лимита, если вытеснять нечего (прогресс важнее памяти)", () => {
    const jobs = makeJobs([running("r1", 1), running("r2", 2), running("r3", 3), running("r4", 4)]);
    jobStore().trimJobs(jobs, 2);
    expect(jobs.size).toBe(4);
  });

  it("доходит ровно до лимита, сохраняя самые новые", () => {
    const list = Array.from({ length: 10 }, (_, i) => done(`j${i}`, i + 1));
    const jobs = makeJobs(list);
    jobStore().trimJobs(jobs, 4);
    expect(jobs.size).toBe(4);
    expect([...jobs.keys()].sort()).toEqual(["j6", "j7", "j8", "j9"]);
  });
});

/** Ждём выполнения условия: тесты очереди проверяют порядок, а не тайминги. */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("условие не выполнено за отведённое время");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createQueue — одно активное задание за раз", () => {
  it("запускает вторую задачу только после завершения первой", async () => {
    const q = jobStore().createQueue("unit-test");
    const order: string[] = [];
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    q.enqueue(async () => {
      order.push("start1");
      await hold;
      order.push("end1");
    });
    q.enqueue(() => {
      order.push("start2");
    });

    await until(() => order.includes("start1"));
    expect(order).toEqual(["start1"]);
    expect(q.isBusy()).toBe(true);
    expect(q.waiting()).toBe(1);

    release();
    await until(() => order.length === 3);
    expect(order).toEqual(["start1", "end1", "start2"]);
    await until(() => !q.isBusy());
    expect(q.waiting()).toBe(0);
  });

  it("падение задачи не останавливает очередь", async () => {
    const q = jobStore().createQueue("unit-test-error");
    const order: string[] = [];
    q.enqueue(() => {
      throw new Error("boom");
    });
    q.enqueue(() => {
      order.push("second");
    });
    await until(() => order.includes("second"));
    expect(order).toEqual(["second"]);
    await until(() => !q.isBusy());
  });
});

describe("контракт: общий jobStore вместо трёх копий", () => {
  const consumers = ["compressor.js", "tts.js", "sitebak.js"];

  it("каждый движок берёт ограничение Map из общего модуля", () => {
    for (const name of consumers) {
      const src = readServer(name);
      // Перенесённый на TS движок подключает модуль импортом, немигрированный —
      // require-ом; проверяем сам факт зависимости, а не форму записи.
      expect(src, `${name}: нет зависимости от ./jobStore`).toMatch(
        /require\("\.\/jobStore"\)|from "\.\/jobStore"/,
      );
      expect(src, `${name}: вернулась локальная копия trimJobs`).not.toMatch(
        /function trimJobs\s*\(/,
      );
      expect(src, `${name}: trimJobs вызывается без jobs/лимита`).not.toMatch(/trimJobs\(\s*\)/);
    }
  });

  it("очередь с одним слотом не копируется в compressor.js и tts.js", () => {
    for (const name of ["compressor.js", "tts.js"]) {
      const src = readServer(name);
      expect(src, `${name}: вернулась локальная копия очереди`).not.toMatch(
        /function (enqueue|pump)\s*\(/,
      );
    }
    expect(readServer("compressor.js")).toContain('createQueue("compressor")');
    expect(readServer("tts.js")).toContain('createQueue("tts")');
  });

  it("лимиты заданий остались прежними (30/30/20)", () => {
    expect(readServer("compressor.js")).toMatch(/const JOB_LIMIT = 30;/);
    expect(readServer("tts.js")).toMatch(/const JOB_LIMIT = 30;/);
    expect(readServer("sitebak.js")).toMatch(/const JOB_LIMIT = 20;/);
  });

  it("артефакт сборки server/jobStore.js существует (npm run compile:server)", () => {
    const compiled = readArtifact("jobStore.js");
    expect(compiled).toContain("exports.trimJobs");
    expect(compiled).toContain("exports.createQueue");
  });
});
