/**
 * Изолированные Python-инструменты страницы «Фото и видео»: InvSR (диффузионный апскейл)
 * и Deep-Live-Cam (замена лица).
 *
 * Каждому инструмент даётся СВОЙ портативный Python внутри storage/photo/py/<id>/python
 * (на Windows — embeddable-сборка python.org, на других ОС — venv из системного python) и свой
 * каталог исходников repo/. Общее окружение озвучки (F5/XTTS/Chatterbox) не трогаем: у этих
 * проектов жёсткие, несовместимые между собой пины (InvSR — transformers 4.37 и свой форк
 * diffusers, Deep-Live-Cam — numpy 2 и onnxruntime-gpu).
 *
 * Установка идёт шагами в общую задачу (setupTask) с хвостом лога — как установка движков озвучки.
 * Запуск — обычным процессом `python <скрипт> <аргументы>` с разбором строк вывода.
 */
import { spawn, type ChildProcess } from "child_process";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import settings from "../settings";
import { downloadToFile } from "../download";
import { createSetupTask } from "../setupTask";
import type { SetupTaskState } from "../setupTask";
import { PHOTO_DIR } from "./modelStore";

export type ToolId = "invsr" | "faceswap" | "chatterbox";
export type ToolDevice = "cuda" | "cpu";

const PY_ENV = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
const GET_PIP = "https://bootstrap.pypa.io/get-pip.py";
const TORCH_INDEX: Record<ToolDevice, string> = {
  // cu128 — первый индекс с колёсами под Blackwell (RTX 50): sm_120
  cuda: "https://download.pytorch.org/whl/cu128",
  cpu: "https://download.pytorch.org/whl/cpu",
};

export interface Step {
  id: string;
  /** pip-аргументы; пусто — шаг выполняется кодом. */
  pip?: string[];
  approxMb: number;
  /** Рабочий каталог шага (по умолчанию — repo). */
  inRepo?: boolean;
}

export interface ToolDef {
  id: ToolId;
  title: string;
  license: string;
  /** Версия портативного Python. */
  python: string;
  /** Нужен ли каталог исходников (zip репозитория). */
  repo: boolean;
  zipUrl: string;
  /** Модули, наличие которых означает «окружение готово». */
  modules: string[];
  steps(device: ToolDevice): Step[];
  /** Ориентировочный объём всего (для подписи на кнопке). */
  sizeMb(device: ToolDevice): number;
  /** Что на веб-странице сказать о лицензии. */
  note: string;
}

const TORCH_PKGS = ["torch", "torchvision"];

