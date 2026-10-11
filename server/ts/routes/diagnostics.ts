/**
 * Диагностика ПК: «Расследование тормозов» и «Паспорт ПК».
 *
 *  POST /api/diagnostics/slowdown          — { seconds? } → { id } (запуск замера)
 *  GET  /api/diagnostics/slowdown/:id      — { running, elapsed, samples, verdict? }
 *  GET  /api/diagnostics/passport          — { data, changes, markdown } (обновляет снимок)
 *  GET  /api/diagnostics/passport.md       — ?anonymize=1 → Markdown-файл
 */
import express from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import config from "../config";
import * as monitor from "../monitor";
import * as tuning from "../tuningEngine";
import * as problems from "../problemLog";
import * as sd from "../slowdown";
import * as pp from "../pcPassport";

const router = express.Router();

// ---------------- расследование тормозов ----------------

interface Job {
  running: boolean;
  startedAt: number;
  seconds: number;
  samples: sd.Sample[];
  verdict: sd.Verdict | null;
  error: string;
  child: ChildProcessWithoutNullStreams | null;
}
const jobs = new Map<string, Job>();
let activeId: string | null = null;

function startJob(seconds: number): string {
  const id = crypto.randomBytes(5).toString("hex");
  const job: Job = { running: true, startedAt: Date.now(), seconds, samples: [], verdict: null, error: "", child: null };
  jobs.set(id, job);
  activeId = id;
  // на Windows PowerShell читает скрипт из файла с BOM — иначе кириллица/кавычки портятся
  const file = path.join(config.DIRS.tmp, `slowdown_${id}.ps1`);
  fs.writeFileSync(file, "﻿" + sd.SAMPLER_PS(seconds, 2), "utf8");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    { windowsHide: true },
  );
  job.child = child;
  const finish = (err?: string) => {
    if (!job.running) return;
    job.running = false;
    job.child = null;
    if (err) job.error = err;
    const totalMem = Math.round(os.totalmem() / 1048576);
    job.verdict = sd.analyze(job.samples, { totalMemMb: totalMem });
    fs.rm(file, { force: true }, () => undefined);
    if (activeId === id) activeId = null;
  };
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const s = sd.parseSample(line.trim());
    if (s) job.samples.push(s);
  });
  child.on("error", (e) => finish(e.message));
  child.on("close", () => finish());
  setTimeout(() => {
    if (job.running) child.kill();
  }, (seconds + 20) * 1000).unref();
  return id;
}

router.post("/slowdown", (req, res) => {
  if (process.platform !== "win32") return res.status(501).json({ error: "windows_only" });
  if (activeId && jobs.get(activeId)?.running) return res.json({ id: activeId });
  const seconds = Math.min(Math.max(Number(req.body?.seconds) || 30, 10), 120);
  res.json({ id: startJob(seconds) });
});

router.get("/slowdown/:id", (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json({
    running: job.running,
    elapsed: Math.round((Date.now() - job.startedAt) / 1000),
    seconds: job.seconds,
    samples: job.samples.length,
    error: job.error,
    verdict: job.verdict,
  });
});

// ---------------- паспорт ПК ----------------

async function collectDrivers(): Promise<pp.PassportDriver[]> {
  if (process.platform !== "win32") return [];
  const rows = await tuning.psJson<
    { DeviceClass?: string; DeviceName?: string; Manufacturer?: string; DriverVersion?: string; Date?: string }[]
  >(
    `Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -and $_.DriverVersion } |
     Select-Object DeviceClass, DeviceName, Manufacturer, DriverVersion, @{n='Date';e={ if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { '' } }} |
     ConvertTo-Json -Compress`,
    45_000,
  );
  const list = Array.isArray(rows) ? rows : rows ? [rows as never] : [];
  const seen = new Set<string>();
  const out: pp.PassportDriver[] = [];
  for (const r of list as { DeviceClass?: string; DeviceName?: string; Manufacturer?: string; DriverVersion?: string; Date?: string }[]) {
    const d: pp.PassportDriver = {
      cls: String(r.DeviceClass ?? ""),
      name: String(r.DeviceName ?? ""),
      vendor: String(r.Manufacturer ?? ""),
      version: String(r.DriverVersion ?? ""),
      date: String(r.Date ?? ""),
    };
    const k = `${d.cls}|${d.name}`;
    if (!d.name || seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out.sort((a, b) => a.cls.localeCompare(b.cls) || a.name.localeCompare(b.name)).slice(0, 300);
}

async function collectPassport(): Promise<pp.PassportData> {
  const snap = await monitor.getSnapshot();
  const st = tuning.readState();
  return {
    generatedAt: Date.now(),
    system: {
      hostname: snap.system.hostname,
      osName: snap.system.osName,
      osVersion: snap.system.osVersion,
      osBuild: snap.system.osBuild,
      arch: snap.system.arch,
      uptimeSec: snap.system.uptimeSec,
    },
    cpu: { model: snap.cpu.model, coresPhysical: snap.cpu.coresPhysical, coresLogical: snap.cpu.coresLogical },
    memoryMb: snap.memory.totalMb,
    gpus: snap.gpu.map((g) => ({ name: g.name, memoryMb: g.memoryTotalMb })),
    disks: snap.disks.map((d) => ({
      name: `${d.drive}${d.label ? ` ${d.label}` : ""}`.trim(),
      totalGb: d.totalGb,
      fs: "",
    })),
    drivers: await collectDrivers(),
    tuning: {
      applied: Object.entries(st.applied).map(([id, v]) => ({ id, at: v.at })),
      history: st.history.slice(0, 50).map((h) => ({ at: h.at, kind: h.kind, ok: h.ok, detail: h.detail })),
    },
    problems: problems
      .listProblems()
      .map((p) => ({ source: p.source, message: p.message, count: p.count, firstAt: p.firstAt, lastAt: p.lastAt, level: p.level })),
  };
}

router.get("/passport", async (_req, res) => {
  try {
    const data = await collectPassport();
    const { store } = pp.update(pp.load(), data);
    pp.save(store);
    res.json({
      data,
      changes: store.changes.slice(-50).reverse(),
      stale: pp.staleDrivers(data.drivers, data.generatedAt).slice(0, 10),
      markdown: pp.toMarkdown(data, { changes: store.changes }),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/passport.md", async (req, res) => {
  try {
    const store = pp.load();
    const data = store.last ?? (await collectPassport());
    const md = pp.toMarkdown(data, { changes: store.changes, anonymize: req.query.anonymize === "1" });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="pc-passport.md"');
    res.send(md);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
