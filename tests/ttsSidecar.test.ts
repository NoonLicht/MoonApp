import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import EventEmitter from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Протокол сайдкара озвучки и язык движка (server/ts/tts.ts).
 *
 * Что здесь ловится — три ошибки, которые ломали рендер целиком:
 *
 *   1. Язык. Он был настраиваемым: выпадающий список в интерфейсе, ключ
 *      `voice.defaultLanguage` в настройках (по умолчанию «English») и поле
 *      `language` в голосовых профилях. XTTS язык текста не определяет — он
 *      читает кириллицу фонемами того языка, который ему передали, поэтому
 *      русская книга уезжала в модель как английская («character limit of 250
 *      for language 'en'» в логе) и звучала тарабарщиной. Теперь язык зашит
 *      (TTS_LANGUAGE) и не берётся ни из запроса, ни из настроек: тест требует,
 *      чтобы даже `language: "English"` в задании давало «ru».
 *
 *   2. Ответ сайдкара. Движок после каждого инференса шлёт ДВА сообщения —
 *      телеметрию `vram` и результат `done`, — а конвейер считал ответом «следующее
 *      сообщение». Запросы разъезжались на одно сообщение: чанк объявлялся готовым,
 *      пока движок ещё считал, и склейка падала с «Error opening input file
 *      chunk_0002.wav: No such file or directory». Тест требует, чтобы следующий
 *      чанк отправлялся только после `done` предыдущего.
 *
 *   3. Снятие процесса. Раньше python оставался жить после ошибки (модель висела в
 *      VRAM). Теперь процесс снимается всегда — на ошибке это видно по вызову
 *      `taskkill /pid <pid> /T /F` (тот же приём, что при отмене установки).
 *
 * python и ffmpeg подменены заглушками: тест не качает модели и ничего не считает —
 * он проверяет именно протокол.
 */
const req = createRequire(import.meta.url);