export const TOOLS: Record<ToolId, ToolDef> = {
  invsr: {
    id: "invsr",
    title: "InvSR",
    license: "NTU S-Lab 1.0",
    python: "3.10.11",
    repo: true,
    zipUrl: "https://github.com/zsyOAOA/InvSR/archive/refs/heads/master.zip",
    modules: ["torch", "diffusers", "omegaconf"],
    note: "Код и веса InvSR — NTU S-Lab License 1.0 (некоммерческое использование); SD-Turbo — отдельная лицензия Stability AI.",
    steps: (device) => [
      { id: "python", approxMb: 11 },
      { id: "getpip", approxMb: 3 },
      { id: "repo", approxMb: 20 },
      {
        id: "torch",
        pip: [...TORCH_PKGS, "--index-url", TORCH_INDEX[device]],
        approxMb: device === "cpu" ? 250 : 2800,
      },
      // форк diffusers лежит в самом репозитории (setup.py) и ставится из него
      { id: "package", pip: ["-e", ".[torch]"], approxMb: 150, inRepo: true },
      {
        id: "deps",
        pip: [
          "omegaconf",
          "loguru",
          "einops",
          "python-box",
          "sentencepiece",
          "protobuf",
          "opencv-python-headless",
          "albumentations==1.4.18",
          "transformers==4.37.2",
          "huggingface_hub<0.26",
          "numpy<2",
        ],
        approxMb: 250,
      },
    ],
    sizeMb: (d) => (d === "cpu" ? 700 : 3300),
  },
  faceswap: {
    id: "faceswap",
    title: "Deep-Live-Cam",
    license: "AGPL-3.0 (код), insightface — только некоммерческое исследование",
    python: "3.11.9",
    repo: true,
    zipUrl: "https://github.com/hacksider/Deep-Live-Cam/archive/refs/heads/main.zip",
    modules: ["onnxruntime", "insightface", "cv2"],
    note: "Код Deep-Live-Cam — AGPL-3.0; модели insightface разрешены только для некоммерческих исследований. Ставится вместе с onnxruntime-gpu.",
    steps: (device) => [
      { id: "python", approxMb: 11 },
      { id: "getpip", approxMb: 3 },
      { id: "repo", approxMb: 5 },
      // insightface есть только исходниками, а его единственное C++-расширение (3D-сетка лица) для замены
      // лица не нужно и без компилятора в embeddable-Python не собирается: ставим чистой Python-частью
      { id: "buildtools", pip: ["numpy>=2,<3", "cython", "setuptools", "wheel"], approxMb: 40 },
      { id: "insightface", approxMb: 60 },
      {
        id: "deps",
        pip: ["-r", "requirements.txt"],
        approxMb: device === "cpu" ? 900 : 1600,
        inRepo: true,
      },
    ],
    sizeMb: (d) => (d === "cpu" ? 1000 : 1700),
  },
  chatterbox: {
    id: "chatterbox",
    title: "Chatterbox",
    license: "MIT",
    python: "3.11.9",
    repo: false,
    zipUrl: "",
    modules: ["torch", "chatterbox"],
    note: "Модель Resemble AI (MIT). Каждый файл получает невидимый водяной знак Perth. Свой Python: у пакета жёсткие версии torch и transformers.",
    steps: (device) => [
      { id: "python", approxMb: 11 },
      { id: "getpip", approxMb: 3 },
      // пакет закрепляет torch==2.6.0 (нет колёс под RTX 50) — ставим свежий torch отдельно, пакет без зависимостей
      {
        id: "torch",
        pip: [...TORCH_PKGS, "torchaudio", "--index-url", TORCH_INDEX[device]],
        approxMb: device === "cpu" ? 250 : 2800,
      },
      { id: "package", pip: ["chatterbox-tts", "--no-deps"], approxMb: 5 },
      {
        id: "deps",
        pip: [
          "numpy<2",
          "librosa==0.11.0",
          "s3tokenizer",
          "transformers==5.2.0",
          "diffusers==0.29.0",
          "resemble-perth",
          "conformer==0.3.2",
          "safetensors",
          "spacy-pkuseg",
          "pykakasi==2.3.0",
          "pyloudnorm",
          "omegaconf",
          "soundfile",
        ],
        approxMb: 500,
      },
    ],
    sizeMb: (d) => (d === "cpu" ? 1000 : 3500),
  },
};

export const toolDir = (id: ToolId): string => path.join(PHOTO_DIR, "py", id);
export const repoDir = (id: ToolId): string => path.join(toolDir(id), "repo");
const pyHome = (id: ToolId): string => path.join(toolDir(id), "python");
export function pythonExe(id: ToolId): string {
  return process.platform === "win32"
    ? path.join(pyHome(id), "python.exe")
    : path.join(pyHome(id), "bin", "python");
}

export function pyInstalled(id: ToolId): boolean {
  return fs.existsSync(pythonExe(id));
}

/* ------------------------- Состояние установки ------------------------- */

const setup = createSetupTask("photoPy");
const LOG_LIMIT = 200;
let logLines: string[] = [];
let child: ChildProcess | null = null;
let current: { id: ToolId; device: ToolDevice; steps: Step[]; step: string } | null = null;

function pushLog(line: string): void {
  const s = line.replace(/\s+$/, "");
  if (!s || /^[\s━█]+$/.test(s) || /^Progress:/.test(s)) return;
  logLines.push(s.length > 300 ? `${s.slice(0, 300)}…` : s);
  if (logLines.length > LOG_LIMIT) logLines = logLines.slice(-LOG_LIMIT);
}

export interface ToolSnapshot {
  state: SetupTaskState;
  tool: ToolId | "";
  device: ToolDevice | "";
  step: string;
  steps: string[];
  log: string[];
}

export function snapshot(): ToolSnapshot {
  return {
    state: setup.snapshot(),
    tool: current?.id || "",
    device: current?.device || "",
    step: current?.step || "",
    steps: current?.steps.map((s) => s.id) || [],
    log: logLines.slice(-40),
  };
}

function setProgress(index: number, fraction: number): void {
  const total = Math.max(1, current?.steps.length || 1);
  const v = Math.round((100 * (index + Math.min(1, Math.max(0, fraction)))) / total);
  setup.state.progress = Math.max(setup.state.progress, Math.min(99, v));
}

