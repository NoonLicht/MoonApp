/**
 * Резервный захват системного звука на Linux через PulseAudio/PipeWire,
 * на случай если portal-путь Chromium (getDisplayMedia audio:true — см.
 * electron/main.js:systemAudioRequestValue) не даёт звука на конкретной
 * машине (композитор без поддержки share-audio, чистый PulseAudio без
 * WirePlumber-портала и т.п.).
 *
 * Пишет отдельный аудиофайл параллельно видеозахвату экрана; страница
 * записи затем муксирует его с видео через тот же ffmpeg, который уже
 * используется для остального в проекте (см. finalizeRecording в
 * server/screenshots.js) — этот модуль сам muxing не делает, только пишет
 * дорожку и возвращает путь к готовому файлу.
 */
import { spawn, execFile, ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ""));
    });
  });
}

function hasBinary(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: 2000 }, (err) => resolve(!err));
  });
}

async function findMonitorSource(): Promise<string | null> {
  try {
    const defaultSink = (await run("pactl", ["get-default-sink"])).trim();
    if (defaultSink) return `${defaultSink}.monitor`;
  } catch {
    /* pactl недоступен или PulseAudio/pipewire-pulse не запущен */
  }
  try {
    const list = await run("pactl", ["list", "sources", "short"]);
    const line = list.split("\n").find((l) => /\.monitor\b/.test(l));
    if (line) return line.split(/\s+/)[1] || null;
  } catch {
    /* ignore */
  }
  return null;
}

let activeChild: ChildProcessWithoutNullStreams | null = null;
let activeOutPath: string | null = null;

/**
 * Стартует захват системного звука в WAV-файл. Возвращает null, если ни один
 * из механизмов (parec/pw-record) недоступен в системе — вызывающий код
 * должен продолжить запись видео вообще без звука, а не падать.
 */
export async function startSystemAudioCapture(): Promise<{ ok: boolean; error?: string }> {
  if (activeChild) return { ok: true };
  const monitor = await findMonitorSource();
  if (!monitor) {
    return {
      ok: false,
      error:
        "no_monitor_source: PulseAudio/PipeWire monitor-источник не найден (pactl недоступен?)",
    };
  }
  const hasParec = await hasBinary("parec");
  const outPath = path.join(os.tmpdir(), `moonapp-sysaudio-${Date.now()}.wav`);
  try {
    if (hasParec) {
      activeChild = spawn("parec", [
        "-d",
        monitor,
        "--file-format=wav",
        outPath,
      ]) as ChildProcessWithoutNullStreams;
    } else if (await hasBinary("pw-record")) {
      activeChild = spawn("pw-record", [
        "--target",
        monitor,
        outPath,
      ]) as ChildProcessWithoutNullStreams;
    } else {
      return { ok: false, error: "no_capture_tool: не найдены ни parec, ни pw-record в PATH" };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  activeOutPath = outPath;
  activeChild.on("error", () => {
    activeChild = null;
  });
  return { ok: true };
}

/** Останавливает захват и возвращает путь к записанному WAV (или null, если ничего не писалось). */
export function stopSystemAudioCapture(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!activeChild) return resolve(null);
    const child = activeChild;
    const outPath = activeOutPath;
    activeChild = null;
    activeOutPath = null;
    child.once("close", () => {
      if (outPath && fs.existsSync(outPath) && fs.statSync(outPath).size > 44) resolve(outPath);
      else resolve(null);
    });
    child.kill("SIGTERM");
  });
}