describe("Протокол сайдкара озвучки (server/tts.js)", () => {
  let tts: any;
  let settings: any;
  let cp: any;
  let storage = "";
  /** Все вызовы spawn: [cmd, ...args]. */
  let calls: string[][] = [];
  /** Окружение, с которым запускали дочерние процессы (3-й аргумент spawn). */
  let spawnEnv: Array<Record<string, string | undefined>> = [];
  /** Когда конвейер отправил каждый инференс (мс) — по ним видно рассинхрон. */
  let inferAt: number[] = [];
  /** Что отвечать на инференс: результат или ошибка. */
  let inferReply: "done" | "error" = "done";
  /** Задержка ответа: имитирует время счёта чанка. */
  const INFER_MS = 120;
  /** Сколько раз запускали рабочий процесс ударений (ruaccent_worker.py). */
  let stressSpawns = 0;
  /** Запросы load к рабочему процессу ударений (модель и режим). */
  let stressLoads: any[] = [];
  /** Запросы accent: какие тексты уезжали на расстановку ударений. */
  let stressRequests: any[] = [];
  /** Запросы unload: модели должны выгружаться после задания. */
  let stressUnloads = 0;
  /** Что отвечает рабочий процесс ударений: модели или ошибка (нет ruaccent). */
  let stressReply: "ready" | "error" = "ready";
  /** Тексты, которые получил движок на инференс (проверяем формат ударений). */
  let inferTexts: string[] = [];

  /** Ждать состояния задания (done/error) с таймаутом. */
  async function waitJob(id: string, ms = 8000): Promise<any> {
    const t0 = Date.now();
    for (;;) {
      const job = tts.getJob(id);
      if (job && (job.done || job.stage === "error")) return job;
      if (Date.now() - t0 > ms) throw new Error("задание не завершилось: " + job?.stage);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeAll(() => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-tts-sidecar-"));
    process.env.MOONAPP_STORAGE = storage;
    fs.mkdirSync(path.join(storage, "tts"), { recursive: true });
    fs.writeFileSync(path.join(storage, "tts", "ref_test.mp3"), "RIFF");

    settings = req("../server/settings");
    tts = req("../server/tts");

    cp = require("child_process");
    cp.spawn = (cmd: string, args: string[] = [], opts: any = {}) => {
      calls.push([cmd, ...args]);
      spawnEnv.push(opts?.env || {});
      const joined = args.join(" ");
      const child: any = new EventEmitter();
      child.pid = 2000 + calls.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      // EventEmitter не умеет setEncoding — сайдкар вызывает его для stdout/stderr.
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      child.kill = () => {
        child.killed = true;
      };
      const emit = (obj: unknown, delay = 0) => {
        setTimeout(() => child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n")), delay);
      };

      // Автоопределение ffmpeg идёт через execFile, а не spawn — без этой заглушки
      // detectFfmpeg() честно не находил бы ffmpeg и рендер падал с ffmpeg_missing.
      cp.execFile = (cmd: string, args: string[], a: any, b?: any) => {
        const cb = typeof a === "function" ? a : b;
        calls.push([cmd, ...args]);
        setTimeout(() => cb(null, "ffmpeg version 7.1-full_build\n", ""), 5);
        return { on() {}, kill() {} };
      };

      if (joined.includes("python_env.py")) {
        // Проба окружения: JSON, как у server/engines/python_env.py. close нужен
        // обязательно: проба читает ответ до закрытия процесса.
        emit(
          {
            python: "3.11.9",
            executable: "python",
            modules: { torch: true, torchaudio: true, f5_tts: true, TTS: true },
          },
          5,
        );
        setTimeout(() => child.emit("close", 0), 10);
        return child;
      }
      if (joined.includes("ruaccent_worker.py")) {
        // Заглушка рабочего процесса ударений: отвечает по протоколу, но моделей
        // не грузит. «Ударения» помечаются плюсом перед гласной — ровно в том
        // формате, который отдаёт настоящий RUAccent и ждёт русская модель F5.
        stressSpawns++;
        child.stdin = {
          write: (payload: string) => {
            for (const line of String(payload).split("\n")) {
              if (!line.trim()) continue;
              let msg: any;
              try {
                msg = JSON.parse(line);
              } catch {
                continue;
              }
              if (msg.type === "load") {
                stressLoads.push(msg);
                emit(
                  stressReply === "error"
                    ? { type: "error", message: "ruaccent_not_installed: No module named 'ruaccent'" }
                    : { type: "ready", model: msg.model, version: "1.5.8.3", dict: msg.dict, tiny: msg.tiny, sec: 6.1 },
                  5,
                );
              } else if (msg.type === "accent") {
                stressRequests.push(msg);
                emit(
                  stressReply === "error"
                    ? { type: "error", id: msg.id, message: "ruaccent_not_installed: no module" }
                    : {
                        type: "accented",
                        id: msg.id,
                        texts: (msg.texts as string[]).map((t) => t.replace(/[аеёиоуыэюя]/gi, (v) => "+" + v)),
                      },
                  5,
                );
              } else if (msg.type === "unload") {
                stressUnloads++;
                emit({ type: "unloaded" }, 5);
              }
              // shutdown игнорируется: проверяем принудительное снятие процесса.
            }
          },
        };
        return child;
      }
      if (joined.includes("f5_wrapper.py") || joined.includes("xtts_wrapper.py")) {
        // Заглушка сайдкара: отвечает по протоколу, но ничего не считает.
        child.stdin = {
          write: (payload: string) => {
            for (const line of String(payload).split("\n")) {
              if (!line.trim()) continue;
              let msg: any;
              try {
                msg = JSON.parse(line);
              } catch {
                continue;
              }
              if (msg.type === "init") {
                emit({ type: "ready", device: "cuda:0", vramGb: 8 }, 5);
                // Телеметрия сразу после ready — раньше именно она «съедала»
                // ответ на первый инференс.
                emit({ type: "vram", usedGb: 1, totalGb: 8, utilPct: 0 }, 10);
              } else if (msg.type === "infer") {
                inferAt.push(Date.now());
                inferTexts.push(String(msg.text || ""));
                if (msg.out) {
                  fs.mkdirSync(path.dirname(String(msg.out)), { recursive: true });
                  fs.writeFileSync(String(msg.out), "RIFF");
                }
                emit({ type: "vram", usedGb: 2, totalGb: 8, utilPct: 40 }, 5);
                emit(
                  inferReply === "error"
                    ? { type: "error", message: "engine_boom: cuda out of memory" }
                    : { type: "done", out: msg.out, sec: INFER_MS / 1000 },
                  INFER_MS,
                );
              }
              // shutdown намеренно игнорируется: проверяем принудительное снятие.
            }
          },
        };
        return child;
      }
      // ffmpeg: version для автоопределения, склейка и мастеринг — создаём выходной
      // файл, как это сделал бы настоящий ffmpeg. Процесс закрываем ВСЕГДА: без
      // close автоопределение ffmpeg ждало бы свой таймаут и очередь заданий
      // оставалась бы занятой.
      setTimeout(() => {
        if (joined.includes("-version")) {
          child.stdout.emit("data", Buffer.from("ffmpeg version 7.1-full_build\n"));
        } else {
          const out = args[args.length - 1] || "";
          if (/\.(wav|mp3|m4b)$/i.test(out)) {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, "RIFF");
          }
        }
        child.emit("close", 0);
      }, 5);
      return child;
    };
  });
  afterAll(() => {
    try {
      fs.rmSync(storage, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  beforeEach(() => {
    calls = [];
    inferAt = [];
    spawnEnv = [];
    inferReply = "done";
    stressSpawns = 0;
    stressLoads = [];
    stressRequests = [];
    stressUnloads = 0;
    stressReply = "ready";
    inferTexts = [];
    settings.set({ voice: { pythonCmd: "python", format: "wav" } });
  });

  it("сайдкар запускается с UTF-8 окружением", async () => {
    // Это половина исправления «тарабарщины»: python с присоединённым конвейером
    // (stdio: pipe) читает stdin в кодировке локали Windows — cp1251 на русской
    // системе. Русский текст книжки превращался в крякозябры ещё до модели:
    // 108 символов становились 196 (столько занимают его UTF-8 байты, прочитанные
    // как cp1251), движок честно озвучивал этот мусор, а на выходе была бессвязица
    // вместо русского — при верном языке, верных параметрах и верной модели.
    // Вторая половина — py_audio.force_utf8 внутри сайдкара (см. контракт ниже).
    const job = tts.startJob({
      engine: "xtts",
      refFile: "ref_test.mp3",
      format: "wav",
      title: "тест",
      chunks: ["Привет."],
    });
    await waitJob(job.id);
    const python = spawnEnv.find((e) => e.PYTHONIOENCODING);
    expect(python, "спавн python с UTF-8 окружением").toBeTruthy();
    expect(python!.PYTHONIOENCODING).toBe("utf-8");
    expect(python!.PYTHONUTF8).toBe("1");
  });

  it("язык озвучки всегда русский, чем бы его ни задавали", async () => {
    // Старые сборки интерфейса, сохранённые профили и настройки присылали
    // НАЗВАНИЕ языка — и в настройках по умолчанию стояло «English». Именно из-за
    // этого русская книга считалась английской моделью. Теперь поле принимается
    // (чтобы старый клиент не ломал запуск), но ни на что не влияет.
    settings.set({ voice: { defaultLanguage: "English", language: "English" } });
    const job = tts.startJob({
      engine: "xtts",
      refFile: "ref_test.mp3",
      language: "English",
      format: "wav",
      title: "тест",
      chunks: ["Привет."],
    });
    expect(job.opts.language).toBe("ru");
    // Задание дожидаемся: оно идёт в фоне и иначе дописало бы счётчики следующего
    // теста (очередь озвучки — один слот, следующий тест ждал бы его же).
    await waitJob(job.id);
  });

  it("следующий чанк считается только после ответа done (телеметрия vram — не ответ)", async () => {
    const job = tts.startJob({
      engine: "f5",
      refFile: "ref_test.mp3",
      format: "wav",
      title: "тест",
      chunks: [
        { text: "Первая фраза." },
        { text: "Вторая фраза." },
        { text: "", pauseMs: 500 },
        { text: "Третья фраза." },
      ],
    });
    const done = await waitJob(job.id);
    // Второй аргумент expect — текст ошибки задания при провале проверки.
    expect(done.stage, done.error).toBe("done");
    // Чистая пауза движком не считается: три инференса на четыре чанка.
    expect(inferAt.length).toBe(3);
    // Главное: между соседними инференсами прошло время счёта. При старом
    // «ответ = следующее сообщение» они уходили подряд за миллисекунды, и склейка
    // потом искала ещё не записанный chunk_0002.wav.
    for (let i = 1; i < inferAt.length; i++) {
      expect(inferAt[i] - inferAt[i - 1]).toBeGreaterThanOrEqual(INFER_MS - 20);
    }
    // Телеметрия VRAM из «лишних» сообщений доехала до задания.
    expect(done.vram?.usedGb).toBe(2);
    // Процесс сайдкара снимается и после успешного задания: сначала вежливый
    // shutdown, через 500 мс — taskkill по дереву (поэтому ждём).
    await new Promise((r) => setTimeout(r, 650));
    expect(calls.some((c) => c[0] === "taskkill" && c.includes("/T"))).toBe(true);
  }, 30000);

  it("при ошибке процесс python снимается принудительно", async () => {
    inferReply = "error";
    const job = tts.startJob({
      engine: "xtts",
      refFile: "ref_test.mp3",
      format: "wav",
      title: "тест",
      chunks: [{ text: "Фраза, на которой движок падает." }],
    });
    const failed = await waitJob(job.id);
    expect(failed.stage).toBe("error");
    // Текст ошибки движка доходит до задания без искажений.
    expect(failed.error).toContain("engine_boom");
    expect(failed.done).toBe(false);
    // shutdown + через 500 мс taskkill по дереву процессов: процесс не остаётся.
    await new Promise((r) => setTimeout(r, 700));
    const kill = calls.find((c) => c[0] === "taskkill");
    expect(kill, "taskkill по дереву процессов сайдкара").toBeTruthy();
    expect(kill!.includes("/F")).toBe(true);
  }, 30000);

  it("готовый чанк длиннее лимита движка режется по границам фраз", async () => {
    // Сценарий из жизни: в Batch Editor два чанка «объединили», и рендер XTTS
    // падал посреди задания с «❗ XTTS can only generate text with a maximum of
    // 400 tokens». Лимит у XTTS — 400 токенов (~690 символов русского), а чанк из
    // UI приходит готовым и раньше вообще не проверялся: LIMIT применялся только
    // к автонарезке текста.
    const phrase =
      "Это проверка очень длинного текста для озвучки книги, и она должна " +
      "проверить, что задание больше не падает на лимите токенов. ";
    const long = phrase.repeat(6).trim(); // ~756 символов — больше лимита XTTS
    const job = tts.startJob({
      engine: "xtts",
      refFile: "ref_test.mp3",
      format: "wav",
      title: "тест",
      chunks: [{ text: long, pauseMs: 500 }],
    });
    // У XTTS лимит чанка 220 символов — длинный текст разложился на части.
    expect(job.chunksTotal).toBeGreaterThan(1);
    const done = await waitJob(job.id);
    expect(done.stage, done.error).toBe("done");
    // Каждая часть действительно посчитана движком — ни одна не потерялась.
    expect(inferAt.length).toBe(job.chunksTotal);
  }, 30000);

  /* ------------------ Ударения по смыслу (RUAccent) ------------------ */

  /**
   * Второй, необязательный шаг задания: расстановка ударений нейросетью RUAccent.
   *
   * Тумблер «Ударения» включает отдельный python-процесс
   * (server/engines/ruaccent_worker.py), тексты уезжают в движок в формате «+»
   * перед ударной гласной (его ждёт русская модель F5), модели выгружаются после
   * задания, а недоступность RUAccent НЕ роняет рендер — озвучка идёт на исходных
   * текстах. Причина в этом случае остаётся в задании (job.stress) и в логе.
   */

  /** Задание из одного чанка: рендер F5 с тумблером ударений или без. */
  function runChunk(markStress: boolean) {
    return tts.startJob({
      engine: "f5",
      refFile: "ref_test.mp3",
      format: "wav",
      title: "тест",
      chunks: ["На двери висит замок."],
      markStress,
    });
  }

  it("с тумблером «Ударения» текст уезжает в движок в формате «+»", async () => {
    const done = await waitJob(runChunk(true).id);
    expect(done.stage, done.error).toBe("done");
    expect(stressSpawns).toBe(1);
    // Модель и режим берутся из настроек (voice.stressModel / voice.stressLite).
    expect(stressLoads[0].model).toBe("tiny2.1");
    expect(stressLoads[0].tiny).toBe(true);
    // Ударения дошли до движка: «замок» → «з+амок».
    expect(inferTexts[0]).toMatch(/\+[аеёиоуыэюя]/i);
    // Модели выгружаются после задания: держать их в памяти незачем.
    expect(stressUnloads).toBeGreaterThan(0);
    expect(done.stress).toEqual({ requested: true, applied: true, reason: "" });
  });

  it("без тумблера рабочий процесс ударений не запускается вовсе", async () => {
    const done = await waitJob(runChunk(false).id);
    expect(done.stage, done.error).toBe("done");
    expect(stressSpawns).toBe(0);
    expect(inferTexts[0]).toBe("На двери висит замок.");
    expect(done.stress).toEqual({ requested: false, applied: false, reason: "" });
  });

  it("RUAccent недоступен — рендер продолжается без ударений", async () => {
    // Нет библиотеки: python отвечает ошибкой на load. Это НЕ ошибка рендера —
    // озвучка идёт на исходных текстах, а причина попадает в задание и лог.
    stressReply = "error";
    const done = await waitJob(runChunk(true).id);
    expect(done.stage, done.error).toBe("done");
    expect(inferTexts[0]).toBe("На двери висит замок.");
    expect(done.stress.applied).toBe(false);
    expect(String(done.stress.reason)).toContain("ruaccent_not_installed");
  });

  it("после неудачи повторная попытка не раньше чем через STRESS_RETRY_MS", async () => {
    stressReply = "error";
    const first = await waitJob(runChunk(true).id);
    expect(first.stress.applied).toBe(false);
    const spawnsAfterFirst = stressSpawns;
    // Второе задание не должно снова ждать недоступный процесс (пауза 10 минут):
    // иначе каждое задание начиналось бы с таймаута недоступной сети.
    const second = await waitJob(runChunk(true).id);
    expect(second.stage, second.error).toBe("done");
    expect(stressSpawns).toBe(spawnsAfterFirst);
  });
});

/**
 * Вторая половина исправления кодировки — внутри сайдкара.
 *
 * Node отдаёт протокол в UTF-8, а python с присоединённым конвейером читает stdin
 * в кодировке локали (cp1251 на русской Windows). Поэтому сайдкар ОБЯЗАН сам
 * переключить потоки до чтения протокола, иначе русский текст книги приезжает
 * крякозябрами и движок озвучивает мусор (108 символов текста выглядели как 196).
 * Проверяем именно контракт исходников: сам факт вызова и то, что он стоит ДО
 * цикла чтения stdin — иначе тест прошёл бы при «мёртвом» вызове после протокола.
 */
describe("Кодировка протокола сайдкара (контракт server/engines)", () => {
  const enginesDir = path.resolve(__dirname, "../server/engines");
  const read = (f: string): string => fs.readFileSync(path.join(enginesDir, f), "utf8");

  it("py_audio умеет переводить потоки в UTF-8", () => {
    const src = read("py_audio.py");
    expect(src).toContain("def force_utf8");
    expect(src).toContain('reconfigure(encoding="utf-8"');
  });

  it("оба сайдкара вызывают force_utf8() до чтения stdin", () => {
    for (const f of ["f5_wrapper.py", "xtts_wrapper.py"]) {
      const src = read(f);
      expect(src, `${f}: импорт force_utf8`).toContain("from py_audio import force_utf8");
      const main = src.slice(src.indexOf("def main():"));
      const call = main.indexOf("force_utf8()");
      const loop = main.indexOf("for line in sys.stdin");
      expect(call, `${f}: force_utf8() вызывается в main()`).toBeGreaterThan(0);
      expect(call, `${f}: вызов стоит ДО чтения протокола`).toBeLessThan(loop);
    }
  });
});