function stepFraction(line: string, prev: number): number {
  if (/^Successfully installed/i.test(line)) return 1;
  if (/^Installing collected packages/i.test(line)) return Math.max(prev, 0.75);
  if (/^\s*Downloading /i.test(line)) return Math.max(prev, 0.5);
  if (/^Collecting /i.test(line)) return Math.max(prev, 0.3);
  return prev;
}

/** Запуск процесса с лог-потоком; промис — код возврата. */
function runProc(
  exe: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    child = spawn(exe, args, { cwd, windowsHide: true, env: PY_ENV });
    let tail = "";
    const onData = (d: Buffer): void => {
      tail += String(d);
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() || "";
      lines.forEach(onLine);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      child = null;
      reject(new Error(`spawn_failed: ${(e as Error).message}`));
    });
    child.on("close", (code) => {
      if (tail) onLine(tail);
      child = null;
      resolve(code ?? 0);
    });
  });
}

function killChild(): void {
  const c = child;
  if (!c || c.exitCode != null) return;
  try {
    if (process.platform === "win32" && c.pid) {
      spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
    } else c.kill("SIGKILL");
  } catch {
    /* уже завершён */
  }
}

/* ------------------------- Шаги ------------------------- */

async function stepPython(def: ToolDef, index: number): Promise<void> {
  const home = pyHome(def.id);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  if (process.platform !== "win32") {
    const base = String(settings.get("voice")?.pythonCmd || "python3").trim() || "python3";
    pushLog(`> ${base} -m venv ${home}`);
    const code = await runProc(base, ["-m", "venv", home], toolDir(def.id), pushLog);
    if (code !== 0) throw new Error("venv_failed: нужен системный Python с модулем venv");
    return;
  }
  const major = def.python.split(".").slice(0, 2).join("");
  const url = `https://www.python.org/ftp/python/${def.python}/python-${def.python}-embed-amd64.zip`;
  const zip = path.join(config.DIRS.tmp, `python-${def.python}-embed-amd64.zip`);
  pushLog(`> скачиваем ${url}`);
  await downloadToFile(url, zip, {
    userAgent: "MoonApp",
    timeoutMs: 15 * 60 * 1000,
    maxBytes: 200 * 1024 * 1024,
    shouldCancel: () => setup.shouldCancel(),
    onProgress: (p) => setProgress(index, p.total ? p.received / p.total : 0),
  });
  new AdmZip(zip).extractAllTo(home, true);
  // embeddable закрывает site-packages файлом ._pth: открываем и добавляем каталог исходников
  fs.writeFileSync(
    path.join(home, `python${major}._pth`),
    [`python${major}.zip`, ".", "Lib\\site-packages", "import site", ""].join("\r\n"),
    "utf8",
  );
}

async function stepGetPip(def: ToolDef, index: number): Promise<void> {
  const exe = pythonExe(def.id);
  if (process.platform !== "win32") {
    const code = await runProc(exe, ["-m", "ensurepip", "--upgrade"], toolDir(def.id), pushLog);
    if (code !== 0) throw new Error("ensurepip_failed");
    return;
  }
  const file = path.join(config.DIRS.tmp, "get-pip.py");
  await downloadToFile(GET_PIP, file, {
    userAgent: "MoonApp",
    timeoutMs: 5 * 60 * 1000,
    maxBytes: 20 * 1024 * 1024,
    shouldCancel: () => setup.shouldCancel(),
    onProgress: (p) => setProgress(index, p.total ? 0.5 * (p.received / p.total) : 0.2),
  });
  const code = await runProc(
    exe,
    [file, "--no-warn-script-location", "--disable-pip-version-check"],
    toolDir(def.id),
    pushLog,
  );
  if (code !== 0) throw new Error("getpip_failed");
}

