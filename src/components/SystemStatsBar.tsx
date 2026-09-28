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
 */
export default function SystemStatsBar() {
  const { t } = useI18n();
  const [cpuTemp, setCpuTemp] = useState<number | null>(null);
  const [gpuTemp, setGpuTemp] = useState<number | null>(null);
  const [ramUsed, setRamUsed] = useState<number | null>(null);
  const [ramTotal, setRamTotal] = useState<number | null>(null);
  const [vramUsed, setVramUsed] = useState<number | null>(null);
  const [vramTotal, setVramTotal] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      api
        .getMonitor()
        .then((s) => {
          if (!alive) return;
          setCpuTemp(s.cpu?.temperatureC ?? null);
          setRamUsed(s.memory ? Math.round(s.memory.usedMb / 1024) : null);
          setRamTotal(s.memory ? Math.round(s.memory.totalMb / 1024) : null);
          const gpu = s.gpu?.[0] || null;
          setGpuTemp(gpu?.temperatureC ?? null);
          setVramUsed(gpu?.memoryUsedMb != null ? Math.round(gpu.memoryUsedMb / 1024) : null);
          setVramTotal(gpu?.memoryTotalMb != null ? Math.round(gpu.memoryTotalMb / 1024) : null);
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
  const hasMem = ramTotal != null || vramTotal != null;
  if (!hasTemps && !hasMem) return null;

  return (
    <div className="sys-stats" title={t("monitor.title")}>
      {hasTemps && (
        <span className="sys-stats-group">
          <Thermometer size={13} />
          {cpuTemp != null && <span>CPU {Math.round(cpuTemp)}°</span>}
          {gpuTemp != null && <span>GPU {Math.round(gpuTemp)}°</span>}
        </span>
      )}
      {hasMem && (
        <span className="sys-stats-group">
          <MemoryStick size={13} />
          {ramTotal != null && (
            <span>
              {t("monitor.ram")} {ramUsed}/{ramTotal}
            </span>
          )}
          {vramTotal != null && (
            <span>
              VRAM {vramUsed}/{vramTotal}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
