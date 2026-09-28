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
 * соответствующий кружок просто не показывается, а не выдумывается.
 *
 * Цвет = severity по порогу (тот же язык, что у Badge tone teal/amber/coral
 * по всему приложению): норма/предупреждение/критично — так критичное видно
 * с одного взгляда, не читая цифры. Показывается и в узком окне (в отличие
 * от предыдущей версии) — именно там, где под рукой меньше всего места,
 * полезнее всего увидеть проблему сразу, а не листать до «Мониторинга».
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

function Chip({
  icon: Icon,
  value,
  severity,
  title,
}: {
  icon: React.ElementType;
  value: string;
  severity: Severity;
  title: string;
}) {
  return (
    <span className={`sys-chip sev-${severity}`} title={title}>
      <Icon size={11} />
      {value}
    </span>
  );
}

export default function SystemStatsBar() {
  const { t } = useI18n();
  const [cpuTemp, setCpuTemp] = useState<number | null>(null);
  const [gpuTemp, setGpuTemp] = useState<number | null>(null);
  const [ramUsedPct, setRamUsedPct] = useState<number | null>(null);
  const [ramLabel, setRamLabel] = useState("");
  const [vramUsedPct, setVramUsedPct] = useState<number | null>(null);
  const [vramLabel, setVramLabel] = useState("");

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
            setRamUsedPct(Math.round((mem.usedMb / mem.totalMb) * 100));
            setRamLabel(`${Math.round(mem.usedMb / 1024)}/${Math.round(mem.totalMb / 1024)}`);
          } else {
            setRamUsedPct(null);
          }

          const gpu = s.gpu?.[0];
          if (gpu?.memoryUsedMb != null && gpu.memoryTotalMb) {
            setVramUsedPct(Math.round((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100));
            setVramLabel(
              `${Math.round(gpu.memoryUsedMb / 1024)}/${Math.round(gpu.memoryTotalMb / 1024)}`,
            );
          } else {
            setVramUsedPct(null);
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

  if (cpuTemp == null && gpuTemp == null && ramUsedPct == null && vramUsedPct == null) return null;

  return (
    <div className="sys-stats">
      {cpuTemp != null && (
        <Chip
          icon={Thermometer}
          value={`${Math.round(cpuTemp)}°`}
          severity={tempSeverity(cpuTemp)}
          title={`${t("monitor.cpuTemp")}: ${Math.round(cpuTemp)}°C`}
        />
      )}
      {gpuTemp != null && (
        <Chip
          icon={Thermometer}
          value={`${Math.round(gpuTemp)}°`}
          severity={tempSeverity(gpuTemp)}
          title={`${t("monitor.gpuTemp")}: ${Math.round(gpuTemp)}°C`}
        />
      )}
      {ramUsedPct != null && (
        <Chip
          icon={MemoryStick}
          value={ramLabel}
          severity={pctSeverity(ramUsedPct)}
          title={`${t("monitor.ram")}: ${ramLabel} ГБ (${ramUsedPct}%)`}
        />
      )}
      {vramUsedPct != null && (
        <Chip
          icon={MemoryStick}
          value={vramLabel}
          severity={pctSeverity(vramUsedPct)}
          title={`${t("monitor.vram")}: ${vramLabel} ГБ (${vramUsedPct}%)`}
        />
      )}
    </div>
  );
}