async function stepRepo(def: ToolDef, index: number): Promise<void> {
  const zip = path.join(config.DIRS.tmp, `photo-${def.id}.zip`);
  pushLog(`> скачиваем ${def.zipUrl}`);
  await downloadToFile(def.zipUrl, zip, {
    userAgent: "MoonApp",
    timeoutMs: 10 * 60 * 1000,
    maxBytes: 500 * 1024 * 1024,
    shouldCancel: () => setup.shouldCancel(),
    onProgress: (p) => setProgress(index, p.total ? p.received / p.total : 0),
  });
  const tmp = path.join(toolDir(def.id), "unz");
  fs.rmSync(tmp, { recursive: true, force: true });
  new AdmZip(zip).extractAllTo(tmp, true);
  const inner = fs.readdirSync(tmp).find((n) => fs.statSync(path.join(tmp, n)).isDirectory());
  if (!inner) throw new Error("repo_empty");
  fs.rmSync(repoDir(def.id), { recursive: true, force: true });
  fs.renameSync(path.join(tmp, inner), repoDir(def.id));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  // embeddable не добавляет каталог скрипта в sys.path (его заменяет ._pth) — вписываем репозиторий сами
  if (process.platform === "win32") {
    const pth = fs.readdirSync(pyHome(def.id)).find((n) => n.endsWith("._pth"));
    if (pth) {
      const file = path.join(pyHome(def.id), pth);
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      if (!lines.includes(repoDir(def.id)))
        lines.splice(lines.indexOf("import site"), 0, repoDir(def.id));
      fs.writeFileSync(file, lines.join("\r\n") + "\r\n", "utf8");
    }
  }
}

async function stepPip(def: ToolDef, step: Step, index: number): Promise<void> {
  const exe = pythonExe(def.id);
  const args = [
    "-m",
    "pip",
    "install",
    "--upgrade",
    "--disable-pip-version-check",
    "--no-input",
    "--progress-bar",
    "off",
    "--no-warn-script-location",
    ...(step.pip || []),
  ];
  pushLog(`> python ${args.slice(2).join(" ")}`);
  let fr = 0;
  const code = await runProc(exe, args, step.inRepo ? repoDir(def.id) : toolDir(def.id), (line) => {
    pushLog(line);
    fr = stepFraction(line, fr);
    setProgress(index, fr);
  });
  if (code !== 0) throw new Error(`pip_failed: ${step.id}`);
}

const PATCH_INSIGHTFACE = [
  "import sys, tarfile, glob, os",
  "d = sys.argv[1]",
  'archive = glob.glob(os.path.join(d, "*.tar.gz"))[0]',
  "tarfile.open(archive).extractall(d)",
  'src = [x for x in glob.glob(os.path.join(d, "insightface-*")) if os.path.isdir(x)][0]',
  'p = os.path.join(src, "setup.py")',
  's = open(p, encoding="utf8").read()',
  's = s.replace("ext_modules=cythonize(extensions)", "ext_modules=[]")',
  'open(p, "w", encoding="utf8").write(s)',
  'for f in glob.glob(os.path.join(src, "insightface", "thirdparty", "face3d", "mesh", "*.py")):',
  '    t = open(f, encoding="utf8").read()',
  '    t2 = t.replace("\\nfrom .cython import mesh_core_cython", "\\ntry:\\n    from .cython import mesh_core_cython\\nexcept ImportError:\\n    mesh_core_cython = None")',
  "    if t2 != t:",
  '        open(f, "w", encoding="utf8").write(t2)',
  "print(src)",
].join("\n");

/** insightface 0.7.3: скачать исходники, убрать C++-расширение, поставить чистым Python вместе с зависимостями. */
async function stepInsightface(def: ToolDef, index: number): Promise<void> {
  const exe = pythonExe(def.id);
  const dir = path.join(toolDir(def.id), "insightface-src");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let fr = 0;
  const pipLine = (line: string): void => {
    pushLog(line);
    fr = stepFraction(line, fr);
    setProgress(index, fr * 0.8);
  };
  const dl = await runProc(
    exe,
    [
      "-m",
      "pip",
      "download",
      "insightface==0.7.3",
      "--no-deps",
      "--no-binary",
      ":all:",
      "--no-build-isolation",
      "-d",
      dir,
      "--disable-pip-version-check",
    ],
    toolDir(def.id),
    pipLine,
  );
  if (dl !== 0) throw new Error("pip_failed: insightface download");
  const script = path.join(dir, "patch.py");
  fs.writeFileSync(script, PATCH_INSIGHTFACE, "utf8");
  let src = "";
  const pc = await runProc(exe, [script, dir], dir, (l) => {
    if (l.trim() && !l.startsWith("Warning")) src = l.trim();
  });
  if (pc !== 0 || !src) throw new Error("insightface_patch_failed");
  const code = await runProc(
    exe,
    [
      "-m",
      "pip",
      "install",
      src,
      "--no-build-isolation",
      "--disable-pip-version-check",
      "--no-input",
      "--progress-bar",
      "off",
      "--no-warn-script-location",
    ],
    toolDir(def.id),
    pipLine,
  );
  if (code !== 0) throw new Error("pip_failed: insightface");
  fs.rmSync(dir, { recursive: true, force: true });
}

