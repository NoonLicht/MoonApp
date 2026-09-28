import { useEffect, useState } from "react";
import { Thermometer, MemoryStick } from "lucide-react";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";

/**
 * Компактная сводка железа в тулбаре (справа от кнопки диспетчера задач,
 * см. App.tsx → .tb-side-left): температура CPU/GPU, занятая ОЗУ и видеопамять.
 * Живёт глобально (не привязана к странице «Мониторинг») — опрашивает
 * тот же снимок (api.getMonitor(), server/ts/monitor.ts), что и сама
 * страница, просто реже (страница активна не всегда, а эта плашка — да).
 * Значений может не быть (нет датчиков/LHM не запущен/нет GPU) — тогда
 * соответствующее число просто не показывается, а не выдумывается.
 *
 * Максимально компактно: без пилюль/фона — только иконка + цветные цифры
 * (та же severity-палитра teal/amber/coral, что у Badge по всему приложению),
 * CPU/GPU и RAM/VRAM объединены в одну группу через "/", общий объём памяти
 * не показывается (только занято, тултип — детали).
 */

type Severity = "ok" | "warn" | "crit";

function tempSeverity(c: number): Severity {
  if (c >= 85) return "crit";
  if (c >= 70) return "warn";
  return "ok";
}

function pctSeverity(usedPct: number): Severity {
  if (usedPct >= 90) return "crit";
  if (usedPct >= 75) return "warn";
  return "ok";
}

function Val({ text, severity }: { text: string; severity: Severity }) {
  return <span className={`sys-val sev-${severity}`}>{text}</span>;
}

export default function SystemStatsBar() {
  const { t } = useI18n();
  const [cpuTemp, setCpuTemp] = useState<number | null>(null);
  const [gpuTemp, setGpuTemp] = useState<number | null>(null);
  const [ramUsedGb, setRamUsedGb] = useState<number | null>(null);
  const [ramTotalGb, setRamTotalGb] = useState<number | null>(null);
  const [ramPct, setRamPct] = useState<number | null>(null);
  const [vramUsedGb, setVramUsedGb] = useState<number | null>(null);
  const [vramTotalGb, setVramTotalGb] = useState<number | null>(null);
  const [vramPct, setVramPct] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      api
        .getMonitor()
        .then((s) => {
          if (!alive) return;
          setCpuTemp(s.cpu?.temperatureC ?? null);
          setGpuTemp(s.gpu?.[0]?.temperatureC ?? null);

          const mem = s.memory;
          if (mem && mem.totalMb > 0) {
            setRamUsedGb(mem.usedMb / 1024);
            setRamTotalGb(mem.totalMb / 1024);
            setRamPct(Math.round((mem.usedMb / mem.totalMb) * 100));
          } else {
            setRamUsedGb(null);
          }

          const gpu = s.gpu?.[0];
          if (gpu?.memoryUsedMb != null && gpu.memoryTotalMb) {
            setVramUsedGb(gpu.memoryUsedMb / 1024);
            setVramTotalGb(gpu.memoryTotalMb / 1024);
            setVramPct(Math.round((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100));
          } else {
            setVramUsedGb(null);
          }
        })
        .catch(() => {
          /* датчики недоступны — молча оставляем прочерк, не роняем тулбар */
        });
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const hasTemps = cpuTemp != null || gpuTemp != null;
  const hasMem = ramUsedGb != null || vramUsedGb != null;
  if (!hasTemps && !hasMem) return null;

  return (
    <div className="sys-stats">
      {hasTemps && (
        <span
          className="sys-group"
          title={[
            cpuTemp != null ? `${t("monitor.cpuTemp")}: ${Math.round(cpuTemp)}°C` : "",
            gpuTemp != null ? `${t("monitor.gpuTemp")}: ${Math.round(gpuTemp)}°C` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <Thermometer size={11} />
          {cpuTemp != null && <Val text={`${Math.round(cpuTemp)}°`} severity={tempSeverity(cpuTemp)} />}
          {cpuTemp != null && gpuTemp != null && <span className="sys-sep">/</span>}
          {gpuTemp != null && <Val text={`${Math.round(gpuTemp)}°`} severity={tempSeverity(gpuTemp)} />}
        </span>
      )}
      {hasMem && (
        <span
          className="sys-group"
          title={[
            ramUsedGb != null
              ? `${t("monitor.ram")}: ${ramUsedGb.toFixed(1)}/${ramTotalGb?.toFixed(1)} ГБ (${ramPct}%)`
              : "",
            vramUsedGb != null
              ? `${t("monitor.vram")}: ${vramUsedGb.toFixed(1)}/${vramTotalGb?.toFixed(1)} ГБ (${vramPct}%)`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <MemoryStick size={11} />
          {ramUsedGb != null && (
            <Val text={ramUsedGb.toFixed(1)} severity={pctSeverity(ramPct || 0)} />
          )}
          {ramUsedGb != null && vramUsedGb != null && <span className="sys-sep">/</span>}
          {vramUsedGb != null && (
            <Val text={vramUsedGb.toFixed(1)} severity={pctSeverity(vramPct || 0)} />
          )}
        </span>
      )}
    </div>
  );
}
