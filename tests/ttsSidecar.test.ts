import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import EventEmitter from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Протокол сайдкара озвучки и язык движка (server/ts/tts.ts).
 *
 * Что здесь ловится — две ошибки, которые ломали рендер целиком:
 *
 *   1. Язык. Интерфейс отдаёт названия («Russian», «Chinese»), они же лежат в
 *      настройках и голосовых профилях, а XTTS принимает только коды и падал с
 *      «Language 'Russian' is not supported». Проверяем перевод названий в коды.
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
  /** Когда конвейер отправил каждый инференс (мс) — по ним видно рассинхрон. */
  let inferAt: number[] = [];
  /** Что отвечать на инференс: результат или ошибка. */
  let inferReply: "done" | "error" = "done";
  /** Задержка ответа: имитирует время счёта чанка. */
  const INFER_MS = 120;

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
    cp.spawn = (cmd: string, args: string[] = []) => {
      calls.push([cmd, ...args]);
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
      if (joined.includes("f5_wrapper.py") || joined.includes("xtts_wrapper.py")) {
        // Заглушка сайдкара: отвечает по протоколу, но ничего не считает.
        child.stdin = {
          write: (payload: string) => {
            for (const line of String(payload).split("\n")) {
              if (!line.trim()) continue;
              let msg: any = {};
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
                if (msg.out) {
                  fs.mkdirSync(path.dirname(String(msg.out)), { recursive: true });
                  fs.writeFileSync(String(msg.out), "RIFF");
                }
                emit({ type: "vram", usedGb: 2, totalGb: 8, utilPct: 40 }, 5);
                emit(
                  inferReply === "error"
                    ? { type: "error", message: "language_not_supported: 'klingon'" }
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
    inferReply = "done";
    settings.set({ voice: { pythonCmd: "python", format: "wav", language: "Russian" } });
  });

  it("язык интерфейса превращается в код XTTS", () => {
    // Названия из выпадающего списка (и из уже сохранённых настроек).
    expect(tts.langCode("Russian")).toBe("ru");
    expect(tts.langCode("English")).toBe("en");
    // У XTTS китайский именно zh-cn: с «zh» модель отвечает «не поддерживается».
    expect(tts.langCode("Chinese")).toBe("zh-cn");
    expect(tts.langCode("zh")).toBe("zh-cn");
    // Код остаётся кодом, регистр не важен, пустое значение — русский.
    expect(tts.langCode("RU")).toBe("ru");
    expect(tts.langCode("")).toBe("ru");
    expect(tts.langCode(undefined)).toBe("ru");
    // Неизвестное отдаём как есть: ошибку про язык покажет сам движок.
    expect(tts.langCode("Klingon")).toBe("klingon");
  });

  it("в задание язык попадает кодом, а не названием", async () => {
    const job = tts.startJob({
      engine: "xtts",
      refFile: "ref_test.mp3",
      language: "Russian",
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
      language: "Russian",
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
      language: "Russian",
      format: "wav",
      title: "тест",
      chunks: [{ text: "Фраза, на которой движок падает." }],
    });
    const failed = await waitJob(job.id);
    expect(failed.stage).toBe("error");
    expect(failed.error).toContain("language_not_supported");
    expect(failed.done).toBe(false);
    // shutdown + через 500 мс taskkill по дереву процессов: процесс не остаётся.
    await new Promise((r) => setTimeout(r, 700));
    const kill = calls.find((c) => c[0] === "taskkill");
    expect(kill, "taskkill по дереву процессов сайдкара").toBeTruthy();
    expect(kill!.includes("/F")).toBe(true);
  }, 30000);
});