export function install(id: ToolId, device: ToolDevice): ToolSnapshot {
  const def = TOOLS[id];
  if (!def) throw new Error("unknown_tool");
  if (setup.isWorking()) throw new Error("busy");
  const steps = def.steps(device);
  current = { id, device, steps, step: steps[0].id };
  logLines = [];
  setup.reset("photopy", id);
  setup.state.phase = steps[0].id;
  logger.action("photo.py.install.start", { id, device });
  void (async () => {
    try {
      fs.mkdirSync(toolDir(id), { recursive: true });
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        if (setup.shouldCancel()) throw new Error("cancelled");
        current.step = st.id;
        setup.state.phase = st.id;
        if (st.id === "python") await stepPython(def, i);
        else if (st.id === "getpip") await stepGetPip(def, i);
        else if (st.id === "repo") await stepRepo(def, i);
        else if (st.id === "insightface") await stepInsightface(def, i);
        else await stepPip(def, st, i);
        if (setup.shouldCancel()) throw new Error("cancelled");
        setProgress(i, 1);
      }
      setup.done();
      logger.action("photo.py.install.done", { id });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      pushLog(`! ${msg}`);
      setup.fail(/cancel/i.test(msg) ? new Error("cancelled") : e);
    }
  })();
  return snapshot();
}

export function cancel(): ToolSnapshot {
  setup.cancel();
  killChild();
  return snapshot();
}

export function remove(id: ToolId): void {
  if (setup.isWorking()) throw new Error("busy");
  fs.rmSync(toolDir(id), { recursive: true, force: true });
}

/** Проверка окружения: python отвечает и нужные модули находятся (без их загрузки). */
export async function check(id: ToolId): Promise<{ ready: boolean; missing: string[] }> {
  const def = TOOLS[id];
  if (!pyInstalled(id) || (def.repo && !fs.existsSync(repoDir(id))))
    return { ready: false, missing: ["python"] };
  const code =
    "import importlib.util as u,json;print(json.dumps({m:(u.find_spec(m) is not None) for m in " +
    JSON.stringify(def.modules) +
    "}))";
  let out = "";
  try {
    await runProc(pythonExe(id), ["-c", code], toolDir(id), (l) => {
      if (l.trim().startsWith("{")) out = l.trim();
    });
    const found = JSON.parse(out) as Record<string, boolean>;
    const missing = def.modules.filter((m) => !found[m]);
    return { ready: missing.length === 0, missing };
  } catch {
    return { ready: false, missing: def.modules };
  }
}

/** Описание инструмента для интерфейса: размеры, лицензия, готовность окружения. */
export async function describe(id: ToolId): Promise<{
  id: ToolId;
  title: string;
  license: string;
  note: string;
  python: string;
  sizeMb: { cuda: number; cpu: number };
  ready: boolean;
  missing: string[];
  installed: boolean;
}> {
  const def = TOOLS[id];
  const st = await check(id);
  return {
    id,
    title: def.title,
    license: def.license,
    note: def.note,
    python: def.python,
    sizeMb: { cuda: def.sizeMb("cuda"), cpu: def.sizeMb("cpu") },
    ready: st.ready,
    missing: st.missing,
    installed: pyInstalled(id),
  };
}

/* ------------------------- Запуск скриптов ------------------------- */

export interface RunHandle {
  proc: ChildProcess;
  done: Promise<number>;
}

/** Запустить скрипт инструмента: строки вывода → onLine, отмена — kill(). */
export function run(
  id: ToolId,
  args: string[],
  onLine: (line: string) => void,
  extraEnv: Record<string, string> = {},
): RunHandle {
  const proc = spawn(pythonExe(id), args, {
    cwd: repoDir(id),
    windowsHide: true,
    env: { ...PY_ENV, ...extraEnv },
  });
  let tail = "";
  const onData = (d: Buffer): void => {
    // tqdm и pip рисуют прогресс возвратом каретки — режем и по \r
    tail += String(d);
    const lines = tail.split(/\r\n|\r|\n/);
    tail = lines.pop() || "";
    lines.forEach(onLine);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  const done = new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (tail) onLine(tail);
      resolve(code ?? 0);
    });
  });
  return { proc, done };
}

export function killTree(proc: ChildProcess): void {
  if (proc.exitCode != null) return;
  try {
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else proc.kill("SIGKILL");
  } catch {
    /* уже завершён */
  }
}
